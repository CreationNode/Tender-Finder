// The on-disk index format.
//
// Design goals, in order: small enough to serve from CDN and parse in milliseconds; honest about
// freshness; and trivially diffable in git so every ingestion run is auditable.
//
// Rows are ARRAYS, not objects — field names repeated 30,000 times is most of a JSON file's weight.
// COLUMNS documents the order. Only OPEN notices are stored: a passed deadline is not an
// opportunity, and dropping them keeps the file a fraction of its raw size.

export const COLUMNS = ["id", "title", "buyer", "country", "deadline", "published", "codes", "link"];

export function toRow(n) {
  return [
    n.id || "",
    (n.title || "").slice(0, 160),
    (n.buyer || "").slice(0, 90),
    n.country || "",
    n.deadline || "",
    n.published || "",
    n.codes || "",
    n.link || "",
  ];
}

export function buildIndex({ source, label, rows, notes = [] }) {
  return {
    source,
    label,
    generatedAt: new Date().toISOString(),
    columns: COLUMNS,
    count: rows.length,
    notes,
    rows,
  };
}

/**
 * Yield canary. A source that silently stops publishing looks exactly like a working one, so every
 * run compares against the previous count and refuses to overwrite a healthy index with a collapsed
 * one unless explicitly forced. This is the single most valuable safeguard in the whole pipeline.
 */
export function canaryVerdict(previousCount, newCount, { minRatio = 0.4, floor = 50 } = {}) {
  if (!previousCount) return { ok: true, reason: "no previous index to compare" };
  if (newCount >= previousCount * minRatio) return { ok: true, reason: `${newCount} vs previous ${previousCount}` };
  if (newCount < floor && previousCount < floor) return { ok: true, reason: "both counts below floor; too small to judge" };
  return {
    ok: false,
    reason: `row count collapsed: ${newCount} vs previous ${previousCount} (below ${Math.round(minRatio * 100)}% of previous). ` +
            `The source may have changed format or stopped publishing. Re-run with FORCE=1 to overwrite anyway.`,
  };
}
