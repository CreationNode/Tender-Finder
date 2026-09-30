// Cached-source reader.
//
// Some portals cannot be queried live: SAM.gov allows ~10 API calls per DAY on a personal key,
// Prozorro exposes a date-feed rather than search, CanadaBuys ships a multi-megabyte CSV. For all
// of these, a scheduled job ingests the data into data/index/<source>.json (committed to the repo,
// served from CDN) and this module searches that index in memory.
//
// Consequences worth understanding:
//   * Search is fast and has no rate limit — the index is a static file behind a CDN.
//   * Results are as fresh as the last ingestion run, so every response carries the index age and
//     the UI shows it. A cached source that silently stops refreshing is the failure mode here, so
//     staleness is surfaced, never hidden.

import { daysUntil } from "./contract.js";

const COL = { id: 0, title: 1, buyer: 2, country: 3, deadline: 4, published: 5, codes: 6, link: 7 };

// Warm-lambda cache: parsing a few MB of JSON per request would be wasteful, and Netlify reuses
// containers between invocations.
const memo = new Map();

/**
 * Where indexes are served from.
 *
 * Default: this site's own /data/index/ (simple, works with a drag-and-drop deploy).
 *
 * Set INDEX_BASE_URL to serve them from somewhere else — for example an orphan `indexes` branch on
 * GitHub, fetched via raw.githubusercontent.com. That matters at scale: the SAM index alone is
 * ~7 MB, so committing a fresh copy to the main branch every day adds roughly 2 GB of permanent git
 * history per year, and clone times climb until the repo is unusable. Publishing indexes to a
 * force-pushed branch keeps exactly one copy and no history at all, and the site never needs
 * redeploying when data refreshes.
 */
const INDEX_BASE = (process.env.INDEX_BASE_URL || "").replace(/\/+$/, "");

async function loadIndex(origin, name) {
  const cached = memo.get(name);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data;
  const base = INDEX_BASE || `${origin}/data/index`;
  const res = await fetch(`${base}/${name}.json`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`index ${name}.json not available from ${base} (HTTP ${res.status})`);
  const data = await res.json();
  memo.set(name, { at: Date.now(), data });
  return data;
}

function scoreRow(row, terms, codes) {
  const hay = (row[COL.title] + " " + row[COL.buyer] + " " + row[COL.codes]).toLowerCase();
  let score = 0;
  for (const c of codes) if (row[COL.codes].includes(c)) score += 5;
  for (const t of terms) {
    if (!t) continue;
    if (new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(hay)) score += 3;
    else if (hay.includes(t)) score += 1;
  }
  return score;
}

/**
 * Build a search function for one cached index.
 * `codeMatcher` extracts the code tokens this source understands from the request (e.g. PSC/NAICS).
 */
export function makeCachedSource({ id, label, countries, indexName, codeMatcher }) {
  return {
    id,
    label,
    countries,
    enabled: true,
    async search(params) {
      const diagnostics = [];
      const origin = params.origin;
      if (!origin) return { notices: [], variant: null, diagnostics: ["no origin available to load the index"] };

      let index;
      try {
        index = await loadIndex(origin, indexName);
      } catch (err) {
        return { notices: [], variant: null, diagnostics: [`${err.message} — has the ingestion job run yet?`] };
      }

      const ageHours = index.generatedAt
        ? Math.round((Date.now() - new Date(index.generatedAt)) / 3600000)
        : null;

      const terms = [...(params.curatedLabels || []), ...(params.keywords || [])]
        .flatMap((s) => String(s).toLowerCase().split(/[^\p{L}\p{N}]+/u))
        .filter((w) => w.length > 3);
      const codes = codeMatcher ? codeMatcher(params) : [];

      if (!terms.length && !codes.length) {
        return { notices: [], variant: null, diagnostics: ["skipped: no usable search terms"] };
      }

      const hits = [];
      for (const row of index.rows) {
        const score = scoreRow(row, terms, codes);
        if (score <= 0) continue;
        hits.push({ score, row });
      }
      hits.sort((a, b) => b.score - a.score);

      const notices = hits.slice(0, params.limit || 40).map(({ row }) => ({
        id: row[COL.id],
        title: row[COL.title],
        buyer: row[COL.buyer],
        country: row[COL.country],
        published: row[COL.published],
        deadline: row[COL.deadline],
        daysLeft: daysUntil(row[COL.deadline]),
        cpv: row[COL.codes],
        link: row[COL.link],
        source: id,
      }));

      diagnostics.push(`index of ${index.count} open notices, refreshed ${ageHours === null ? "unknown" : ageHours + "h"} ago`);
      if (ageHours !== null && ageHours > 48) {
        diagnostics.push(`STALE: this index has not refreshed in ${Math.round(ageHours / 24)} days — check the ingestion workflow`);
      }
      return { notices, variant: `cached index (${ageHours ?? "?"}h old)`, diagnostics, ageHours };
    },
  };
}
