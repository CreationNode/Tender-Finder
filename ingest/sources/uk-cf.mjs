// Ingest: UK Contracts Finder — BELOW-threshold UK notices.
//
// This is the more valuable of the two UK sources for the audience this tool serves: Contracts
// Finder carries the smaller contracts (from £12k central government / £30k wider public sector)
// that a small supplier can realistically win, and which never appear on TED or FTS.
//
// Read from the v2 search API (POST /api/rest/2/search_notices/json) asking for every notice of type
// Contract with status Open. One request returns all of them (512 notices, 1.7 MB on 2026-10-01), so
// each run is a full snapshot and nothing can be missed between runs. The OCDS Search endpoint used
// before returned about 20 releases per two-day window and no next-page link, so the index held 114
// of the 512 open notices (both checked from a GitHub runner, 2026-10-01).
// Licence: Open Government Licence v3. Auth: none.

import { ingestHeaders } from "../lib/http.mjs";
import { toRow } from "../lib/index-format.mjs";

export const source = "UK-CF";
export const label = "Contracts Finder (UK, below threshold)";

const API = process.env.CF_API || "https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json";
const SITE = "https://www.contractsfinder.service.gov.uk";
const SIZE = Number(process.env.CF_SIZE || 1000);

function isoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

// A notice page lives at /Notice/<notice GUID>; /notice/<ocid> is "Page not found" (checked from a
// GitHub runner, 2026-10-01).
export function noticeLink(item) {
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(item?.id || "")) ? item.id : "";
  return guid ? `${SITE}/Notice/${guid}` : `${SITE}/Search`;
}

export function itemToRow(item) {
  const cpv = [...new Set(String(item.cpvCodes || "").split(/[\s,]+/).filter((c) => /^\d{8}$/.test(c)))].slice(0, 6);
  const value = Number(item.valueHigh) || Number(item.valueLow) || 0;
  return toRow({
    // The GUID, not the OCID: the v2 API doesn't return OCIDs, so rows from the old crawler
    // (UKCF-ocds-…) are simply replaced by this snapshot.
    id: item.id ? `UKCF-${item.id}` : "",
    title: String(item.title || "").trim(),
    buyer: String(item.organisationName || "").trim(),
    country: "GBR",
    deadline: isoDate(item.deadlineDate),
    published: isoDate(item.publishedDate),
    codes: [...cpv.map((c) => `CPV ${c}`), value > 1 ? `${Math.round(value)} GBP` : ""].filter(Boolean).join(" · "),
    link: noticeLink(item),
  });
}

async function post(fetchImpl, body, timeoutMs) {
  const res = await fetchImpl(API, {
    method: "POST",
    headers: ingestHeaders({ "content-type": "application/json", accept: "application/json" }),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Contracts Finder returned HTTP ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 160)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error(`Contracts Finder sent something other than JSON: ${text.slice(0, 120)}`); }
  if (!Array.isArray(data.noticeList)) throw new Error(`Contracts Finder reply has no noticeList (keys: ${Object.keys(data).join(",")})`);
  return data;
}

export async function ingest({ fetchImpl = fetch, log = console.log } = {}) {
  const timeoutMs = Number(process.env.CF_TIMEOUT_MS || 120000);
  const today = new Date().toISOString().slice(0, 10);
  log("Contracts Finder: reading every open notice from the v2 search API");

  let data;
  for (let attempt = 1; ; attempt++) {
    try { data = await post(fetchImpl, { searchCriteria: { types: ["Contract"], statuses: ["Open"] }, size: SIZE }, timeoutMs); break; }
    catch (err) {
      if (attempt >= 3) throw err;
      log(`Contracts Finder: ${err.message} (attempt ${attempt}); retrying`);
      await new Promise((r) => setTimeout(r, 10000 * attempt));
    }
  }

  const notes = [];
  const hitCount = Number(data.hitCount);
  if (Number.isFinite(hitCount) && hitCount > data.noticeList.length) {
    // Never silently partial: if Contracts Finder ever has more open notices than one reply holds,
    // say so in the manifest so it can be paged.
    notes.push(`only ${data.noticeList.length} of ${hitCount} open notices returned; raise CF_SIZE or add paging`);
  }

  const byId = new Map();
  let untitled = 0, closed = 0;
  for (const n of data.noticeList) {
    const item = n?.item || {};
    if (String(item.noticeStatus || "Open") !== "Open") { closed++; continue; }
    const row = itemToRow(item);
    if (!row[0]) continue;
    if (!row[1]) { untitled++; continue; }
    if (row[4] && row[4] < today) { closed++; continue; }
    byId.set(row[0], row);
  }

  const rows = [...byId.values()];
  log(`Contracts Finder: ${data.noticeList.length} notice(s) returned of ${hitCount}; ${rows.length} open kept, ${closed} closed, ${untitled} untitled`);
  notes.push(`returned ${data.noticeList.length}`, `hit count ${hitCount}`, `kept ${rows.length}`);
  return { rows, notes, state: { updatedAt: new Date().toISOString() } };
}
