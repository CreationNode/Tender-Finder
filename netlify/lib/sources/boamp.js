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
 * The phrases BOAMP's titles are searched for, ORed together. Each phrase is one `search(objet, …)`
 * clause, which needs all of its words.
 *
 * When the dictionary matched, these are the entries' French phrases ("gilets pare-balles"). Until
 * 2026-11-11 this sent the English label and the user's words split into single words, ORed: "body
 * armor" became body OR armour OR armor OR ballistic OR helmets, and BOAMP's loose matching returned
 * the Côtes-d'Armor department, "armoires" (cabinets) and a hall called Lawson Body, while missing
 * every French body-armour tender. With no dictionary match, the user's own words go as one phrase,
 * so every word has to be in the title.
 */
export function boampPhrases({ frTerms, keywords }) {
  const clean = (s) => String(s).replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
  if (frTerms?.length) return [...new Set(frTerms.map(clean).filter((t) => t.length > 1))].slice(0, 20);
  const words = (keywords || []).map(clean).join(" ").split(" ").filter((w) => w.length > 1).slice(0, 6);
  return words.length ? [words.join(" ")] : [];
}

function buildWhere(phrases, daysBack) {
  const since = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
  const terms = phrases.map((p) => `search(objet, ${q(p)})`).join(" OR ");
  return `(${terms}) AND dateparution >= date'${since}'`;
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

export async function search({ keywords, frTerms, daysBack, country, limit, signal }) {
  const diagnostics = [];

  // Only query BOAMP when France is in scope — otherwise it is wasted latency on every search.
  if (country && country !== "FRA") {
    return { notices: [], variant: null, status: "ok", diagnostics: ["skipped: country filter excludes France"] };
  }

  const phrases = boampPhrases({ frTerms, keywords });
  if (!phrases.length) return { notices: [], variant: null, status: "ok", diagnostics: ["skipped: no usable search words"] };

  // The second attempt runs only when the first FAILED (HTTP error, unreadable reply), not when it
  // found nothing: 0 rows is an answer, and widening the query after it only adds noise.
  const attempts = [
    { label: frTerms?.length ? "french phrases" : "all words", where: buildWhere(phrases, daysBack) },
    { label: "no date filter", where: `(${phrases.map((p) => `search(objet, ${q(p)})`).join(" OR ")})` },
  ];

  for (const attempt of attempts) {
    const url = `${ENDPOINT}?where=${encodeURIComponent(attempt.where)}&limit=${Math.min(limit, 100)}&order_by=dateparution%20DESC`;
    try {
      const res = await fetchWithTimeout(url, { headers: { accept: "application/json" }, signal });
      const text = await res.text();
      if (!res.ok) { diagnostics.push(`${attempt.label}: HTTP ${res.status} — ${text.slice(0, 200)}`); continue; }
      let data;
      try { data = JSON.parse(text); }
      catch { diagnostics.push(`${attempt.label}: not JSON — ${text.slice(0, 140)}`); continue; }
      const rows = data.results || data.records || [];
      const total = Number(data.total_count);
      // v2.1 returns flat records; older shapes nest under `fields`.
      return { notices: rows.map((r) => toNotice(r.fields || r)), matched: Number.isFinite(total) ? total : rows.length, variant: attempt.label, status: "ok", diagnostics };
    } catch (err) {
      const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
      diagnostics.push(`${attempt.label}: ${timedOut ? "timed out" : err.message || err.name}`);
      if (timedOut) return { notices: [], variant: null, status: "timeout", diagnostics };
    }
  }
  return { notices: [], variant: null, status: "error", diagnostics };
}
