// Ingest: NSPA, the NATO Support and Procurement Agency (Capellen, Luxembourg).
//
// NSPA publishes its eProcurement opportunities as one XML file "to meet the requirements of our
// partners' information systems", documented in eProcurementXMLFileEN.pdf (06 June 2018) and
// refreshed hourly:
//
//   GET https://eportal.nspa.nato.int/eProcurement/XML/eProcurementData.xml   (about 220 KB)
//
// eportal.nspa.nato.int has no robots.txt (404). One request a day is all this needs.
//
// VERIFIED from a GitHub runner (2026-11-14): HTTP 200, 76 <RFPItem> (open requests for proposals,
// each with a closing date), 333 <FBOItem> (future business opportunities, many years old with no
// closing date) and no <NOIItem>. Only RFPs are kept: an FBO is an announcement that an RFP may
// follow, not something a supplier can bid on yet.
//
// Titles are English and carry no classification codes, so rows match on words only. NSPA's
// tenders are open only to firms from NATO member countries registered in its source file; the
// site says so under "Read before you bid".

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "NSPA";
export const label = "NSPA (NATO)";

const URL_XML = process.env.NSPA_XML_URL || "https://eportal.nspa.nato.int/eProcurement/XML/eProcurementData.xml";
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) =>
      e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()])
    .replace(/\s+/g, " ")
    .trim();
}

const field = (xml, tag) => decode((new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml) || [])[1]);
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(v || "") || [])[1] || "";

/** Parse the XML text into index rows for the RFPs still open on `today` (YYYY-MM-DD). */
export function parseRfps(xml, today) {
  const rows = [];
  let total = 0, closed = 0;
  for (const m of String(xml).matchAll(/<RFPItem>([\s\S]*?)<\/RFPItem>/g)) {
    total++;
    const it = m[1];
    const ref = field(it, "CollectiveNumber");
    const title = field(it, "Title");
    const deadline = isoDate(field(it, "RFPClosingDate"));
    if (!title || !deadline || deadline < today) { closed++; continue; }
    const link = field(it, "DetailsPage");
    rows.push(toRow({
      id: `NSPA-${ref || field(it, "OpportunityCrossTableID")}`,
      title: ref ? `${title} (${ref})` : title,
      buyer: "NATO NSPA",   // short on purpose: a buyer name with "support" or "procurement" would match every row
      country: "INT",
      deadline,
      published: isoDate(field(it, "PublicationDate")),
      codes: "",
      link: /^https:\/\/eportal\.nspa\.nato\.int\//.test(link) ? link : "https://eportal.nspa.nato.int/eProcurement5G/Opportunities/OpportunitiesList",
    }));
  }
  return { rows, total, closed };
}

export async function ingest({ fetchImpl = fetchText, log = console.log } = {}) {
  const res = await fetchImpl(URL_XML, { headers: { accept: "application/xml,text/xml" }, retries: 2, timeoutMs: 60000 });
  if (!res.ok) throw new Error(`NSPA XML returned HTTP ${res.status}`);
  if (!/<eProcurementData[\s>]/.test(res.text)) throw new Error("NSPA XML has no <eProcurementData> root; the format may have changed");
  const today = new Date().toISOString().slice(0, 10);
  const { rows, total, closed } = parseRfps(res.text, today);
  const fbo = (res.text.match(/<FBOItem>/g) || []).length;
  log(`NSPA: ${total} RFPs in the file, ${rows.length} open, ${closed} closed or undated; ${fbo} future opportunities not indexed`);
  return { rows, notes: [`rfps ${total}`, `open ${rows.length}`, `fbo skipped ${fbo}`], state: { updatedAt: new Date().toISOString() } };
}
