// Ingest: Prozorro — Ukraine's public procurement system.
//
// By volume this is the largest procurement market covered by this tool. It is also the awkwardest
// to ingest, and the reason this file looks different from the two bulk ingesters:
//
// Prozorro's public API is a CHANGE FEED, not a search endpoint. `/tenders` returns a page of
// {id, dateModified} ordered by modification time, plus a `next_page.offset` cursor. There is no
// "give me open tenders about chairs" query. So we crawl forward from a saved cursor, keep what is
// still open, merge it into the existing index, and remember where we stopped. Each run does a
// bounded amount of work; the index converges over the first few days and stays current after that.
//
// The one optimisation that makes this affordable: `opt_fields` asks the listing endpoint to inline
// the fields we need, so a page of 100 tenders costs ONE request instead of 101. If the deployment
// ever stops honouring opt_fields we detect the missing titles and say so loudly rather than
// silently indexing 100 blank rows.

import { toRow } from "../lib/index-format.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "PROZORRO";
export const label = "Prozorro (Ukraine)";

const API = process.env.PROZORRO_API || "https://public.api.openprocurement.org/api/2.5/tenders";
// `items` carries each lot's ДК 021 classification, which IS CPV 2008. Titles are Ukrainian, so
// without these codes the index was unreachable to anyone searching in English.
const OPT_FIELDS = "status,title,title_en,tenderID,value,tenderPeriod,procuringEntity,items,date,dateCreated";

// Statuses that mean "you can still bid". Everything else (complete, cancelled, unsuccessful,
// awarded) is history, not opportunity.
const OPEN_STATUSES = new Set([
  "active.tendering",
  "active.enquiries",
  "active.auction",
]);

