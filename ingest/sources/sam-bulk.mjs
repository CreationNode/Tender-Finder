// Ingest: SAM.gov Contract Opportunities — DAILY BULK CSV.
//
// Why bulk and not the search API: a non-federal personal API key is limited to roughly TEN
// Get Opportunities requests per DAY. That is two or three user searches — unusable for a public
// site. The bulk extract is ONE request per day and returns the entire active dataset, so the same
// key that could not power a website comfortably powers a whole index.
//
// The download URL lives in SAM.gov -> Data Services -> Contract Opportunities. Paste the exact
// current URL into the SAM_BULK_CSV_URL secret; the default below is a documented form but SAM has
// changed this path before, so treat the env var as authoritative.

import { streamCsvRows } from "../lib/csv.mjs";
import { politeFetch } from "../lib/http.mjs";
import { toRow } from "../lib/index-format.mjs";

export const source = "SAM";
export const label = "SAM.gov (US federal)";

const DEFAULT_URL =
  "https://sam.gov/api/prod/fileextractservices/v1/api/download/Contract%20Opportunities/datagov/ContractOpportunitiesFullCSV.csv?privacy=Public";

// Notice types that are not an invitation to bid.
const NOT_BIDDABLE = /award|justification|sources sought|special notice|sale of surplus|intent to bundle|consolidate/i;
const UNDATED_MAX_DAYS = Number(process.env.SAM_UNDATED_MAX_DAYS || 90);

/** SAM CSVs have used several header spellings over the years; accept any of them. */
function pick(row, ...names) {
  for (const n of names) {
    for (const key of Object.keys(row)) {
      if (key.toLowerCase().replace(/[^a-z]/g, "") === n.toLowerCase().replace(/[^a-z]/g, "")) {
        const v = String(row[key] ?? "").trim();
        if (v) return v;
      }
    }
  }
  return "";
}

