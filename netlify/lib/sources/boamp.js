// Source: BOAMP — Bulletin officiel des annonces des marchés publics (France).
// Coverage: French public contract notices INCLUDING below-threshold ones that never reach TED.
//   That is the whole point of adding it: it covers what TED structurally cannot see.
// Auth: none. API: OpenDataSoft Explore v2.1. Licence: Licence Ouverte / Open Licence (Etalab).
//
// IMPORTANT DESIGN NOTE — why this searches text, not CPV codes:
// the public BOAMP dataset does not expose a reliable, consistently populated CPV column. It
// classifies with its own "descripteur" vocabulary and carries the subject line in `objet`. So
// while TED is queried by CPV code (precise), BOAMP is queried by words (broader, noisier). The
// UI labels every result with its source so a user can see which is which, and we send the human's
// own phrase here rather than pretending a code lookup happened.

import { fetchWithTimeout, daysUntil, normaliseText } from "./contract.js";

export const id = "BOAMP";
export const label = "BOAMP (France, incl. below-threshold)";
export const countries = ["FRA"];          // only queried when France is in scope
export const enabled = true;

const ENDPOINT = "https://boamp-datadila.opendatasoft.com/api/explore/v2.1/catalog/datasets/boamp/records";

/** Escape a value for an ODS `where` clause string literal. */
function q(value) {
  return `"${String(value).replace(/["\\]/g, " ").trim()}"`;
}

/**
 * ODS full-text search across the record. `search(field, terms)` is fuzzy-ish and forgiving, which
 * suits a public tool where people type approximate words.
 */
function buildWhere(words, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const terms = words.map((w) => `search(objet, ${q(w)})`).join(" OR ");
  const clauses = [];
  if (terms) clauses.push(`(${terms})`);
  clauses.push(`dateparution >= date'${since}'`);
  return clauses.join(" AND ");
}

function toNotice(row) {
  const rid = normaliseText(row.idweb) || normaliseText(row.id) || normaliseText(row.nojo);
  const deadline = (normaliseText(row.datelimitereponse) || normaliseText(row.datefindiffusion) || "").slice(0, 10);
  const title = normaliseText(row.objet) || normaliseText(row.titre);
  // BOAMP exposes a stable public permalink per notice id.
  const link = normaliseText(row.url_avis) || (rid ? `https://www.boamp.fr/pages/avis/?q=idweb:${encodeURIComponent(rid)}` : "https://www.boamp.fr/");
  return {
    id: rid ? `BOAMP-${rid}` : "",
    title: title || (rid ? `BOAMP notice ${rid}` : "Untitled notice"),
    buyer: normaliseText(row.nomacheteur) || normaliseText(row.organisme) || "",
    country: "FRA",
    published: normaliseText(row.dateparution).slice(0, 10),
    deadline,
    daysLeft: daysUntil(deadline),
    cpv: normaliseText(row.code_cpv) || normaliseText(row.descripteur_libelle) || "",
    link,
    source: id,
  };
}

export async function search({ keywords, curatedLabels, daysBack, country, limit }) {
  const diagnostics = [];

  // Only query BOAMP when France is in scope — otherwise it is wasted latency on every search.
  if (country && country !== "FRA") {
    return { notices: [], variant: null, diagnostics: ["skipped: country filter excludes France"] };
  }

  // Prefer the curated concept labels (e.g. "Chairs and seating") when the dictionary matched,
  // since they are cleaner search terms than raw user input; fall back to the user's own words.
  const words = [...(curatedLabels || []), ...(keywords || [])]
    .flatMap((s) => String(s).split(/[^\p{L}\p{N}-]+/u))
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3)
    .slice(0, 6);

  if (!words.length) return { notices: [], variant: null, diagnostics: ["skipped: no usable search words"] };

  const attempts = [
    { label: "text+date", where: buildWhere(words, daysBack) },
    { label: "text only", where: `(${words.map((w) => `search(objet, ${q(w)})`).join(" OR ")})` },
  ];

  for (const attempt of attempts) {
    const url = `${ENDPOINT}?where=${encodeURIComponent(attempt.where)}&limit=${Math.min(limit, 100)}&order_by=dateparution%20DESC`;
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
      const text = await res.text();
      if (!res.ok) { diagnostics.push(`${attempt.label}: HTTP ${res.status} — ${text.slice(0, 200)}`); continue; }
      let data;
      try { data = JSON.parse(text); }
      catch { diagnostics.push(`${attempt.label}: not JSON — ${text.slice(0, 140)}`); continue; }
      const rows = data.results || data.records || [];
      if (!rows.length) { diagnostics.push(`${attempt.label}: 0 rows`); continue; }
      // v2.1 returns flat records; older shapes nest under `fields`.
      return { notices: rows.map((r) => toNotice(r.fields || r)), variant: attempt.label, diagnostics };
    } catch (err) {
      diagnostics.push(`${attempt.label}: ${err.name === "AbortError" ? "timed out" : err.name}`);
    }
  }
  return { notices: [], variant: null, diagnostics };
}
