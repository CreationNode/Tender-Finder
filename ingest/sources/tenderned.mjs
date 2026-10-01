// Ingest: TenderNed — the Netherlands' national procurement platform.
//
// TenderNed publishes a public "publication webservice" (TNS) documented on data.overheid.nl under
// CC0, keyless, JSON. Its robots.txt only disallows CMS paths; /papi is not restricted.
//
//   GET /papi/tenderned-rs-tns/v2/publicaties?page=N&size=100&publicatieType=AAO   (newest first)
//   GET /papi/tenderned-rs-tns/v2/publicaties/{id}                                    (detail, CPV)
//
// VERIFIED from a GitHub runner (2026-10-01): 146,080 publications in total; size=100 works; the
// publicatieType filter works; list rows carry the closing date but no CPV codes, which only the
// detail call returns.
//
// Only national notices are kept (europees=false). European ones are also published on TED, which
// this site already searches live, so keeping them would show every Dutch EU tender twice.
//
// Each run re-reads the contract notices (AAO) published in the last TENDERNED_LOOKBACK_DAYS and
// keeps the ones still open. CPV codes come from the detail call, cached in the previous index so
// each notice is looked up once; within TENDERNED_DETAIL_BUDGET_MS the backlog fills over a few runs.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "TENDERNED";
export const label = "TenderNed (Netherlands)";

const API = process.env.TENDERNED_API || "https://www.tenderned.nl/papi/tenderned-rs-tns/v2/publicaties";
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")) || [])[1] || "";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function ingest({ fetchImpl = fetchText, log = console.log, previousRows = [] } = {}) {
  const lookbackDays = Number(process.env.TENDERNED_LOOKBACK_DAYS || 120);
  const detailBudgetMs = Number(process.env.TENDERNED_DETAIL_BUDGET_MS || 5 * 60 * 1000);
  const delayMs = Number(process.env.TENDERNED_DELAY_MS ?? 500);
  const maxPages = Number(process.env.TENDERNED_MAX_PAGES || 150);
  const today = new Date().toISOString().slice(0, 10);
  const since = new Date(Date.now() - lookbackDays * 864e5).toISOString().slice(0, 10);

  const previous = new Map(previousRows.map((r) => [r[0], r]));
  const byId = new Map();
  let requests = 0, listed = 0, european = 0, ended = 0;
  const notes = [];

  async function getJson(url) {
    if (requests > 0) await sleep(delayMs);
    requests++;
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, retries: 1, timeoutMs: 60000 });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return JSON.parse(res.text || "{}");
  }

  // 1. Contract notices, newest first, until we pass the lookback window.
  let page = 0;
  for (; page < maxPages; page++) {
    let body;
    try { body = await getJson(`${API}?page=${page}&size=100&publicatieType=AAO`); }
    catch (err) {
      if (page === 0) throw new Error(`TenderNed list failed on the first page: ${err.message}`);
      notes.push(`list stopped at page ${page}: ${err.message}`);
      break;
    }
    const items = body.content || [];
    let older = false;
    for (const p of items) {
      listed++;
      const published = isoDate(p.publicatieDatum);
      if (published && published < since) { older = true; continue; }
      if (p.europees) { european++; continue; }
      if (p.isVroegtijdigeBeeindiging) { ended++; continue; }
      const deadline = isoDate(p.sluitingsDatum);
      if (!deadline || deadline < today) continue;
      const id = `NL-${p.publicatieId}`;
      byId.set(id, toRow({
        id,
        title: clean(p.aanbestedingNaam),
        buyer: clean(p.opdrachtgeverNaam),
        country: "NLD",
        deadline,
        published,
        codes: previous.get(id)?.[6] || "",
        link: p.link?.href || `https://www.tenderned.nl/aankondigingen/overzicht/${p.publicatieId}`,
      }));
    }
    if (older || body.last || !items.length) break;
  }
  log(`TenderNed: ${page + 1} list page(s), ${listed} contract notices read, ${byId.size} national and open (${european} European ones left to TED)`);

  // 2. CPV codes from the detail call, for rows that do not have them yet.
  const startedAt = Date.now();
  let looked = 0, missing = 0;
  for (const row of byId.values()) {
    if (row[6]) continue;
    if (Date.now() - startedAt > detailBudgetMs) { missing++; continue; }
    try {
      const d = await getJson(`${API}/${row[0].slice(3)}`);
      looked++;
      const cpv = [...new Set((d.cpvCodes || []).map((c) => (/^(\d{8})/.exec(c.code || "") || [])[1]).filter(Boolean))].slice(0, 6);
      row[6] = cpv.map((c) => `CPV ${c}`).join(" · ");
    } catch { missing++; }
  }
  if (missing) notes.push(`${missing} notice(s) still without CPV codes; filled in on later runs`);

  const rows = [...byId.values()];
  log(`TenderNed: ${requests} request(s), ${looked} detail lookups; index now ${rows.length}`);
  notes.push(`requests ${requests}`, `listed ${listed}`, `european skipped ${european}`, `details ${looked}`);
  return { rows, notes, state: { updatedAt: new Date().toISOString() } };
}
