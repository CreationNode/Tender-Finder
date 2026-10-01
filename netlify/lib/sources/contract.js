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

/**
 * Wrap any fetch with a hard timeout so one slow portal cannot eat the function's budget. The
 * timeout also covers reading the body (it is not cleared when the headers arrive), and an outer
 * `options.signal` (the whole request's deadline) aborts it too.
 */
export async function fetchWithTimeout(url, options = {}, ms = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const outer = options.signal;
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Whole calendar days from today (UTC) to the deadline's date: 0 = closes today, 1 = tomorrow,
 * -1 = closed yesterday. Null when unknown — never guessed.
 *
 * Counted on dates, not hours: the previous hour-based version rounded, so a tender closing today
 * read "1 day" before noon UTC, and one that closed yesterday read "0, today" (as -0) until noon.
 * Most portals publish a date (sometimes with a time in the buyer's own timezone), so the date is
 * the honest unit; the date part is read as written, before any timezone shift.
 */
export function daysUntil(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ""));
  if (!m) return null;
  const deadline = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (isNaN(deadline)) return null;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((deadline - today) / 86400000) + 0;   // + 0 turns -0 into 0
}

/** A notice is only an opportunity if its deadline has not passed. Unknown deadlines are kept. */
export function isStillOpen(notice) {
  return notice.daysLeft === null || notice.daysLeft === undefined || notice.daysLeft >= 0;
}

/** Today's date in UTC as YYYY-MM-DD, for comparing against index deadlines. */
export function todayUTC() {
  return new Date().toISOString().slice(0, 10);
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
 * twice. Two notices are one tender when they share the country and the deadline date and either
 *   * their titles share most of their words, or
 *   * they come from DIFFERENT sources and name the same buyer. TED shows an English translation
 *     while national portals show the original (Doffin: "Vintervedlikehold Region Vest" vs TED:
 *     "Winter maintenance Region West"), so titles alone missed 346 of 369 Norwegian pairs
 *     (measured 2026-10-01). The buyer match only counts when that buyer has exactly one notice
 *     with that deadline on each side, so a buyer closing two tenders on one day is never merged,
 *     and, when both carry CPV codes, they must share a CPV group.
 * Repeated versions of one TED procedure (a notice and its corrections) collapse to the latest.
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
  // Words that say what kind of body a buyer is, not which one: "Asker kommune" and "Narvik kommune"
  // share only "kommune", which must not count as the same buyer.
  const GENERIC = new Set(("kommune kommunes fylkeskommune municipality county council city ville commune " +
    "département region regione gemeente gmina powiat miasto ayuntamiento stadt landkreis gemeinde").split(" "));
  const sameBuyer = (a, b) => {
    const ta = tokens(a), tb = tokens(b);
    if (overlap(ta, tb) < 0.6) return false;
    for (const t of ta) if (tb.has(t) && !GENERIC.has(t)) return true;
    return false;
  };

  // CPV groups (first three digits). When both notices carry codes they must share one, so a buyer's
  // furniture tender is never taken for its cleaning tender.
  const groups = (cpv) => new Set((String(cpv || "").match(/\b\d{8}\b/g) || []).map((c) => c.slice(0, 3)));
  const sameGroup = (a, b) => {
    const ga = groups(a.cpv), gb = groups(b.cpv);
    if (!ga.size || !gb.size) return true;
    for (const g of ga) if (gb.has(g)) return true;
    return false;
  };

  // Repeated versions of one procedure from the same source (a notice and its corrections, which
  // can move the deadline): keep only the most recently published.
  const latest = new Map();
  for (const n of notices) {
    if (!n.procedure) continue;
    const key = `${n.source}|${n.procedure}`;
    const cur = latest.get(key);
    if (!cur || String(n.published || "") > String(cur.published || "")) latest.set(key, n);
  }
  const list = notices.filter((n) => !n.procedure || latest.get(`${n.source}|${n.procedure}`) === n);
  const sameSlot = (a, b) =>
    a.country === b.country && a.deadline && a.deadline === b.deadline &&
    a.buyer && b.buyer && sameBuyer(a.buyer, b.buyer) && sameGroup(a, b);
  // A buyer match only counts when it is unambiguous: exactly one notice on each side.
  const unique = (a, b) =>
    list.filter((m) => m.source === b.source && sameSlot(a, m)).length === 1 &&
    list.filter((m) => m.source === a.source && sameSlot(b, m)).length === 1;

  const kept = [];
  for (const n of list) {
    const nTok = tokens(n.title);
    let dup = kept.find(
      (k) =>
        k.country === n.country &&
        k.deadline && n.deadline && k.deadline === n.deadline &&
        overlap(tokens(k.title), nTok) >= 0.7
    );
    if (!dup) {
      dup = kept.find(
        (k) => k.source !== n.source && !(k.alsoOn || []).includes(n.source) && sameSlot(k, n) && unique(k, n)
      );
    }
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
