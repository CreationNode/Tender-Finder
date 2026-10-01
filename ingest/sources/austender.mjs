// Ingest: AusTender — Australian Government current Approaches to Market (ATMs).
//
// An ATM is an open invitation to suppliers (RFT, RFQ, EOI, RFI, RFP) — exactly the "you can bid on
// this" record this tool exists to surface. AusTender publishes an RSS feed of ALL current ATMs.
//
// Why RSS and not the API: api.tenders.gov.au requires an authentication token, and its OCDS data
// is post-award (contract notices), not opportunities. The RSS feed is public, keyless, and carries
// precisely the open pipeline. Licence: AusTender content is published under CC BY 3.0 AU —
// re-confirm on the site's terms page before relying on it commercially.
//
// The exact feed path has moved between AusTender releases, so this DISCOVERS it: it reads the
// Current ATM page and follows the declared RSS <link>, falling back to known paths. Set
// AUSTENDER_RSS_URL to skip discovery entirely.

import { toRow } from "../lib/index-format.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "AUSTENDER";
export const label = "AusTender (Australia federal)";

const ATM_PAGE = "https://www.tenders.gov.au/atm";
const FALLBACK_PATHS = [
  "https://www.tenders.gov.au/public_data/rss/atm.xml",
  "https://www.tenders.gov.au/atm/rss",
  "https://www.tenders.gov.au/Rss/Atm",
];

// data.gov.au runs CKAN, and the feed is catalogued there as "AusTender approaches to market RSS
// feed". Asking the catalogue for the current resource URL is far more durable than guessing paths
// that AusTender has moved between releases.
const CKAN_DATASET = "https://data.gov.au/data/api/3/action/package_show?id=latest-approaches-to-markets-listed-on-austender";