function isoDate(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** ДК 021:2015 codes ("42120000-6") are CPV codes with a check digit; keep the 8-digit code. */
function cpvCodes(t) {
  const out = [];
  const push = (c) => {
    if (!c?.id) return;
    const scheme = String(c.scheme || "").toUpperCase();
    if (scheme && !/ДК ?021|CPV/.test(scheme)) return;   // skip ДК 003/016 etc.
    const m = /^(\d{8})/.exec(String(c.id));
    if (m) out.push(m[1]);
  };
  push(t.classification);
  for (const item of t.items || []) {
    push(item.classification);
    for (const c of item.additionalClassifications || []) push(c);
  }
  return [...new Set(out)].slice(0, 6);
}

// tenderPeriod.startDate is when bidding OPENS, which for tenders still in their enquiry period is days
// in the future; using it as the publication date showed tenders "published" next week. Use the
// record's own date, never later than today.
function publishedDate(t, today) {
  const d = isoDate(t.date) || isoDate(t.dateCreated) || isoDate(t.tenderPeriod?.startDate) || isoDate(t.dateModified);
  return d && d > today ? today : d;
}

function toNoticeRow(t, today = new Date().toISOString().slice(0, 10)) {
  const deadline = isoDate(t.tenderPeriod?.endDate);
  const title = String(t.title_en || t.title || "").trim();
  const buyer = String(t.procuringEntity?.name_en || t.procuringEntity?.name || "").trim();
  const amount = t.value?.amount;
  const currency = t.value?.currency || "";
  // Prozorro tenderIDs already look like "UA-2026-01-01-000001", so prefixing blindly produced
  // "UA-UA-...". Only add the prefix when it is genuinely missing.
  const rawId = String(t.tenderID || t.id || "");
  const prefixed = rawId ? (/^UA-/i.test(rawId) ? rawId : `UA-${rawId}`) : "";
  return toRow({
    id: prefixed,
    title,
    buyer,
    country: "UKR",
    deadline,
    published: publishedDate(t, today),
    codes: [
      ...cpvCodes(t).map((c) => `CPV ${c}`),
      amount ? `${Math.round(amount)} ${currency}` : "",
    ].filter(Boolean).join(" · "),
    // Prozorro's public front end resolves tenders by their internal id.
    link: t.id ? `https://prozorro.gov.ua/tender/${encodeURIComponent(t.tenderID || t.id)}` : "https://prozorro.gov.ua",
  });
}

/**
 * @param previousRows rows from the last index (array-of-arrays)
 * @param previousState { offset } cursor saved by the last run
 */
export async function ingest({ fetchImpl = politeFetch, log = console.log, previousRows = [], previousState = {} } = {}) {
  const maxPages = Number(process.env.PROZORRO_MAX_PAGES || 40);
  const pageSize = Number(process.env.PROZORRO_PAGE_SIZE || 100);
  const budgetMs = Number(process.env.PROZORRO_BUDGET_MS || 8 * 60 * 1000);
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // CURSOR DIRECTION — this was a real bug worth understanding.
  //
  // A cold start uses `descending=1` so the index is useful immediately (newest tenders first)
  // rather than starting at Prozorro's first-ever record from 2016. But following `next_page` on a
  // DESCENDING feed walks BACKWARDS IN TIME. Saving that offset meant every later run crawled
  // further into the past and never saw a single new tender — an index that silently froze while
  // reporting success.
  //
  // The change feed's forward mode is the correct cursor for incremental updates: ascending order
  // by dateModified, resuming from the last processed point. So a cold start seeds with a
  // descending sweep and then parks an ASCENDING cursor at "now"; every subsequent run moves
  // forward and picks up new and changed tenders.
  const seeding = !previousState.ascOffset;
  let url = seeding
    ? `${API}?descending=1&limit=${pageSize}&opt_fields=${OPT_FIELDS}`
    : `${API}?offset=${encodeURIComponent(previousState.ascOffset)}&limit=${pageSize}&opt_fields=${OPT_FIELDS}`;
  log(seeding ? "Prozorro: cold start — seeding with a newest-first sweep" : `Prozorro: resuming forward from ${previousState.ascOffset}`);

  const byId = new Map();
  for (const row of previousRows) byId.set(row[0], row);   // row[0] is the id column

  let pages = 0, seen = 0, kept = 0, closedOrDone = 0, missingTitles = 0;
  // Internal ids of tenders the feed listed without a title, waiting for a detail fetch. Carried
  // between runs: the old code kept them only in memory, so whatever the per-run cap didn't reach
  // was never fetched, and those tenders stayed in the index as blank rows (89% of it on 2026-10-01).
  const pending = new Set(Array.isArray(previousState.pendingIds) ? previousState.pendingIds : []);
  let lastOffset = previousState.ascOffset || "";
  const notes = [];

  while (pages < maxPages && Date.now() - startedAt < budgetMs) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json" } });
    } catch (err) {
      notes.push(`network error after ${pages} page(s): ${err.name}`);
      break;
    }
    if (res.status === 429) { notes.push(`rate limited after ${pages} page(s); stopping politely`); break; }
    if (!res.ok) {
      if (pages === 0) throw new Error(`Prozorro returned HTTP ${res.status} on the first page. Check PROZORRO_API.`);
      notes.push(`HTTP ${res.status} after ${pages} page(s); keeping what we have`);
      break;
    }

    const body = await res.json();
    const items = body.data || [];
    if (!items.length) { notes.push(`reached the end of the feed after ${pages} page(s)`); break; }

    for (const t of items) {
      seen++;
      const status = String(t.status || "");
      const deadline = isoDate(t.tenderPeriod?.endDate);
      const open = OPEN_STATUSES.has(status) && (!deadline || deadline >= today);
      const row = toNoticeRow(t, today);
      if (status && !open) {
        // Closed, cancelled or awarded: remove it whether or not the feed sent a title.
        if (row[0]) byId.delete(row[0]);
        if (t.id) pending.delete(t.id);
        closedOrDone++;
        continue;
      }
      if (!t.title && !t.title_en) {
        // Open (or unknown) but untitled: never write a blank row, and never let one replace a row
        // that already has a title. Fetch the full record instead.
        missingTitles++;
        if (t.id) pending.add(t.id);
        continue;
      }
      if (!row[0]) continue;
      byId.set(row[0], row); kept++;
      if (t.id) pending.delete(t.id);
    }

    pages++;
    lastOffset = body.next_page?.offset ?? lastOffset;
    const nextUri = body.next_page?.uri;
    if (!nextUri && !body.next_page?.offset) { notes.push("no further pages"); break; }
    url = nextUri || `${API}?offset=${encodeURIComponent(body.next_page.offset)}&limit=${pageSize}&opt_fields=${OPT_FIELDS}`;
  }

  // VERIFIED LIVE (2026-08, and again 2026-10-01): the public feed honours opt_fields for only some
  // records and returns most as {id, dateModified}. Those go to `pending` and are fetched one by one
  // here, newest first, up to a per-run cap; the rest wait for the next run instead of being lost.
  const maxDetails = Number(process.env.PROZORRO_MAX_DETAILS || 600);
  const detailBudgetMs = Number(process.env.PROZORRO_DETAIL_BUDGET_MS || 6 * 60 * 1000);
  const detailStart = Date.now();
  let fetched = 0, detailKept = 0, detailFail = 0, detailClosed = 0;
  if (pending.size) {
    log(`Prozorro: ${missingTitles} untitled record(s) this run, ${pending.size} awaiting detail; fetching up to ${maxDetails}`);
    for (const pid of [...pending].reverse()) {
      if (fetched >= maxDetails || Date.now() - detailStart > detailBudgetMs) break;
      fetched++;
      try {
        const dres = await fetchImpl(`${API}/${encodeURIComponent(pid)}`, { headers: { accept: "application/json" } });
        if (dres.status === 404) { pending.delete(pid); continue; }   // withdrawn or never public
        if (dres.status === 429) { detailFail++; notes.push("rate limited during detail fetches; stopping politely"); break; }
        if (!dres.ok) { detailFail++; continue; }
        const t = (await dres.json())?.data;
        if (!t) { detailFail++; continue; }
        pending.delete(pid);
        const row = toNoticeRow(t, today);
        if (!row[0]) continue;
        const dl = isoDate(t.tenderPeriod?.endDate);
        if (OPEN_STATUSES.has(String(t.status || "")) && (!dl || dl >= today) && row[1]) { byId.set(row[0], row); detailKept++; }
        else { byId.delete(row[0]); detailClosed++; }
      } catch {
        detailFail++;
      }
    }
    log(`Prozorro: fetched ${fetched} detail(s) -> ${detailKept} open kept, ${detailClosed} closed, ${detailFail} failed; ${pending.size} still pending`);
    notes.push(`untitled in feed ${missingTitles}`, `details ${fetched}`, `detail-kept ${detailKept}`, `detail-failed ${detailFail}`, `pending ${pending.size}`);
    if (fetched > 0 && detailFail === fetched) {
      throw new Error(`Prozorro: every detail fetch failed (${detailFail}/${fetched}). Check PROZORRO_API.`);
    }
  }

  // Blank rows written by earlier versions can't be repaired (their internal ids weren't kept). They
  // are still real open tenders with working links, so they stay until their deadline passes or the
  // feed lists them again with a title; dropping them all at once would also trip the canary.
  let blank = 0;
  for (const row of byId.values()) if (!row[1]) blank++;
  if (blank) notes.push(`untitled rows left from earlier runs ${blank}`);

  // Drop anything whose deadline has passed since the last run, even if we did not revisit it.
  let expired = 0;
  for (const [id, row] of byId) {
    const dl = row[4];
    if (dl && dl < today) { byId.delete(id); expired++; continue; }
    if (row[5] > today) row[5] = today;   // rows from before publishedDate() carried bidding-start dates
  }

  const rows = [...byId.values()];
  log(`Prozorro: ${pages} page(s), ${seen} records -> ${kept} open kept, ${closedOrDone} closed/removed, ${expired} expired pruned; index now ${rows.length}`);
  notes.push(`pages ${pages}`, `records ${seen}`, `kept ${kept}`, `expired ${expired}`);

  // After a seeding (descending) run the collected offset points backwards, so it must NOT become
  // the incremental cursor. Park the forward cursor at the run start instead; from the next run on,
  // the offset returned by the ascending feed is the correct thing to carry.
  const ascOffset = seeding ? new Date(startedAt).toISOString() : (lastOffset || previousState.ascOffset);
  notes.push(seeding ? "seeded; forward cursor parked at run start" : "advanced forward cursor");

  return {
    rows,
    notes,
    // Cap the queue so a feed that stops sending titles altogether can't grow state without bound;
    // the oldest entries go first (they are the likeliest to have closed).
    state: { ascOffset, pendingIds: [...pending].slice(-Number(process.env.PROZORRO_MAX_PENDING || 5000)), seededAt: previousState.seededAt || new Date(startedAt).toISOString(), updatedAt: new Date().toISOString() },
  };
}
