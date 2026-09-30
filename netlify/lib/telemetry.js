// Telemetry for the tender finder.
//
// Purpose: answer one question — what are people searching for that this tool fails to help with?
// That is the yield-canary lesson from the desktop engine: a silent miss looks identical to no
// demand, so measure it explicitly or you will optimise the wrong thing.
//
// Privacy posture (deliberate, because this is a public site):
//   * No IP addresses, no user agents, no cookies, no identifiers of any kind.
//   * Search terms are product descriptions, but people type unexpected things, so a term is only
//     retained when it is short, contains no "@" and no long digit runs (crude but effective
//     filters for emails and phone/ID numbers), and it is truncated.
//   * Only MISSES are retained as text. Successful searches are counted, not recorded — the misses
//     are the actionable part, and keeping less is the point.
//   * Everything here fails open: telemetry must never break a search.

const MAX_TERM = 60;

export function safeTerm(raw) {
  const t = String(raw || "").trim().toLowerCase().slice(0, MAX_TERM);
  if (!t) return null;
  if (t.includes("@")) return null;              // looks like an email
  if (/\d{6,}/.test(t)) return null;             // long digit run: phone, ID, card
  if (!/[a-z\u00c0-\u024f]/.test(t)) return null; // no letters at all: not a product description
  return t;
}

/**
 * Emit one structured metric line. Netlify captures function logs, so this alone gives you
 * searchable telemetry with zero dependencies and zero storage.
 */
export function logMetric(metric) {
  try {
    console.log("SEARCH_METRIC " + JSON.stringify(metric));
  } catch {
    /* never break the request */
  }
}

/**
 * Optional durable aggregation using Netlify Blobs, so misses accumulate across deploys and can be
 * read back by the stats endpoint. If the package or store is unavailable (local dev, permissions,
 * older runtime) this silently does nothing and the console log above is still the record.
 */
export async function recordAggregate({ matched, term, resultCount }) {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("tender-finder-stats");
    const day = new Date().toISOString().slice(0, 10);
    const key = `daily/${day}.json`;

    const existing = (await store.get(key, { type: "json" })) || {
      day,
      searches: 0,
      matched: 0,
      unmatched: 0,
      zeroResults: 0,
      misses: {},
    };

    existing.searches += 1;
    if (matched) existing.matched += 1;
    else existing.unmatched += 1;
    if (resultCount === 0) existing.zeroResults += 1;

    // Retain the TEXT only for the cases worth acting on: no dictionary match, or a match that
    // still returned nothing. These are the entries to add or fix.
    if (term && (!matched || resultCount === 0)) {
      existing.misses[term] = (existing.misses[term] || 0) + 1;
      // Keep the file small and bounded: top 300 terms per day.
      const entries = Object.entries(existing.misses).sort((a, b) => b[1] - a[1]).slice(0, 300);
      existing.misses = Object.fromEntries(entries);
    }

    await store.setJSON(key, existing);
  } catch {
    /* aggregation is best-effort by design */
  }
}
