// Ingest: oeffentlichevergabe.de — Germany's federal notice service (Bekanntmachungsservice).
//
// Since 2024 German buyers publish their notices through this service in eForms, and the
// Beschaffungsamt runs an OpenData interface with keyless daily exports:
//
//   GET https://oeffentlichevergabe.de/api/notice-exports?pubDay=YYYY-MM-DD&format=eforms.zip
//
// VERIFIED from a GitHub runner (2026-10-01): one day (2026-09-30) was a 4.4 MB zip of 1,104 eForms
// XML notices, ~350 of them calls for competition. Most cite an EU directive as legal basis (2014/24,
// 2014/25 ...) and so are also on TED, which this site searches live; only the national ones
// (de-uvgo, de-vob, de-hhr ...: about 35 that day) are kept, so Dutch-style double listings are
// avoided. Set OEV_INCLUDE_EU=1 to keep everything. robots.txt does not exist (the site answers 404).
//
// Each run reads today and yesterday plus any unread day in the last OEV_LOOKBACK_DAYS (default 45),
// within OEV_BUDGET_MS. Notices are keyed by contract folder, applied oldest first, so a later
// result or cancellation notice removes the call for competition.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";
import { unzip } from "../lib/unzip.mjs";

export const source = "OEV";
export const label = "oeffentlichevergabe.de (Germany)";

const API = process.env.OEV_API || "https://oeffentlichevergabe.de/api/notice-exports";
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const block = (xml, tag) => (new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml) || [])[1] || "";
const first = (xml, re) => { const m = re.exec(xml); return m ? decode(m[1]) : ""; };

// Returns { folder, kind, national, row } or null.
export function parseNotice(xml) {
  const type = /<cbc:NoticeTypeCode listName="([^"]+)"[^>]*>([^<]+)</.exec(xml);
  if (!type) return null;
  const folder = first(xml, /<cbc:ContractFolderID>([^<]+)</);
  const noticeId = first(xml, /<cbc:ID schemeName="notice-id">([^<]+)</);
  const domains = [...xml.matchAll(/<cbc:RegulatoryDomain>([^<]+)</g)].map((m) => m[1]);
  // EU legal acts are CELEX numbers (32014L0024); German national rules are "de-..." codes.
  const national = domains.length > 0 && domains.every((d) => !/^3\d{4}[LR]\d{4}$/.test(d));
  const kind = type[1];   // competition, change, result, cont-modif, planning, ...
  if (!folder || !noticeId) return null;

  const project = block(xml, "cac:ProcurementProject");
  const buyerId = first(block(xml, "cac:ContractingParty"), /<cbc:ID[^>]*>([^<]+)</);
  let buyer = "";
  for (const m of xml.matchAll(/<efac:Company>([\s\S]*?)<\/efac:Company>/g)) {
    if (buyerId && m[1].includes(`>${buyerId}<`)) { buyer = first(m[1], /<cac:PartyName>\s*<cbc:Name[^>]*>([^<]+)</); break; }
  }
  const city = first(xml, /<cbc:CityName>([^<]+)</);
  const deadline = first(block(xml, "cac:TenderSubmissionDeadlinePeriod"), /<cbc:EndDate>(\d{4}-\d{2}-\d{2})/);
  const cpv = [...new Set([...xml.matchAll(/<cbc:ItemClassificationCode listName="cpv">(\d{8})</g)].map((m) => m[1]))].slice(0, 6);
  const amt = /<cbc:EstimatedOverallContractAmount currencyID="([A-Z]{3})">([\d.]+)</.exec(xml);
  const docs = first(xml, /<cac:CallForTendersDocumentReference>[\s\S]*?<cbc:URI>([^<]+)</);
  return {
    folder,
    kind,
    national,
    row: toRow({
      id: `DE-${folder}`,
      title: first(project, /<cbc:Name[^>]*>([^<]+)</),
      buyer: buyer && city ? `${buyer} (${city})` : buyer,
      country: "DEU",
      deadline,
      published: first(xml, /<cbc:IssueDate>(\d{4}-\d{2}-\d{2})/),
      codes: [...cpv.map((c) => `CPV ${c}`), amt && Number(amt[2]) > 1 ? `${Math.round(Number(amt[2]))} ${amt[1]}` : ""]
        .filter(Boolean).join(" · "),
      link: /^https?:\/\//.test(docs) ? docs : "https://oeffentlichevergabe.de/ui/de/search",
    }),
  };
}

