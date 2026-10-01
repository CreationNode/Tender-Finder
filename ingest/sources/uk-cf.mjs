// Ingest: UK Contracts Finder — BELOW-threshold UK notices.
//
// This is the more valuable of the two UK sources for the audience this tool serves: Contracts
// Finder carries the smaller contracts (from £12k central government / £30k wider public sector)
// that a small supplier can realistically win, and which never appear on TED or FTS.
//
// Endpoint verified from the official API documentation sample:
//   /Published/Notices/OCDS/Search?publishedFrom=...&publishedTo=...&stages=planning,tender
// Licence: Open Government Licence v3. Auth: none.

import { crawlOcds, releaseToRow, isOpportunity } from "../lib/ocds.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "UK-CF";
export const label = "Contracts Finder (UK, below threshold)";

const API = process.env.CF_API || "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
const SITE = "https://www.contractsfinder.service.gov.uk";

// A notice page lives at /Notice/<notice GUID>. The release carries it as a tender document URL, and
// the release id is that GUID plus a "-<number>" suffix; /notice/<ocid> is "Page not found" (checked
// from a GitHub runner, 2026-10-01).
export function noticeLink(rel) {
  const doc = (rel?.tender?.documents || []).map((d) => String(d?.url || "")).find((u) => /^https:\/\/www\.contractsfinder\.service\.gov\.uk\/Notice\/[0-9a-f-]{36}$/i.test(u));
  if (doc) return doc;
  const guid = (/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(-\d+)?$/i.exec(String(rel?.id || "")) || [])[1];
  return guid ? `${SITE}/Notice/${guid}` : `${SITE}/Search`;
}

export async function ingest({ fetchImpl = politeFetch, log = console.log, previousRows = [], previousState = {} } = {}) {
  const maxPages = Number(process.env.CF_MAX_PAGES || 25);
  const budgetMs = Number(process.env.CF_BUDGET_MS || 5 * 60 * 1000);
  const today = new Date().toISOString().slice(0, 10);

  const lookbackDays = previousState.publishedTo ? 2 : 45;
  const since = previousState.publishedTo
    ? new Date(new Date(previousState.publishedTo).getTime() - lookbackDays * 86400000)
    : new Date(Date.now() - lookbackDays * 86400000);
  const publishedFrom = since.toISOString().slice(0, 19);
  const runAt = new Date().toISOString().slice(0, 19);

  const byId = new Map();
  for (const row of previousRows) {
    // Rows saved before the link fix point at /notice/<ocid>, which does not exist. The OCID does not
    // contain the notice GUID, so those go to the search page until they are re-read or close.
    if (/\/notice\/ocds-/i.test(row[7] || "")) row[7] = `${SITE}/Search`;
    byId.set(row[0], row);
  }

  let seen = 0, kept = 0, history = 0;
  // stages=planning,tender asks the server for opportunities only — cheaper than filtering locally.
  const startUrl = `${API}?publishedFrom=${encodeURIComponent(publishedFrom)}&publishedTo=${encodeURIComponent(runAt)}&stages=planning,tender`;
  log(`Contracts Finder: crawling from ${publishedFrom}`);

  const { pages, notes } = await crawlOcds({
    startUrl, fetchImpl, maxPages, budgetMs, log,
    onPage: (releases) => {
      for (const r of releases) {
        seen++;
        const row = releaseToRow(r, {
          country: "GBR",
          idPrefix: "UKCF",
          linkFor: noticeLink,
        });
        if (!row[0] || !row[1]) continue;
        if (!isOpportunity(r)) { byId.delete(row[0]); history++; continue; }
        byId.set(row[0], row);
        kept++;
      }
    },
  });

  let expired = 0;
  for (const [id, row] of byId) {
    if (row[4] && row[4] < today) { byId.delete(id); expired++; }
  }

  const rows = [...byId.values()];
  log(`Contracts Finder: ${pages} page(s), ${seen} releases -> ${kept} opportunities, ${history} history skipped, ${expired} expired pruned; index ${rows.length}`);
  return {
    rows,
    notes: [...notes, `pages ${pages}`, `releases ${seen}`, `opportunities ${kept}`],
    state: { publishedTo: runAt, updatedAt: new Date().toISOString() },
  };
}
