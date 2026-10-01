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

import { daysUntil, todayUTC } from "./contract.js";

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

const FRESH_MS = 10 * 60 * 1000;       // re-check the published index after this long
const MISSING_MS = 10 * 60 * 1000;     // remember a 404 this long, instead of re-asking every search
const LOAD_TIMEOUT_MS = Number(process.env.INDEX_TIMEOUT_MS || 6000);
const inflight = new Map();

class IndexMissing extends Error {}

/**
 * Load an index, preferring a working answer over a fresh one:
 *   * a copy younger than FRESH_MS is used as is;
 *   * when a refresh fails (timeout, network, 5xx), the older copy is served and flagged, instead
 *     of the source dropping to "0 found" until the host recovers;
 *   * a 404 is remembered, so a not-yet-built index does not cost a request on every search;
 *   * concurrent requests for the same index share one download.
 * Returns { data, refreshFailed } or throws IndexMissing / Error.
 */
async function loadIndex(origin, name) {
  const cached = memo.get(name);
  if (cached?.missing && Date.now() - cached.at < MISSING_MS) throw new IndexMissing(cached.missing);
  if (cached?.data && Date.now() - cached.at < FRESH_MS) return { data: cached.data, refreshFailed: false };
  if (!inflight.has(name)) {
    inflight.set(name, (async () => {
      const base = INDEX_BASE || `${origin}/data/index`;
      const res = await fetch(`${base}/${name}.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(LOAD_TIMEOUT_MS) });
      if (res.status === 404) {
        const msg = `index ${name}.json not built yet`;
        memo.set(name, { at: Date.now(), missing: msg });
        throw new IndexMissing(msg);
      }
      if (!res.ok) throw new Error(`index ${name}.json: HTTP ${res.status}`);
      const data = await res.json();
      memo.set(name, { at: Date.now(), data });
      return data;
    })().finally(() => inflight.delete(name)));
  }
  try {
    return { data: await inflight.get(name), refreshFailed: false };
  } catch (err) {
    if (cached?.data && !(err instanceof IndexMissing)) return { data: cached.data, refreshFailed: err.name === "TimeoutError" ? "timed out" : err.message };
    throw err;
  }
}

// Words too common to count as evidence on their own.
const STOP = new Set(["and", "the", "for", "with", "from", "of", "in", "to", "or", "a", "an", "services", "supply", "supplies"]);

/** Crude plural folding so "panel" matches "panels" and "batteries" matches "battery". */
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

// Accents are folded so "balístico", "balistico" and "BALÍSTICO" are one token: Brazilian titles
// are often typed in capitals without accents.
function words(text) {
  return String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP.has(w)).map(stem);
}

// Whole-word token set per row, built once per loaded index (the index is memoised for 10 min).
const tokenCache = new WeakMap();
function rowTokens(row) {
  let t = tokenCache.get(row);
  if (!t) {
    t = new Set(words(row[COL.title] + " " + row[COL.buyer]));
    tokenCache.set(row, t);
  }
  return t;
}

/**
 * A row qualifies only on real evidence: a classification-code hit, or ONE phrase matched as whole
 * words. Phrases are the user's own query and each dictionary term it triggered ("solar").
 *
 * WHY: the previous rule kept any row with a single word or even a substring hit. On the live SAM
 * index "solar panels" returned cockpit control panels, fire alarm panels and SolarWinds licences,
 * because "panels" alone and "solar" inside "SolarWinds" both counted. Dictionary LABELS were also
 * split into words, so "Body armour…" pulled in every "VALVE BODY" part. Labels are category names,
 * not search terms, and are no longer used here.
 */
function scoreRow(row, phrases, codes) {
  let score = 0;
  let evidence = false;
  // A code hit counts once, however many codes match: family codes such as PSC "7E20" (all end-user
  // IT hardware) are real evidence but weaker than the words the person actually typed.
  if (codes.some((c) => row[COL.codes].includes(c))) { score += 4; evidence = true; }
  const tokens = rowTokens(row);
  for (const { ws, need, weight } of phrases) {
    let hit = 0;
    for (const w of ws) if (tokens.has(w)) hit++;
    if (hit >= need) { evidence = true; score += weight + hit; }
  }
  return evidence ? score : 0;
}

/**
 * Turn the request into phrases. A two-word query needs both words; a longer one may miss one
 * word, so "school furniture for classrooms" still finds "Classroom furniture".
 */
function buildPhrases(params, localTerms) {
  const phrases = [];
  const add = (text, weight) => {
    const ws = [...new Set(words(text))];
    if (!ws.length) return;
    if (phrases.some((p) => p.ws.join(" ") === ws.join(" "))) return;
    phrases.push({ ws, need: ws.length <= 2 ? ws.length : ws.length - 1, weight });
  };
  add((params.keywords || []).join(" "), 10);          // the user's own words rank highest
  for (const t of params.matchedTerms || []) add(t, 5);
  // Dictionary terms in the source's own language ("colete balístico" for "body armour").
  for (const t of localTerms ? localTerms(params) : []) add(t, 5);
  return phrases;
}

/** CPV prefix for hierarchy-aware matching: 09331000 covers 09331200. Division-only codes are too broad. */
export function cpvPrefixes(params) {
  return (params.cpvCodes || [])
    .map((c) => String(c).replace(/0+$/, ""))
    .filter((c) => c.length >= 3)
    .map((c) => `CPV ${c}`);
}

/**
 * Build a search function for one cached index.
 * `codeMatcher` extracts the code tokens this source understands from the request (e.g. PSC/NAICS).
 */
export function makeCachedSource({ id, label, countries, indexName, codeMatcher, localTerms }) {
  return {
    id,
    label,
    countries,
    enabled: true,
    async search(params) {
      const diagnostics = [];
      const origin = params.origin;
      if (!origin) return { notices: [], variant: null, status: "error", diagnostics: ["no origin available to load the index"] };

      let index, refreshFailed;
      try {
        ({ data: index, refreshFailed } = await loadIndex(origin, indexName));
      } catch (err) {
        if (err instanceof IndexMissing) return { notices: [], variant: null, status: "missing", diagnostics: [err.message] };
        const why = err.name === "TimeoutError" ? `index ${indexName}.json timed out` : err.message;
        return { notices: [], variant: null, status: "error", diagnostics: [why] };
      }
      if (refreshFailed) diagnostics.push(`could not refresh the index (${refreshFailed}); using the copy loaded earlier`);

      const ageHours = index.generatedAt
        ? Math.round((Date.now() - new Date(index.generatedAt)) / 3600000)
        : null;
      const stale = ageHours !== null && ageHours > 48;

      const phrases = buildPhrases(params, localTerms);
      const codes = codeMatcher ? codeMatcher(params) : [];

      if (!phrases.length && !codes.length) {
        return { notices: [], variant: null, status: "ok", diagnostics: ["skipped: no usable search terms"] };
      }

      // Rows whose deadline has passed are never shown, even when the index has not been pruned
      // (a source whose ingest keeps failing would otherwise serve closed tenders indefinitely).
      const today = todayUTC();
      const hits = [];
      let closed = 0;
      for (const row of index.rows) {
        const score = scoreRow(row, phrases, codes);
        if (score <= 0) continue;
        if (row[COL.deadline] && row[COL.deadline] < today) { closed++; continue; }
        hits.push({ score, row });
      }
      // Best match first; among equal matches (every code-only hit scores the same), soonest
      // deadline first, so the cut to `limit` drops later deadlines rather than arbitrary rows.
      const dl = (r) => r[COL.deadline] || "9999-12-31";
      hits.sort((a, b) => b.score - a.score || (dl(a.row) < dl(b.row) ? -1 : dl(a.row) > dl(b.row) ? 1 : 0));

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
      if (closed) diagnostics.push(`${closed} matching notice(s) past their deadline left out`);
      if (stale) {
        diagnostics.push(`STALE: this index has not refreshed in ${Math.round(ageHours / 24)} days — check the ingestion workflow`);
      }
      return { notices, matched: hits.length, status: stale ? "stale" : "ok", variant: `cached index (${ageHours ?? "?"}h old)`, diagnostics, ageHours };
    },
  };
}
