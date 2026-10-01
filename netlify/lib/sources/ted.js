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
  // Shared by a notice and its corrections, so dedupe() can show each procedure once.
  "procedure-identifier",
];

function buildBase({ cpvCodes, keywords }) {
  if (cpvCodes?.length) return `classification-cpv IN (${cpvCodes.join(" ")})`;
  const words = (keywords || [])
    .map((k) => String(k).replace(/[^\p{L}\p{N}-]/gu, " ").trim())
    .join(" ").split(/\s+/).filter((w) => w.length > 2).slice(0, 10);
  return words.length ? `FT IN (${words.join(" ")})` : "";
}

// Two attempts, and the second only when the first FAILED (HTTP error, unreadable reply), never when
// it found nothing: "0 rows" is an answer. Every attempt keeps the country filter. An earlier version
// dropped filters one by one after 0 rows, so an Austria search with nothing open in Austria quietly
// returned German tenders, labelled as a normal TED result.
//
// No publication-date filter: scope ACTIVE already means "still open", and a date window hid
// long-running calls (dynamic purchasing systems, qualification systems) published months ago.
function buildAttempts({ cpvCodes, keywords, country }) {
  const base = buildBase({ cpvCodes, keywords });
  if (!base) return [];
  const query = country ? `(${base}) AND buyer-country IN (${country})` : base;
  return [
    { label: "sorted", query: `${query} SORT BY publication-number DESC`, fields: FIELDS },
    { label: "unsorted", query, fields: FIELDS },
  ];
}

// A notice's lots can close on different dates; the notice is open while any lot is, so the latest
// lot deadline is the one that decides. (The first lot's date dropped notices whose later lots were
// still open.)
function lastDate(value) {
  const dates = [].concat(value || []).map((d) => (/^\d{4}-\d{2}-\d{2}/.exec(String(d)) || [])[0]).filter(Boolean);
  return dates.sort().pop() || "";
}

export function toNotice(row) {
  const pub = normaliseText(row["publication-number"]) || normaliseText(row.ND);
  const deadline = lastDate(row["deadline-receipt-tender-date-lot"]) || lastDate(row["deadline-date-lot"]);
  const title = normaliseText(row["notice-title"]) || normaliseText(row["title-proc"]) || normaliseText(row.TI);
  return {
    id: pub ? `TED-${pub}` : "",
    title: title || (pub ? `TED notice ${pub}` : "Untitled notice"),
    buyer: normaliseText(row["buyer-name"]) || normaliseText(row.AA),
    country: normaliseText(row["buyer-country"]) || normaliseText(row.CY),
    published: normaliseText(row["publication-date"]).slice(0, 10),
    deadline,
    daysLeft: daysUntil(deadline),
    cpv: [...new Set([].concat(row["classification-cpv"] || []).map((c) => normaliseText(c)).filter(Boolean))].join(" "),
    link: pub ? `https://ted.europa.eu/en/notice/-/detail/${pub}` : "https://ted.europa.eu/en/search",
    procedure: normaliseText(row["procedure-identifier"]),
    source: id,
  };
}

export async function search({ cpvCodes, keywords, country, limit, signal }) {
  const diagnostics = [];
  const attempts = buildAttempts({ cpvCodes, keywords, country });
  if (!attempts.length) return { notices: [], variant: null, status: "ok", diagnostics: ["skipped: no usable search terms"] };
  for (const attempt of attempts) {
    const payload = {
      query: attempt.query,
      limit: String(Math.min(Math.max(limit || 40, 1), 100)),
      scope: "ACTIVE",
      checkQuerySyntax: false,
      paginationMode: "ITERATION",
      onlyLatestVersions: false,
      fields: attempt.fields,
    };
    try {
      const res = await fetchWithTimeout(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal,
      });
      const text = await res.text();
      if (!res.ok) { diagnostics.push(`${attempt.label}: HTTP ${res.status} — ${text.slice(0, 200)}`); continue; }
      let data;
      try { data = JSON.parse(text); }
      catch { diagnostics.push(`${attempt.label}: not JSON — ${text.slice(0, 140)}`); continue; }
      const rows = data.notices || data.results || [];
      const total = Number(data.totalNoticeCount);
      return { notices: rows.map(toNotice), matched: Number.isFinite(total) ? total : rows.length, variant: attempt.label, status: "ok", diagnostics };
    } catch (err) {
      const timedOut = err.name === "AbortError" || err.name === "TimeoutError";
      diagnostics.push(`${attempt.label}: ${timedOut ? "timed out" : err.message || err.name}`);
      // A slow TED will be just as slow on the second attempt; retrying only spends the user's wait.
      if (timedOut) return { notices: [], variant: null, status: "timeout", diagnostics };
    }
  }
  return { notices: [], variant: null, status: "error", diagnostics };
}
