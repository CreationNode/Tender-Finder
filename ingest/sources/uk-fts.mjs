// Ingest: UK Find a Tender Service (FTS) — above-threshold UK notices.
// Endpoint and parameters verified against live API documentation and sample payloads.
// Licence: Open Government Licence v3 (stated inside every response package).
// Auth: none.

import { crawlOcds, releaseToRow, isOpportunity } from "../lib/ocds.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "UK-FTS";
export const label = "Find a Tender (UK, above threshold)";

const API = process.env.FTS_API || "https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages";

export async function ingest({ fetchImpl = politeFetch, log = console.log, previousRows = [], previousState = {} } = {}) {
  const maxPages = Number(process.env.FTS_MAX_PAGES || 25);
  const budgetMs = Number(process.env.FTS_BUDGET_MS || 5 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10);

  // Incremental: resume from the last run's high-water mark, with a small overlap so nothing slips
  // through the gap. Cold start looks back 45 days, which is roughly a full notice cycle.
  const lookbackDays = previousState.updatedTo ? 2 : 45;
  const since = previousState.updatedTo
    ? new Date(new Date(previousState.updatedTo).getTime() - lookbackDays * 86400000)
    : new Date(Date.now() - lookbackDays * 86400000);
  const updatedFrom = since.toISOString().slice(0, 19);
  const runAt = new Date().toISOString().slice(0, 19);

  const byId = new Map();
  for (const row of previousRows) byId.set(row[0], row);

  let seen = 0, kept = 0, history = 0;
  const startUrl = `${API}?updatedFrom=${encodeURIComponent(updatedFrom)}&updatedTo=${encodeURIComponent(runAt)}&limit=100`;
  log(`FTS: crawling from ${updatedFrom}`);

  const { pages, notes } = await crawlOcds({
    startUrl, fetchImpl, maxPages, budgetMs, log,
    onPage: (releases) => {
      for (const r of releases) {
        seen++;
        const row = releaseToRow(r, {
          country: "GBR",
          idPrefix: "UK",
          linkFor: (rel) => (rel.ocid ? `https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(rel.ocid)}` : "https://www.find-tender.service.gov.uk/Search"),
        });
        if (!row[0] || !row[1]) continue;                 // no id or no title: unusable
        if (!isOpportunity(r)) { byId.delete(row[0]); history++; continue; }
        byId.set(row[0], row);
        kept++;
      }
    },
  });

  // Prune anything whose deadline has passed since the last run.
  let expired = 0;
  for (const [id, row] of byId) {
    if (row[4] && row[4] < today) { byId.delete(id); expired++; }
  }

  const rows = [...byId.values()];
  log(`FTS: ${pages} page(s), ${seen} releases -> ${kept} opportunities, ${history} award/contract skipped, ${expired} expired pruned; index ${rows.length}`);
  return {
    rows,
    notes: [...notes, `pages ${pages}`, `releases ${seen}`, `opportunities ${kept}`, `history ${history}`],
    state: { updatedTo: runAt, updatedAt: new Date().toISOString() },
  };
}
