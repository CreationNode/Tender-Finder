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

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "BZP";
export const label = "BZP (Poland)";

const API = process.env.BZP_API || "https://ezamowienia.gov.pl/mo-board/api/v1/notice";
const PAGE = 500;
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

export async function ingest({ fetchImpl = fetchText, log = console.log } = {}) {
  const lookbackDays = Number(process.env.BZP_LOOKBACK_DAYS || 60);
  const delayMs = Number(process.env.BZP_DELAY_MS ?? 1000);
  const budgetMs = Number(process.env.BZP_BUDGET_MS || 8 * 60 * 1000);
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map();
  let requests = 0, read = 0, failed = 0;
  const notes = [];

  async function fetchWindow(from, to) {
    const url = `${API}?NoticeType=ContractNotice&PublicationDateFrom=${stamp(from)}&PublicationDateTo=${stamp(to)}&PageSize=${PAGE}&PageNumber=1`;
    if (requests > 0) await sleep(delayMs);
    requests++;
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, retries: 1, timeoutMs: 90000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const list = JSON.parse(res.text || "[]");
    return Array.isArray(list) ? list : [];
  }

  // Splits [from, to) until each half fits in one page, so no row depends on unstable paging.
  async function collect(from, to) {
    if (Date.now() - startedAt > budgetMs) { notes.push("time budget reached"); return false; }
    let list;
    try { list = await fetchWindow(from, to - 1000); }
    catch (err) {
      failed++;
      if (requests === 1) throw new Error(`BZP failed on the first request: ${err.message}`);
      return true;
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

  // One window per day, newest first, so a budget cut-off loses the oldest days, not today's.
  const end = Date.now();
  for (let d = 0; d < lookbackDays; d++) {
    const to = end - d * 864e5, from = to - 864e5;
    if (!(await collect(from, to))) break;
  }
  if (failed && failed >= requests / 2) throw new Error(`BZP: ${failed} of ${requests} requests failed. Check BZP_API.`);

  const rows = [...byId.values()];
  log(`BZP: ${requests} request(s), ${failed} failed, ${read} contract notices read; ${rows.length} still open`);
  notes.push(`requests ${requests}`, `failed ${failed}`, `read ${read}`);
  return { rows, notes, state: { updatedAt: new Date().toISOString() } };
}
