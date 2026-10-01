// Ingest: BZP — Poland's Biuletyn Zamówień Publicznych, on the e-Zamówienia platform.
//
// BZP carries Poland's national (below EU threshold) notices; larger contracts go to TED, which this
// site already searches. The Public Procurement Office's API terms ("Regulamin korzystania z API",
// 2023) say the BZP notice service is free and needs no access request, and the integration page
// lists it as open:
//
//   GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=ContractNotice
//       &PublicationDateFrom=...&PublicationDateTo=...&PageSize=500&PageNumber=N
//
// VERIFIED from a GitHub runner (2026-10-01): keyless JSON; PageSize 500 works, 2000 is rejected;
// rows carry CPV codes, the offer deadline (submittingOffersDate) and the buyer. robots.txt has no
// rules. Paging over a long window is not stably ordered, so each window is split in half until it
// fits in one page.
//
// MEASURED (2026-10-01): every row includes the full notice as HTML (~28 KB), so 27,000 rows were
// ~750 MB and an 8-minute budget covered only part of the window. To stay light, runs are
// incremental: each run reads only what was published since the last run (plus a day of overlap),
// and a one-off backfill walks back towards BZP_LOOKBACK_DAYS across the first few runs. Rows drop
// out when their offer deadline passes.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "BZP";
export const label = "BZP (Poland)";

const API = process.env.BZP_API || "https://ezamowienia.gov.pl/mo-board/api/v1/notice";
const PAGE = Number(process.env.BZP_PAGE_SIZE || 250);
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")) || [])[1] || "";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19);

export function toNoticeRow(n) {
  const cpv = [...new Set([...String(n.cpvCode || "").matchAll(/(\d{8})-\d/g)].map((m) => m[1]))].slice(0, 6);
  const buyer = clean(n.organizationName);
  return toRow({
    id: n.bzpNumber ? `PL-${n.bzpNumber.replace(/\s+/g, "")}` : "",
    title: clean(n.orderObject),
    buyer: n.organizationCity ? `${buyer} (${clean(n.organizationCity)})` : buyer,
    country: "POL",
    deadline: isoDate(n.submittingOffersDate),
    published: isoDate(n.publicationDate),
    codes: cpv.map((c) => `CPV ${c}`).join(" · "),
    link: n.objectId
      ? `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${n.objectId}`
      : "https://ezamowienia.gov.pl/mo-client-board/bzp/list",
  });
}

export async function ingest({ fetchImpl = fetchText, log = console.log, previousRows = [], previousState = {} } = {}) {
  const lookbackDays = Number(process.env.BZP_LOOKBACK_DAYS || 35);
  const delayMs = Number(process.env.BZP_DELAY_MS ?? 1000);
  const budgetMs = Number(process.env.BZP_BUDGET_MS || 8 * 60 * 1000);
  const startedAt = Date.now();
  const now = startedAt;
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map(previousRows.map((r) => [r[0], r]));
  let requests = 0, read = 0, failed = 0, retried = 0, outOfTime = false;
  const notes = [];

  // MEASURED (2026-10-01): the API answers some requests with an error even at one request a
  // second (2 of 3 failed when a second run started straight after a first). So a failure waits
  // (Retry-After, else 15 s, then 45 s) and retries before the window is given up for this run.
  async function fetchWindow(from, to) {
    const url = `${API}?NoticeType=ContractNotice&PublicationDateFrom=${stamp(from)}&PublicationDateTo=${stamp(to)}&PageSize=${PAGE}&PageNumber=1`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (requests > 0) await sleep(attempt ? Math.min(120, lastError.retryAfter || 15 * 3 ** (attempt - 1)) * 1000 : delayMs);
      requests++;
      try {
        const res = await fetchImpl(url, { headers: { accept: "application/json" }, retries: 0, timeoutMs: 90000 });
        if (res.ok) {
          const list = JSON.parse(res.text || "[]");
          return Array.isArray(list) ? list : [];
        }
        lastError = Object.assign(new Error(`HTTP ${res.status}`), { retryAfter: res.retryAfter });
      } catch (err) { lastError = err; }
      retried++;
      log(`BZP: ${lastError.message.split(" reading ")[0]} for ${stamp(from)}..${stamp(to)} (attempt ${attempt + 1})`);
    }
    throw lastError;
  }

  // Reads [from, to), splitting it in half while a window fills a page, so no row depends on
  // unstable paging. Returns false if the time budget ran out or a request failed (the window
  // then counts as not done, and is retried next run).
  async function collect(from, to) {
    if (Date.now() - startedAt > budgetMs) { outOfTime = true; return false; }
    let list;
    try { list = await fetchWindow(from, to - 1000); }
    catch (err) {
      failed++;
      if (read === 0 && failed >= 2) throw new Error(`BZP: no window could be read (${err.message})`);
      return false;
    }
    if (list.length >= PAGE && to - from > 10 * 60 * 1000) {
      const mid = from + Math.floor((to - from) / 2);
      return (await collect(from, mid)) && collect(mid, to);
    }
    for (const n of list) {
      read++;
      const row = toNoticeRow(n);
      if (!row[0] || !row[1] || !row[4] || row[4] < today) continue;
      byId.set(row[0], row);
    }
    return true;
  }

  // Day-sized windows walking back from `to` to `stop`; returns the oldest point fully read.
  async function walkBack(to, stop) {
    while (to > stop) {
      const from = Math.max(stop, to - 864e5);
      if (!(await collect(from, to))) break;
      to = from;
    }
    return to;
  }

  const limit = now - lookbackDays * 864e5;
  // 1. New since the last run (with a day of overlap for late-indexed notices).
  const lastNewest = Date.parse(previousState.newest || "") || 0;
  const headStop = lastNewest ? Math.max(limit, lastNewest - 864e5) : limit;
  const headReached = await walkBack(now, headStop);
  // The head is always read from now backwards, so `newest` can move to now. If it did not reach
  // the last run's point (or this is the first run), the unread part is left to the backfill
  // cursor, which then restarts from where the head stopped (re-reading some days, never skipping).
  let oldest = Date.parse(previousState.oldest || "") || now;
  if (!lastNewest || headReached > headStop) oldest = headReached;
  // 2. Backfill towards the lookback limit, within what is left of the budget.
  if (oldest > limit && !outOfTime) oldest = await walkBack(oldest, limit);
  if (outOfTime) notes.push("time budget reached; continues next run");

  let expired = 0;
  for (const [id, row] of byId) if (row[4] < today) { byId.delete(id); expired++; }

  const rows = [...byId.values()];
  const backfillDone = oldest <= limit;
  log(`BZP: ${requests} request(s), ${failed} failed, ${read} contract notices read, ${expired} expired; index now ${rows.length}; backfill ${backfillDone ? "complete" : `back to ${new Date(oldest).toISOString().slice(0, 10)}`}`);
  notes.push(`requests ${requests}`, `retried ${retried}`, `windows failed ${failed}`, `read ${read}`, backfillDone ? "backfill complete" : "backfill continuing");
  return {
    rows,
    notes,
    state: {
      newest: new Date(now).toISOString(),
      oldest: new Date(oldest).toISOString(),
      updatedAt: new Date().toISOString(),
    },
  };
}
