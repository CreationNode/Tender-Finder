// Ingest: CanadaBuys — Canadian federal (and participating provincial) tender opportunities.
//
// The best-shaped open data source we have found anywhere: a plain CSV of every CURRENTLY OPEN
// tender notice, published under the Open Government Licence - Canada, refreshed each morning
// Eastern, and requiring no authentication of any kind. No key to rotate, no rate limit to respect.
//
// Column names are the documented bilingual headers from the CanadaBuys data dictionary
// (title-titre-eng, tenderClosingDate-appelOffresDateCloture, gsin-nibs, ...). They are verbose but
// stable; the picker below tolerates the English/French variants and minor casing drift.

import { streamCsvRows } from "../lib/csv.mjs";
import { politeFetch } from "../lib/http.mjs";
import { toRow } from "../lib/index-format.mjs";

export const source = "CANADA";
export const label = "CanadaBuys (Canada federal)";

// The canadabuys.canada.ca host sits behind bot protection that rejected our request from a home
// connection (HTTP 403) even with a descriptive agent. The same file is mirrored on the federal
// open-data portal, so we try several official locations and report the status of each. A
// datacentre IP (i.e. GitHub Actions) is also often accepted where a residential one is not, so a
// 403 locally does not mean this is broken in CI.
const CANDIDATE_URLS = [
  "https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv",
  "https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv",
];

// The federal open-data portal runs CKAN, so we can ASK it where the file is rather than guess a
// path (a guessed mirror URL returned 404 — asking the catalogue is what finally located the
// AusTender feed, and the same applies here).
const CKAN_PACKAGE =
  "https://open.canada.ca/data/api/3/action/package_show?id=6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2";

async function discoverViaCatalogue(fetchImpl, log) {
  try {
    const res = await fetchImpl(CKAN_PACKAGE, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = await res.json();
    const resources = data?.result?.resources || [];
    const urls = resources
      .filter((r) => /csv/i.test(`${r.format} ${r.url}`))
      // Open tender notices first: that is the file describing what is currently biddable.
      .sort((a, b) => (/open.?tender/i.test(b.url) ? 1 : 0) - (/open.?tender/i.test(a.url) ? 1 : 0))
      .map((r) => r.url)
      .filter(Boolean);
    if (urls.length) log(`CanadaBuys: catalogue lists ${urls.length} CSV resource(s)`);
    return urls.slice(0, 4);
  } catch {
    return [];
  }
}

function pick(row, ...names) {
  for (const n of names) {
    const v = row[n];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  // tolerate casing / whitespace drift in headers
  const wanted = names.map((n) => n.toLowerCase());
  for (const key of Object.keys(row)) {
    if (wanted.includes(key.trim().toLowerCase())) {
      const v = String(row[key] ?? "").trim();
      if (v) return v;
    }
  }
  return "";
}

/** CanadaBuys multi-valued cells use a leading '*' per value, newline separated: "*GD\n*SRV". */
function multi(value) {
  if (!value) return [];
  return String(value)
    .split(/[\n\r]+/)
    .map((s) => s.trim().replace(/^\*/, "").trim())
    .filter(Boolean);
}

function isoDate(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export async function ingest({ fetchImpl = politeFetch, log = console.log } = {}) {
  const configured = (process.env.CANADABUYS_CSV_URL || "").trim();
  const discovered = configured ? [] : await discoverViaCatalogue(fetchImpl, log);
  // De-duplicate: the catalogue lists the same files we already try by default, and retrying an
  // identical URL wastes seconds and clutters the diagnostics with repeated lines.
  const candidates = [...new Set(configured ? [configured] : [...CANDIDATE_URLS, ...discovered])];
  const attempts = [];
  let res = null;
  let usedUrl = null;

  for (const candidate of candidates) {
    log(`CanadaBuys: trying ${candidate}`);
    try {
      const r = await fetchImpl(candidate, { headers: { accept: "text/csv,application/octet-stream,*/*" } });
      if (r.ok) { res = r; usedUrl = candidate; break; }
      attempts.push(`${candidate} -> HTTP ${r.status}`);
    } catch (err) {
      attempts.push(`${candidate} -> ${err.name}`);
    }
  }

  if (!res) {
    throw new Error(
      `CanadaBuys: no candidate URL returned data.\n    ` + attempts.join("\n    ") +
      `\n  A 403 from a home connection usually means bot protection, not a broken URL — the same ` +
      `fetch often succeeds from GitHub Actions. Try the workflow before concluding it is down, or ` +
      `set CANADABUYS_CSV_URL to the current link from canadabuys.canada.ca (Open data section).`
    );
  }
  log(`CanadaBuys: downloading from ${usedUrl}`);

  const today = new Date().toISOString().slice(0, 10);
  const rows = [];
  let scanned = 0, closed = 0, notOpen = 0, malformed = 0;

  for await (const r of streamCsvRows(res)) {
    scanned++;

    // The data dictionary warns of Excel "spill-over" rows; a real row always has a publication date.
    const published = isoDate(pick(r, "publicationDate-datePublication"));
    if (!published) { malformed++; continue; }

    const status = pick(r, "tenderStatus-appelOffresStatut-eng", "tenderStatus-appelOffresStatut-fra").toLowerCase();
    if (status && !["open", "ouvert"].includes(status)) { notOpen++; continue; }

    const deadline = isoDate(pick(r, "tenderClosingDate-appelOffresDateCloture"));
    if (deadline && deadline < today) { closed++; continue; }

    const gsin = multi(pick(r, "gsin-nibs"));
    const unspsc = multi(pick(r, "unspsc"));
    const solicitation = pick(r, "solicitationNumber-numeroSollicitation", "referenceNumber-numeroReference");

    rows.push(toRow({
      id: solicitation ? `CA-${solicitation}` : "",
      // Include the GSIN description in the title line when the title is terse: GSIN labels are
      // plain English ("Armour, Personal") and are what makes keyword search work here.
      title: pick(r, "title-titre-eng", "title-titre-fra"),
      buyer: pick(r, "endUserEntitiesName-nomEntitesUtilisateurFinal-eng",
                     "contractingEntityName-nomEntitContractante-eng",
                     "endUserEntitiesName-nomEntitesUtilisateurFinal-fra"),
      country: "CAN",
      deadline,
      published,
      codes: [
        ...gsin.map((g) => `GSIN ${g}`),
        ...unspsc.map((u) => `UNSPSC ${u}`),
        pick(r, "gsinDescription-nibsDescription-eng"),
      ].filter(Boolean).join(" · "),
      link: pick(r, "noticeURL-URLavis-eng", "noticeURL-URLavis-fra") ||
            "https://canadabuys.canada.ca/en/tender-opportunities",
    }));
  }

  log(`CanadaBuys: scanned ${scanned} rows -> kept ${rows.length} open ` +
      `(${closed} past deadline, ${notOpen} not open, ${malformed} malformed)`);
  return {
    rows,
    notes: [`scanned ${scanned}`, `closed ${closed}`, `not-open ${notOpen}`, `malformed ${malformed}`],
  };
}