export async function ingest({ fetchImpl = fetchText, log = console.log, previousRows = [], previousState = {} } = {}) {
  const lookbackDays = Number(process.env.OEV_LOOKBACK_DAYS || 45);
  const budgetMs = Number(process.env.OEV_BUDGET_MS || 6 * 60 * 1000);
  const delayMs = Number(process.env.OEV_DELAY_MS ?? 2000);
  const includeEu = process.env.OEV_INCLUDE_EU === "1";
  const startedAt = Date.now();
  const today = dayOf(startedAt);
  const byId = new Map(previousRows.map((r) => [r[0], r]));
  const notes = [];
  let requests = 0, notices = 0, calls = 0, skippedEu = 0, closed = 0;

  const window = Array.from({ length: lookbackDays }, (_, i) => dayOf(startedAt - i * 864e5));
  const done = new Set((previousState.doneDays || []).filter((d) => window.includes(d) && d < dayOf(startedAt - 864e5)));
  const read = [];   // [day, parsed[]], newest first
  for (const day of window) {
    if (done.has(day)) continue;
    if (Date.now() - startedAt > budgetMs) { notes.push("time budget reached; continues next run"); break; }
    if (requests) await sleep(delayMs);
    requests++;
    let res;
    try { res = await fetchImpl(`${API}?pubDay=${day}&format=eforms.zip`, { binary: true, retries: 1, timeoutMs: 120000 }); }
    catch (err) {
      if (!read.length) throw new Error(`oeffentlichevergabe.de: ${err.message.split(" reading ")[0]} for ${day}`);
      notes.push(`stopped at ${day}: ${err.message.split(" reading ")[0]}`); break;
    }
    if (res.status === 404 || res.status === 204) { done.add(day); continue; }   // no export for that day
    if (!res.ok) {
      if (!read.length) throw new Error(`oeffentlichevergabe.de returned HTTP ${res.status} for ${day}`);
      notes.push(`stopped at ${day}: HTTP ${res.status}`); break;
    }
    const parsed = [];
    for (const f of unzip(res.bytes)) {
      if (!f.name.endsWith(".xml")) continue;
      const n = parseNotice(f.data.toString("utf8"));
      if (n) { parsed.push({ ...n, version: f.name }); notices++; }
    }
    read.push([day, parsed]);
    done.add(day);
  }

  // Apply oldest first, so the newest state of each contract folder wins.
  for (const [, parsed] of read.reverse()) {
    parsed.sort((a, b) => a.version.localeCompare(b.version));
    for (const n of parsed) {
      const key = n.row[0];
      if (n.kind === "competition" || n.kind === "change") {
        if (!n.national && !includeEu) { skippedEu++; continue; }
        if (!n.row[1] || !n.row[4] || n.row[4] < today) continue;
        byId.set(key, n.row);
        calls++;
      } else if (n.kind === "result" || n.kind === "cont-modif" || n.kind === "dir-awa-pre") {
        if (byId.delete(key)) closed++;
      }
    }
  }

  let expired = 0;
  for (const [id, row] of byId) if (row[4] < today) { byId.delete(id); expired++; }
  const rows = [...byId.values()];
  const missing = window.filter((d) => !done.has(d)).length;
  log(`OEV: ${requests} day export(s), ${notices} notices, ${calls} open national calls kept, ${skippedEu} EU-wide left to TED, ${closed} closed, ${expired} expired; index now ${rows.length}; ${missing ? `${missing} day(s) still to backfill` : "backfill complete"}`);
  notes.push(`days ${requests}`, `notices ${notices}`, `kept ${calls}`, `eu skipped ${skippedEu}`, missing ? `${missing} days to backfill` : "backfill complete");
  return { rows, notes, state: { doneDays: [...done].sort(), updatedAt: new Date().toISOString() } };
}
