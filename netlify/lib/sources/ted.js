// Source: TED — the EU's Official Journal tenders database.
// Coverage: EU-wide, above-threshold notices plus whatever member states publish voluntarily.
// Auth: none. Licence: EU reuse policy.
//
// The payload mirrors, field for field, one proven against the live API. Three details are load
// bearing and must not be "tidied" without live testing:
//   * limit must be a STRING ("40"), not a number
//   * onlyLatestVersions must be false
//   * FT takes BARE words — FT IN (ballistic helmet) — not quoted strings

import { fetchWithTimeout, daysUntil, normaliseText } from "./contract.js";

export const id = "TED";
export const label = "TED (EU Official Journal)";
// TED covers the EU/EEA. Listing them explicitly means a US search does not waste latency on a
// portal that structurally cannot have US notices.
export const countries = [
  "AUT","BEL","BGR","HRV","CYP","CZE","DNK","EST","FIN","FRA","DEU","GRC","HUN","IRL","ITA",
  "LVA","LTU","LUX","MLT","NLD","POL","PRT","ROU","SVK","SVN","ESP","SWE",
  "NOR","ISL","LIE","CHE",
];
export const enabled = true;

const ENDPOINT = "https://api.ted.europa.eu/v3/notices/search";
const FIELDS = [
  "publication-number", "notice-title", "buyer-name", "buyer-country",
  "publication-date", "deadline-receipt-tender-date-lot", "classification-cpv",
];

function ymd(daysAgo) {
  return new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10).replace(/-/g, "");
}

function buildBase({ cpvCodes, keywords }) {
  if (cpvCodes?.length) return `classification-cpv IN (${cpvCodes.join(" ")})`;
  const words = (keywords || [])
    .map((k) => String(k).replace(/[^\p{L}\p{N}-]/gu, " ").trim())
    .join(" ").split(/\s+/).filter((w) => w.length > 2).slice(0, 10);
  return words.length ? `FT IN (${words.join(" ")})` : "";
}

// Each step removes one thing that could be why TED said no, so a syntax change degrades to
// "fewer filters" instead of returning nothing.
function buildAttempts({ cpvCodes, keywords, daysBack, country }) {
  const base = buildBase({ cpvCodes, keywords });
  if (!base) return [];
  const since = ymd(daysBack);
  const withCountry = country ? `${base} AND buyer-country IN (${country})` : base;
  const a = [];
  if (country) {
    a.push({ label: "country+date+sort", query: `(${withCountry}) AND publication-date>=${since} SORT BY publication-number DESC`, fields: FIELDS });
    a.push({ label: "country+date", query: `(${withCountry}) AND publication-date>=${since}`, fields: FIELDS });
  }
  a.push({ label: "date+sort", query: `(${base}) AND publication-date>=${since} SORT BY publication-number DESC`, fields: FIELDS });
  a.push({ label: "date", query: `(${base}) AND publication-date>=${since}`, fields: FIELDS });
  a.push({ label: "date, default fields", query: `(${base}) AND publication-date>=${since}`, fields: null });
  a.push({ label: "bare query", query: base, fields: null });
  return a;
}

function toNotice(row) {
  const pub = normaliseText(row["publication-number"]) || normaliseText(row.ND);
  const deadline = (normaliseText(row["deadline-receipt-tender-date-lot"]) || normaliseText(row["deadline-date-lot"]) || "").slice(0, 10);
  const title = normaliseText(row["notice-title"]) || normaliseText(row["title-proc"]) || normaliseText(row.TI);
  return {
    id: pub ? `TED-${pub}` : "",
    title: title || (pub ? `TED notice ${pub}` : "Untitled notice"),
    buyer: normaliseText(row["buyer-name"]) || normaliseText(row.AA),
    country: normaliseText(row["buyer-country"]) || normaliseText(row.CY),
    published: normaliseText(row["publication-date"]).slice(0, 10),
    deadline,
    daysLeft: daysUntil(deadline),
    cpv: normaliseText(row["classification-cpv"]),
    link: pub ? `https://ted.europa.eu/en/notice/-/detail/${pub}` : "https://ted.europa.eu/en/search",
    source: id,
  };
}

export async function search({ cpvCodes, keywords, daysBack, country, limit }) {
  const diagnostics = [];
  for (const attempt of buildAttempts({ cpvCodes, keywords, daysBack, country })) {
    const payload = {
      query: attempt.query,
      limit: String(limit),
      scope: "ACTIVE",
      checkQuerySyntax: false,
      paginationMode: "ITERATION",
      onlyLatestVersions: false,
    };
    if (attempt.fields) payload.fields = attempt.fields;
    try {
      const res = await fetchWithTimeout(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      if (!res.ok) { diagnostics.push(`${attempt.label}: HTTP ${res.status} — ${text.slice(0, 200)}`); continue; }
      let data;
      try { data = JSON.parse(text); }
      catch { diagnostics.push(`${attempt.label}: not JSON — ${text.slice(0, 140)}`); continue; }
      const rows = data.notices || data.results || [];
      if (!rows.length) { diagnostics.push(`${attempt.label}: 0 rows`); continue; }
      return { notices: rows.map(toNotice), variant: attempt.label, diagnostics };
    } catch (err) {
      diagnostics.push(`${attempt.label}: ${err.name === "AbortError" ? "timed out" : err.name}`);
    }
  }
  return { notices: [], variant: null, diagnostics };
}
