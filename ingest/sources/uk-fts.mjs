// Ingest: UK Find a Tender Service (FTS) — above-threshold UK notices.
// Endpoint and parameters verified against live API documentation and sample payloads.
// Licence: Open Government Licence v3 (stated inside every response package).
// Auth: none.

import { crawlOcds, releaseToRow, isOpportunity } from "../lib/ocds.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "UK-FTS";
export const label = "Find a Tender (UK, above threshold)";

const API = process.env.FTS_API || "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages";
const SITE = "https://www.find-tender.service.gov.uk";

// A notice page lives at /Notice/<notice id>, and the notice id is the RELEASE id ("092772-2026"),
// not the OCID: /Notice/<ocid> is "Page not found" (checked from a GitHub runner, 2026-10-01).
export function noticeLink(rel) {
  const id = String(rel?.id || "");
  return /^\d{6}-\d{4}$/.test(id) ? `${SITE}/Notice/${id}` : `${SITE}/Search`;
}

export async function ingest({ fetchImpl = politeFetch, log = console.log, previousRows = [], previousState = {} } = {}) {
  const maxPages = Number(process.env.FTS_MAX_PAGES || 25);
  const budgetMs = Number(process.env.FTS_BUDGET_MS || 5 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10);
  const runStartedMs = Date.now();

  // Incremental: resume from the last run's high-water mark, with a small overlap so nothing slips
  // through the gap. Cold start looks back 45 days, which is roughly a full notice cycle.
  const lookbackDays = previousState.updatedTo ? 2 : 45;
  const since = previousState.updatedTo
    ? new Date(new Date(previousState.updatedTo).getTime() - lookbackDays * 86400000)
    : new Date(Date.now() - lookbackDays * 86400000);
  const updatedFrom = since.toISOString().slice(0, 19);
  const runAt = new Date().toISOString().slice(0, 19);

  const byId = new Map();
  for (const row of previousRows) {
    // Rows saved before the link fix point at /Notice/<ocid>, which does not exist. The notice id
    // can't be recovered from the row, so send those to the search page until they are re-read or close.
    if (/\/Notice\/ocds-/.test(row[7] || "")) row[7] = `${SITE}/Search`;
    byId.set(row[0], row);
  }

  let seen = 0, kept = 0, history = 0;
  const startUrl = `${API}?updatedFrom=${encodeURIComponent(updatedFrom)}&updatedTo=${encodeURIComponent(runAt)}&limit=100`;
  log(`FTS: crawling from ${updatedFrom}`);

  const { pages, notes, complete, lastDate, ordered } = await crawlOcds({
    startUrl, fetchImpl, maxPages, budgetMs, log, pageSize: 100,
    onPage: (releases) => {
      for (const r of releases) {
        seen++;
        const row = releaseToRow(r, {
          country: "GBR",
          idPrefix: "UK",
          linkFor: noticeLink,
        });
        if (!row[0] || !row[1]) continue;                 // no id or no title: unusable
        if (!isOpportunity(r)) { byId.delete(row[0]); history++; continue; }
        byId.set(row[0], row);
        kept++;
      }
    },
  });

  // Repair links on rows saved before the link fix: look the notice up by its OCID (one small request
  // each, a few hundred at most, spaced out) and take the notice id from its latest release. Rows not
  // reached this run keep pointing at the search page and are tried again next run.
  const repairMax = Number(process.env.FTS_REPAIR_MAX || 200);
  let repaired = 0, repairTried = 0;
  for (const [id, row] of byId) {
    if (repairTried >= repairMax || Date.now() - runStartedMs > budgetMs + 4 * 60000) break;
    if (row[7] !== `${SITE}/Search` || !id.startsWith("UK-ocds-")) continue;
    repairTried++;
    try {
      const res = await fetchImpl(`${API}/${encodeURIComponent(id.slice(3))}`, { headers: { accept: "application/json" } });
      if (!res.ok) continue;
      const pkg = await res.json();
      const ocid = id.slice(3);
      // Only releases of THIS notice: never take an id from some other release in the package.
      const rel = (pkg.releases || []).filter((r) => r.ocid === ocid && /^\d{6}-\d{4}$/.test(String(r.id || ""))).sort((a, b) => String(a.date || "").localeCompare(String(b.date || ""))).pop();
      if (rel) { row[7] = noticeLink(rel); repaired++; }
    } catch { /* keep the search-page link; retried next run */ }
    await new Promise((r) => setTimeout(r, Number(process.env.FTS_REPAIR_DELAY_MS ?? 400)));
  }
  if (repairTried) log(`FTS: repaired ${repaired} of ${repairTried} old notice links`);

  // Prune anything whose deadline has passed since the last run, and undated notices (mostly
  // planning notices) once they are old: without a deadline nothing else ever removed them.
  const undatedCutoff = new Date(runStartedMs - Number(process.env.FTS_UNDATED_MAX_DAYS || 120) * 864e5).toISOString().slice(0, 10);
  let expired = 0, undatedOld = 0;
  for (const [id, row] of byId) {
    if (row[4] && row[4] < today) { byId.delete(id); expired++; }
    else if (!row[4] && row[5] && row[5] < undatedCutoff) { byId.delete(id); undatedOld++; }
  }

  // Move the cursor only as far as the crawl actually read. It used to jump to the run time even when
  // the page budget cut the crawl short, so every release past the cut was skipped for good.
  let updatedTo = runAt;
  if (!complete) {
    updatedTo = ordered && lastDate ? lastDate.slice(0, 19) : (previousState.updatedTo || updatedFrom);
    notes.push(`crawl incomplete; cursor held at ${updatedTo}`);
  }

  const rows = [...byId.values()];
  log(`FTS: ${pages} page(s), ${seen} releases -> ${kept} opportunities, ${history} award/contract skipped, ${expired} expired pruned; index ${rows.length}`);
  return {
    rows,
    notes: [...notes, ...(undatedOld ? [`undated older than cutoff dropped ${undatedOld}`] : []), `pages ${pages}`, `releases ${seen}`, `opportunities ${kept}`, `history ${history}`, ...(repairTried ? [`links repaired ${repaired}/${repairTried}`] : [])],
    state: { updatedTo, updatedAt: new Date().toISOString() },
  };
}
