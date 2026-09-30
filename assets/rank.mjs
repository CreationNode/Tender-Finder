// Ranking of official CPV codes against a plain-language query.
//
// Extracted into its own module so the browser and the command-line test share ONE implementation.
// A ranking bug is invisible until you look at real output, so it has to be testable against the
// real 9,454-code vocabulary rather than a fixture.
//
// Scoring principles, learned from real output:
//   1. Covering ALL the user's words beats matching one of them. The first version gave a big bonus
//      when a label equalled any single word, so a query for "solar panels" ranked the generic
//      "Panels" above "Solar panels" — precisely backwards.
//   2. An exact phrase match is the strongest possible signal.
//   3. Shorter labels break ties, because CPV nests general -> specific and the shorter label is
//      the more general category.

/** Light plural handling: CPV labels are inconsistent ("Chairs", "Natural honey", "Helmet"). */
function variants(word) {
  const out = new Set([word]);
  if (word.endsWith("ies") && word.length > 4) out.add(word.slice(0, -3) + "y");
  if (word.endsWith("es") && word.length > 3) out.add(word.slice(0, -2));
  if (word.endsWith("s") && word.length > 3) out.add(word.slice(0, -1));
  else out.add(word + "s");
  return [...out];
}

const STOP = new Set(["and", "for", "the", "with", "our", "your", "from", "into", "per"]);

export function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

export function scoreLabel(label, words, fullQuery) {
  const L = String(label || "").toLowerCase();
  if (!L || !words.length) return 0;

  let hits = 0;          // words matched at a word boundary
  let partials = 0;      // words matched only as a substring
  for (const word of words) {
    let matched = false;
    for (const v of variants(word)) {
      if (new RegExp(`\\b${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(L)) { hits++; matched = true; break; }
    }
    if (!matched && variants(word).some((v) => L.includes(v))) partials++;
  }
  if (!hits && !partials) return 0;

  let score = hits * 3 + partials;
  // Covering every word the user typed is the dominant signal.
  if (hits === words.length) score += 10;
  // Exact phrase equality is stronger still.
  if (L === fullQuery) score += 15;
  else if (L.includes(fullQuery) && words.length > 1) score += 6;
  return score;
}

/**
 * @param {string} text        what the user typed
 * @param {Array<[string,string]>} codes  [code, label] pairs from data/cpv-full.json
 * @param {Set<string>} exclude codes already suggested by the curated dictionary
 * @param {number} limit
 */
export function rankCpv(text, codes, exclude = new Set(), limit = 8) {
  const words = tokenize(text);
  if (!words.length || !codes) return [];
  const fullQuery = words.join(" ");
  const scored = [];
  for (const [code, label] of codes) {
    if (exclude.has(code)) continue;
    const score = scoreLabel(label, words, fullQuery);
    if (score > 0) scored.push({ score, code, label });
  }
  scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length || a.code.localeCompare(b.code));
  return scored.slice(0, limit);
}