function parseDate(value) {
  if (!value) return "";
  // SAM mixes ISO and US formats across columns and eras.
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(value);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  const d = new Date(value);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

export async function ingest({ fetchImpl = politeFetch, log = console.log } = {}) {
  const apiKey = (process.env.SAM_API_KEY || "").trim();
  const base = (process.env.SAM_BULK_CSV_URL || DEFAULT_URL).trim();
  if (!apiKey) {
    // Name every way of setting it: the old message only mentioned GitHub secrets, which is useless
    // advice to someone testing on their own machine.
    throw new Error(
      "SAM_API_KEY is not set.\n" +
      "    Locally (one-off):  $env:SAM_API_KEY = \"your-key\"   [PowerShell]\n" +
      "    Locally (persistent): put SAM_API_KEY=your-key in a .env file at the project root\n" +
      "    In CI: add SAM_API_KEY as a GitHub Actions repository secret\n" +
      "    Get a key at https://sam.gov/workspace/profile/account-details (Public API Key)"
    );
  }

  const url = base + (base.includes("?") ? "&" : "?") + "api_key=" + encodeURIComponent(apiKey);
  log(`SAM: downloading bulk extract…`);

  // HTTP 406 ("Not Acceptable") means the server cannot satisfy our Accept header — nothing to do
  // with the key or the URL. SAM's file service is picky here, so try the permissive form first and
  // fall back to sending no Accept at all.
  let res = null;
  const acceptVariants = ["*/*", "text/csv,application/octet-stream,*/*", null];
  for (const accept of acceptVariants) {
    const attempt = await fetchImpl(url, { headers: accept ? { accept } : {} });
    if (attempt.status !== 406) { res = attempt; break; }
    log(`SAM: HTTP 406 with Accept: ${accept ?? "(none)"} — retrying with a different Accept header`);
    res = attempt;
  }
  if (res.status === 401 || res.status === 403) {
    // A 403 can mean two very different things, and blaming the key for a network block sends
    // someone off rotating a perfectly good credential. SAM's own rejections come back as JSON or
    // plain text mentioning the key; a corporate proxy, firewall or CDN block returns an HTML page.
    const body = (await res.text().catch(() => "")).slice(0, 400);
    const looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);
    const mentionsKey = /api[_ -]?key|unauthorized|forbidden for user|invalid/i.test(body);

    if (looksLikeHtml && !mentionsKey) {
      throw new Error(
        `SAM returned HTTP ${res.status} with an HTML page rather than an API error.\n` +
        `    That is usually a NETWORK block (proxy, firewall, VPN or geo-restriction) rather than a\n` +
        `    bad key — the key was accepted or never reached SAM at all.\n` +
        `    Try from a different connection, or run the ingestion in GitHub Actions.\n` +
        `    First bytes: ${body.replace(/\s+/g, " ").slice(0, 160)}`
      );
    }
    throw new Error(
      `SAM returned HTTP ${res.status}: the API key was rejected or has EXPIRED.\n` +
      `    Keys rotate about every 90 days — collect the replacement from\n` +
      `    https://sam.gov/workspace/profile/account-details (Public API Key).\n` +
      `    Response: ${body.replace(/\s+/g, " ").slice(0, 200)}`
    );
  }
  if (res.status === 406) {
    throw new Error(
      `SAM returned HTTP 406 for every Accept header tried.\n` +
      `    406 means the server will not serve this URL in any format we asked for — usually the URL\n` +
      `    points at an HTML page rather than the file itself.\n` +
      `    Get the real download link: SAM.gov > Data Services > Contract Opportunities, right-click\n` +
      `    the CSV download and copy the address, then put it in .env as SAM_BULK_CSV_URL.`
    );
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200);
    throw new Error(
      `SAM returned HTTP ${res.status} for the bulk extract.\n` +
      `    URL: ${url.replace(/api_key=[^&]+/g, "api_key=***")}\n` +
      `    ${body ? "Response: " + body : "No response body."}\n` +
      `    Verify SAM_BULK_CSV_URL against SAM.gov > Data Services > Contract Opportunities.`
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  // A notice with no response date (most presolicitations) is kept while it is recent; after this
  // many days it is assumed stale rather than shown as open forever.
  const undatedCutoff = new Date(Date.now() - UNDATED_MAX_DAYS * 864e5).toISOString().slice(0, 10);
  const bySolicitation = new Map();
  let scanned = 0;
  let closed = 0;
  let inactive = 0;
  let notBiddable = 0;
  let undatedOld = 0;
  let merged = 0;

  for await (const r of streamCsvRows(res)) {
    scanned++;
    const active = pick(r, "Active").toLowerCase();
    if (active === "no") { inactive++; continue; }

    // Award notices, justifications (J&A), sources sought and special notices are not invitations to
    // bid; they made up a large share of the old index and read as open tenders.
    const type = pick(r, "Type", "BaseType");
    if (NOT_BIDDABLE.test(type)) { notBiddable++; continue; }

    // Only the response deadline counts. ArchiveDate is when SAM hides the notice, often weeks after
    // bids close, and using it showed closed solicitations as open.
    const deadline = parseDate(pick(r, "ResponseDeadLine", "Response Deadline"));
    const published = parseDate(pick(r, "PostedDate", "Posted Date"));

    const noticeId = pick(r, "NoticeId", "Notice Id");
    const psc = pick(r, "ClassificationCode", "Classification Code", "PSC");
    const naics = pick(r, "NaicsCode", "Naics Code", "NAICS");
    const buyer = pick(r, "Department/Ind.Agency", "Department", "FullParentPathName", "Sub-Tier");

    const row = toRow({
      id: noticeId ? `SAM-${noticeId}` : "",
      title: pick(r, "Title"),
      buyer,
      country: "USA",
      deadline,
      published,
      codes: [psc && `PSC ${psc}`, naics && `NAICS ${naics}`].filter(Boolean).join(" · "),
      link: pick(r, "Link", "UiLink") || (noticeId ? `https://sam.gov/opp/${noticeId}/view` : "https://sam.gov/search/"),
    });

    // Every amendment of a solicitation is its own row in the extract, with its own NoticeId. Keep
    // one row per solicitation number (per buyer, since numbers are only unique within an agency):
    // the most recently posted one, which carries the current deadline. The open/closed check runs
    // after this, on that latest version, so an old amendment can't keep a closed solicitation alive.
    const sol = pick(r, "Sol#", "Solicitation Number", "SolicitationNumber").toUpperCase();
    const key = sol ? `${buyer.toLowerCase()}|${sol}` : `id|${noticeId || scanned}`;
    const prev = bySolicitation.get(key);
    if (!prev || (published || "") >= (prev.published || "")) bySolicitation.set(key, { row, published, deadline });
    else merged++;
    if (prev && (published || "") >= (prev.published || "")) merged++;
  }

  const rows = [];
  for (const { row, published, deadline } of bySolicitation.values()) {
    if (deadline && deadline < today) { closed++; continue; }   // only open notices are opportunities
    if (!deadline && published && published < undatedCutoff) { undatedOld++; continue; }
    rows.push(row);
  }
  log(`SAM: scanned ${scanned} rows -> kept ${rows.length} open (${closed} closed, ${inactive} inactive, ` +
      `${notBiddable} not invitations to bid, ${undatedOld} undated and old, ${merged} older amendments merged)`);
  return {
    rows,
    notes: [`scanned ${scanned}`, `closed dropped ${closed}`, `inactive dropped ${inactive}`,
            `not biddable dropped ${notBiddable}`, `undated older than ${UNDATED_MAX_DAYS} days dropped ${undatedOld}`,
            `amendments merged ${merged}`],
  };
}