async function discoverViaCatalogue(fetchImpl, log) {
  try {
    const res = await fetchImpl(CKAN_DATASET, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = await res.json();
    const resources = data?.result?.resources || [];
    // Prefer a resource that declares RSS/XML, else anything whose URL looks like a feed.
    const match =
      resources.find((r) => /rss|xml/i.test(`${r.format} ${r.name} ${r.url}`)) || resources[0];
    if (match?.url) {
      log(`AusTender: catalogue lists feed at ${match.url}`);
      return match.url;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function discoverFeedUrl(fetchImpl, log) {
  const configured = (process.env.AUSTENDER_RSS_URL || "").trim();
  if (configured) return { url: configured, how: "configured" };

  const fromCatalogue = await discoverViaCatalogue(fetchImpl, log);
  if (fromCatalogue) return { url: fromCatalogue, how: "data.gov.au catalogue" };

  // Preferred: let the page tell us where its feed is.
  try {
    const res = await fetchImpl(ATM_PAGE, { headers: { accept: "text/html" } });
    if (res.ok) {
      const html = await res.text();
      const m = /<link[^>]+type=["']application\/rss\+xml["'][^>]*href=["']([^"']+)["']/i.exec(html)
             || /<link[^>]+href=["']([^"']+)["'][^>]*type=["']application\/rss\+xml["']/i.exec(html);
      if (m) {
        const href = m[1].startsWith("http") ? m[1] : new URL(m[1], ATM_PAGE).toString();
        log(`AusTender: discovered feed at ${href}`);
        return { url: href, how: "discovered from page" };
      }
    }
  } catch {
    /* fall through to the known paths */
  }
  return { url: null, how: "not discovered", fallbacks: FALLBACK_PATHS };
}

/** Minimal RSS/Atom item extraction. Feeds are simple; a full XML parser would be overkill. */
function parseItems(xml) {
  const items = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    const tag = (name) => {
      const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(block);
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    };
    let link = tag("link");
    if (!link) {
      const m = /<link[^>]+href=["']([^"']+)["']/i.exec(block);
      if (m) link = m[1];
    }
    items.push({
      raw: block,
      title: tag("title"),
      link,
      description: tag("description") || tag("summary"),
      published: tag("pubDate") || tag("updated") || tag("published"),
      guid: tag("guid") || tag("id"),
    });
  }
  return items;
}

function isoDate(value) {
  if (!value) return "";
  const d = new Date(value);
  return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}

const DATE_PATTERN = "\\d{1,2}[-/ ][A-Za-z]{3,9}[-/ ]\\d{4}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}/\\d{1,2}/\\d{4}";

/**
 * Pull the closing date out of the item text. AusTender writes it as "Close Date & Time:", which the
 * first version missed because it only looked for "closing"/"closes" — the notice then carried no
 * deadline at all, so it could neither be pruned when expired nor sorted by urgency.
 */
function extractDeadline(text) {
  const patterns = [
    new RegExp(`clos\\w*[^0-9]{0,30}(${DATE_PATTERN})`, "i"),   // Close Date & Time / Closing / Closes
    new RegExp(`deadline[^0-9]{0,30}(${DATE_PATTERN})`, "i"),
    new RegExp(`(?:due|submission)[^0-9]{0,30}(${DATE_PATTERN})`, "i"),
  ];
  for (const re of patterns) {
    const m = re.exec(text || "");
    if (m) {
      const iso = isoDate(m[1].replace(/-/g, " "));
      if (iso) return iso;
    }
  }
  return "";
}

/**
 * AusTender packs the whole record into one unpunctuated line:
 *   "ATM ID: 25/3151 Agency: Department of Defence Category: Fuels Close Date & Time: 25-Sep-2026…"
 * Matching "agency:" and reading to the end of the line therefore swallowed every following field.
 * Split on "Label:" boundaries instead, so each value ends where the next label begins.
 */
function parseLabelledFields(text) {
  const out = {};
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return out;

  // Detecting labels generically is ambiguous on unpunctuated text: in
  //   "Agency: Department of Defence Category: Fuels"
  // a "capitalised words before a colon" rule reads "Defence Category" as the next label and cuts
  // the value short at "Department of". The feed uses a small, stable set of labels, so match those
  // explicitly — unambiguous, and it degrades to no fields rather than to wrong ones.
  const LABELS = [
    "ATM ID", "Agency", "Category", "Close Date & Time", "Close Date and Time", "Close Date",
    "Publish Date", "ATM Type", "Location", "Description", "Contact", "Panel Arrangement",
    "Multi Agency Access", "Estimated Value",
  ];
  const alt = LABELS.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|");
  const re = new RegExp(`(?:^|\\s)(${alt})\\s*:\\s*`, "gi");

  const marks = [];
  let m;
  while ((m = re.exec(s)) !== null) {
    marks.push({
      label: m[1].replace(/\s+/g, " ").trim().toLowerCase(),
      labelStart: m.index + (m[0].length - m[0].trimStart().length),
      valueStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].labelStart : s.length;
    const value = s.slice(marks[i].valueStart, end).trim().replace(/[,;]$/, "");
    if (value) out[marks[i].label] = value;
  }
  return out;
}

/** The buying entity, however this feed happens to label it. */
function extractBuyer(text) {
  const fields = parseLabelledFields(text);
  for (const key of ["agency", "department", "entity", "organisation", "organization", "buyer"]) {
    if (fields[key]) return fields[key].slice(0, 90);
  }
  return "";
}

// VERIFIED against the live feed (2026-08): each <item> carries ONLY title, link, description,
// guid and pubDate. There is no agency and NO CLOSING DATE. That is a limitation of the feed, not
// of the parsing, and it has one serious consequence: without deadlines these notices can never be
// pruned when they expire, so the index would accumulate dead tenders indefinitely.
//
// The honest mitigation is an age-based expiry: most Australian ATMs close three to five weeks after
// publication, so notices are dropped once their PUBLICATION date passes a configurable age (35
// days; it was 90, which kept two months of closed tenders on show as open). That is
// an assumption, clearly labelled as one — the alternative (fetching each ATM detail page for a real
// closing date) means parsing HTML for 89+ notices per run, which is fragile and a heavier
// imposition on the site than reading its own feed.
const MAX_AGE_DAYS = Number(process.env.AUSTENDER_MAX_AGE_DAYS || 35);

export async function ingest({ fetchImpl = politeFetch, log = console.log } = {}) {
  const { url, how, fallbacks } = await discoverFeedUrl(fetchImpl, log);
  const candidates = url ? [url] : fallbacks;

  let xml = null;
  let usedUrl = null;
  const notes = [`feed ${how}`];

  for (const candidate of candidates) {
    try {
      const res = await fetchImpl(candidate, { headers: { accept: "application/rss+xml, application/xml, text/xml, */*" } });
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 120);
        notes.push(`${candidate}: HTTP ${res.status}${body ? ` — ${body}` : ""}`);
        continue;
      }
      const text = await res.text();
      // Accept every feed dialect: RSS 2.0 (<rss>), Atom (<feed>), and RSS 1.0, which is RDF and
      // opens with <rdf:RDF> — a check for <rss> alone rejects it. Falling back to "does it contain
      // items at all" keeps us working against feeds that wrap themselves in something unexpected.
      const looksLikeFeed = /<(rss|feed|rdf:RDF)\b/i.test(text) || /<(item|entry)\b/i.test(text);
      if (!looksLikeFeed) {
        const head = text.replace(/\s+/g, " ").slice(0, 160);
        notes.push(`${candidate}: HTTP ${res.status}, but the body is not a feed. First bytes: ${head}`);
        continue;
      }
      xml = text; usedUrl = candidate; break;
    } catch (err) {
      notes.push(`${candidate}: ${err.name}`);
    }
  }

  if (!xml) {
    // Include WHY each candidate failed. Listing the URLs without their status codes made this
    // failure undiagnosable — the whole point of these messages is to name the actual cause.
    throw new Error(
      `Could not retrieve the AusTender ATM feed.\n    ` +
      notes.map((n) => n.replace(/^feed /, "")).join("\n    ") +
      `\n  If the status is 403, it is probably bot protection against home connections — the same ` +
      `fetch often succeeds from a datacentre (try the Netlify probe or GitHub Actions).` +
      `\n  Otherwise open ${ATM_PAGE}, copy the RSS link, and set AUSTENDER_RSS_URL.`
    );
  }

  const items = parseItems(xml);
  if (!items.length) throw new Error(`The AusTender feed at ${usedUrl} parsed to zero items — its format may have changed.`);

  // Set AUSTENDER_DEBUG=1 to print one raw item. Field extraction depends on this feed's exact
  // wording, and guessing at it from the outside is how you end up with empty buyers and deadlines.
  if (process.env.AUSTENDER_DEBUG === "1") {
    const firstBlock = (xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/i) || [])[0] || "";
    log("AusTender DEBUG — first raw feed item:\n" + firstBlock.slice(0, 1500));
    log("AusTender DEBUG — parsed first item: " + JSON.stringify(items[0], null, 1).slice(0, 900));
  }

  const today = new Date().toISOString().slice(0, 10);
  const ageCutoff = new Date(Date.now() - MAX_AGE_DAYS * 86400000).toISOString().slice(0, 10);
  const rows = [];
  let expired = 0;
  let tooOld = 0;

  for (const it of items) {
    if (!it.title) continue;
    // Kept in case the feed ever adds these fields; today they yield nothing.
    const deadline = extractDeadline(it.description) || extractDeadline(it.title) || extractDeadline(it.raw);
    if (deadline && deadline < today) { expired++; continue; }
    const publishedIso = isoDate(it.published);
    if (!deadline && publishedIso && publishedIso < ageCutoff) { tooOld++; continue; }
    const id = (it.guid || it.link || it.title).replace(/[^A-Za-z0-9-]/g, "").slice(-24);
    rows.push(toRow({
      id: `AU-${id}`,
      title: it.title,
      // The ATM feed carries the agency inside the description rather than a dedicated field.
      buyer: extractBuyer(it.description) || extractBuyer(it.title),
      country: "AUS",
      deadline,
      published: isoDate(it.published),
      codes: "",
      link: it.link || ATM_PAGE,
    }));
  }

  const withDeadline = rows.filter((r) => r[4]).length;
  log(`AusTender: ${items.length} feed item(s) -> ${rows.length} kept (${expired} past deadline, ${tooOld} older than ${MAX_AGE_DAYS} days) via ${usedUrl}`);
  if (rows.length && withDeadline === 0) {
    log(`AusTender: this feed publishes no closing dates, so notices are retired ${MAX_AGE_DAYS} days after publication (estimate, not data).`);
  }
  notes.push(`url ${usedUrl}`, `items ${items.length}`, `expired ${expired}`, `aged-out ${tooOld}`,
             withDeadline === 0 ? `no closing dates in feed; retired after ${MAX_AGE_DAYS} days` : `${withDeadline} with real deadlines`);
  return { rows, notes };
}
