// The contract every tender source must satisfy.
//
// One rule makes multi-source work: each adapter returns the SAME shape, and no adapter is allowed
// to throw. A source that is slow, broken, or has changed its schema must degrade to "no results
// from this source, here is why" — never to a failed page. That is the difference between a tool
// that quietly returns nothing and one that tells you what happened.
//
// Notice shape:
//   { id, title, buyer, country, deadline, daysLeft, published, cpv, link, source }
// `source` is the short provenance label shown on each result.

/** Wrap any fetch with a hard timeout so one slow portal cannot eat the function's budget. */
export async function fetchWithTimeout(url, options = {}, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Days between now and an ISO-ish date string. Null when unknown — never guessed. */
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(String(dateStr).slice(0, 10) + "T23:59:59Z");
  if (isNaN(d)) return null;
  return Math.round((d - new Date()) / 86400000);
}

/** A notice is only an opportunity if its deadline has not passed. Unknown deadlines are kept. */
export function isStillOpen(notice) {
  return notice.daysLeft === null || notice.daysLeft >= 0;
}

export function normaliseText(value) {
  // Portals return multilingual fields as strings, arrays, or objects keyed by language.
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return normaliseText(value[0]);
  if (typeof value === "object") {
    for (const k of ["eng", "en", "ENG", "EN", "fra", "fr"]) if (value[k]) return normaliseText(value[k]);
    const first = Object.values(value)[0];
    return first ? normaliseText(first) : "";
  }
  return String(value).trim();
}

/**
 * Cross-source de-duplication. A French above-threshold contract is published on BOTH TED and
 * BOAMP, so without this the same tender appears twice with different wording.
 *
 * Deliberately conservative — a false merge HIDES a real tender, which is worse than showing one
 * twice. Requires the same country, the same deadline date, and a strong title-token overlap.
 */
export function dedupe(notices) {
  const tokens = (s) =>
    new Set(
      String(s || "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3)
    );
  const overlap = (a, b) => {
    if (!a.size || !b.size) return 0;
    let hits = 0;
    for (const t of a) if (b.has(t)) hits++;
    return hits / Math.min(a.size, b.size);
  };

  const kept = [];
  for (const n of notices) {
    const nTok = tokens(n.title);
    const dup = kept.find(
      (k) =>
        k.country === n.country &&
        k.deadline && n.deadline && k.deadline === n.deadline &&
        overlap(tokens(k.title), nTok) >= 0.7
    );
    if (dup) {
      // Keep the richer record, but remember that both portals carried it.
      dup.alsoOn = [...new Set([...(dup.alsoOn || []), n.source])];
      if (!dup.buyer && n.buyer) dup.buyer = n.buyer;
      continue;
    }
    kept.push(n);
  }
  return kept;
}

/** Sort: soonest real deadline first, unknown deadlines last. */
export function byUrgency(a, b) {
  const av = a.daysLeft === null ? 99999 : a.daysLeft;
  const bv = b.daysLeft === null ? 99999 : b.daysLeft;
  return av - bv;
}
