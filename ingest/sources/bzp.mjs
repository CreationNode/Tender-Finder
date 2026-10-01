// Ingest: BZP — Poland's Biuletyn Zamówień Publicznych, on the e-Zamówienia platform.
//
// BZP carries Poland's national (below EU threshold) notices; larger contracts go to TED, which this
// site already searches. The Public Procurement Office's API terms ("Regulamin korzystania z API",
// 2023) say the BZP notice service is free and needs no access request, and the integration page
// lists it as open:
//
//   GET https://ezamowienia.gov.pl/mo-board/api/v1/notice?NoticeType=ContractNotice
//       &PublicationDateFrom=...&PublicationDateTo=...&PageSize=250
//
// VERIFIED from a GitHub runner (2026-10-01): keyless JSON; PageSize 500 works, 2000 is rejected;
// rows carry CPV codes, the offer deadline (submittingOffersDate) and the buyer. robots.txt has no
// rules.
//
// MEASURED (2026-10-01):
// - PageNumber is ignored (every page returns the same first rows), but rows come oldest first and
//   PublicationDateFrom honours the time of day. So a day is read like a cursor: ask again from the
//   last row's publication time until a page comes back short. A day has a few hundred notices.
// - Every row includes the full notice as HTML (~28 KB), so a day is ~10 MB. To stay light, runs are
//   incremental: each run re-reads today and yesterday, plus any day in the last BZP_LOOKBACK_DAYS
//   (default 35) not yet read, newest first, within BZP_BUDGET_MS. The first runs backfill.
// - The API answers some requests with HTTP 403 and accepts the same request after a pause, so
//   requests are spaced (BZP_DELAY_MS, default 3 s) and a refusal waits 15 s, then 45 s.
// Rows drop out when their offer deadline passes.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "BZP";
export const label = "BZP (Poland)";

const API = process.env.BZP_API || "https://ezamowienia.gov.pl/mo-board/api/v1/notice";
const PAGE = Number(process.env.BZP_PAGE_SIZE || 250);
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")) || [])[1] || "";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

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
  const delayMs = Number(process.env.BZP_DELAY_MS ?? 3000);
  const budgetMs = Number(process.env.BZP_BUDGET_MS || 8 * 60 * 1000);
  const maxPagesPerDay = 20;
  const startedAt = Date.now();
  const today = dayOf(startedAt);
  const byId = new Map(previousRows.map((r) => [r[0], r]));
  let requests = 0, read = 0, retried = 0, daysRead = 0;
  const notes = [];

  async function fetchPage(from, to) {
    const url = `${API}?NoticeType=ContractNotice&PublicationDateFrom=${from}&PublicationDateTo=${to}&PageSize=${PAGE}`;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (requests > 0) await sleep(attempt ? Math.min(120, lastError.retryAfter || 15 * 3 ** (attempt - 1)) * 1000 : delayMs);
      requests++;
      try {
        const res = await fetchImpl(url, { headers: { accept: "application/json" }, retries: 0, timeoutMs: 90000 });
        if (res.ok) {
          const list = JSON.parse(res.text || "[]");
          // Anything but a list (an error object, a maintenance page as JSON) used to read as "no
          // notices", which marked the day as fully read and never came back to it.
          if (Array.isArray(list)) return list;
          throw new Error(`unexpected reply (not a list): ${String(res.text).slice(0, 80)}`);
        }
        lastError = Object.assign(new Error(`HTTP ${res.status}`), { retryAfter: res.retryAfter });
      } catch (err) { lastError = err; }
      retried++;
      log(`BZP: ${lastError.message.split(" reading ")[0]} from ${from} (attempt ${attempt + 1})`);
    }
    throw lastError;
  }

  // Reads one whole day with a time cursor; true only if the day was read to its end.
  async function readDay(day) {
    const to = `${day}T23:59:59`;
    let cursor = `${day}T00:00:00`;
    for (let page = 1; page <= maxPagesPerDay; page++) {
      if (Date.now() - startedAt > budgetMs) return false;
      const list = await fetchPage(cursor, to);
      for (const n of list) {
        read++;
        const row = toNoticeRow(n);
        if (!row[0] || !row[1] || !row[4] || row[4] < today) continue;
        byId.set(row[0], row);
      }
      if (list.length < PAGE) return true;
      // Next page starts at the last row's second (inclusive, so a few rows repeat and are deduped).
      let next = String(list[list.length - 1].publicationDate || "").slice(0, 19);
      if (!next || next <= cursor) next = new Date(Date.parse(cursor + "Z") + 1000).toISOString().slice(0, 19);
      cursor = next;
    }
    notes.push(`${day} has more than ${maxPagesPerDay} pages`);
    return true;
  }

  // Days already read in full by earlier runs. Today and yesterday are always re-read, because
  // notices keep arriving until a day is over.
  const window = Array.from({ length: lookbackDays }, (_, i) => dayOf(startedAt - i * 864e5));
  const done = new Set((previousState.doneDays || []).filter((d) => window.includes(d) && d < dayOf(startedAt - 864e5)));
  let stopped = "";
  for (const day of window) {
    if (done.has(day)) continue;
    try {
      if (!(await readDay(day))) { stopped = "time budget reached"; break; }
    } catch (err) {
      if (!read) throw new Error(`BZP: could not read ${day}: ${err.message}`);
      stopped = `stopped at ${day}: ${err.message.split(" reading ")[0]}`;
      break;
    }
    done.add(day);
    daysRead++;
  }
  if (stopped) notes.push(stopped + "; continues next run");

  let expired = 0;
  for (const [id, row] of byId) if (row[4] < today) { byId.delete(id); expired++; }

  const rows = [...byId.values()];
  const missing = window.filter((d) => !done.has(d)).length;
  log(`BZP: ${requests} request(s), ${retried} retried, ${daysRead} day(s) read, ${read} notices read, ${expired} expired; index now ${rows.length}; ${missing ? `${missing} day(s) still to backfill` : "backfill complete"}`);
  notes.push(`requests ${requests}`, `retried ${retried}`, `days ${daysRead}`, `read ${read}`, missing ? `${missing} days to backfill` : "backfill complete");
  return { rows, notes, state: { doneDays: [...done].sort(), updatedAt: new Date().toISOString() } };
}
