// Ingest: Doffin — Norway's national procurement notice database (run by DFØ).
//
//   GET https://api.doffin.no/public/v2/search?status=ACTIVE&numHitsPerPage=100&page=N
//   header Ocp-Apim-Subscription-Key: DOFFIN_API_KEY   (free key from DFØ's developer portal)
//
// VERIFIED from a GitHub runner (2026-10-01): JSON; status=ACTIVE gave 1,050 notices with CPV codes,
// buyer, deadline and heading. A query only reaches its first 1,000 hits (numHitsAccessible), so
// when there are more, the oldest are read with the opposite sort order. The gateway allows about
// 30 requests a window (X-RateLimit-Remaining), so requests are spaced (DOFFIN_DELAY_MS, 2.5 s).
// doffin.no's robots.txt disallows nothing.
//
// Doffin lists Norwegian notices above and below the EEA threshold; the larger ones also appear on
// TED, which carries no Doffin cross-reference, so those can show twice for Norway.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "DOFFIN";
export const label = "Doffin (Norway)";

const API = process.env.DOFFIN_API || "https://api.doffin.no/public/v2/search";
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")) || [])[1] || "";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function toNoticeRow(h) {
  const cpv = [...new Set((h.cpvCodes || []).map((c) => (/^(\d{8})/.exec(String(c)) || [])[1]).filter(Boolean))].slice(0, 6);
  const value = Number(h.estimatedValue?.amount ?? h.estimatedValue);
  const currency = h.estimatedValue?.currencyCode || "NOK";
  return toRow({
    id: h.id ? `NO-${h.id}` : "",
    title: clean(h.heading),
    buyer: clean((h.buyer || []).map((b) => b.name).filter(Boolean).join(", ")),
    country: "NOR",
    deadline: isoDate(h.deadline),
    published: isoDate(h.publicationDate || h.issueDate),
    codes: [...cpv.map((c) => `CPV ${c}`), value > 1 ? `${Math.round(value)} ${currency}` : ""].filter(Boolean).join(" · "),
    link: h.id ? `https://doffin.no/notices/${h.id}` : "https://doffin.no/",
  });
}

export async function ingest({ fetchImpl = fetchText, log = console.log } = {}) {
  const key = (process.env.DOFFIN_API_KEY || "").trim();
  if (!key) throw new Error("DOFFIN_API_KEY is not set (GitHub secret DOFFIN_API_KEY, or .env locally)");
  const delayMs = Number(process.env.DOFFIN_DELAY_MS ?? 2500);
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map();
  let requests = 0, hits = 0, skipped = 0, total = 0;
  const notes = [];

  async function page(n, sortBy) {
    if (requests) await sleep(delayMs);
    requests++;
    const url = `${API}?status=ACTIVE&numHitsPerPage=100&page=${n}${sortBy ? `&sortBy=${sortBy}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { headers: { accept: "application/json", "Ocp-Apim-Subscription-Key": key }, retries: 1, timeoutMs: 60000 });
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(res.retryAfter || 60, 120);
        log(`Doffin: rate limited; waiting ${wait} s`);
        await sleep(wait * 1000);
        continue;
      }
      if (!res.ok) throw new Error(`Doffin returned HTTP ${res.status} on page ${n}${res.status === 401 ? " (check DOFFIN_API_KEY)" : ""}`);
      return JSON.parse(res.text || "{}");
    }
  }

  function take(list) {
    let fresh = 0;
    for (const h of list || []) {
      hits++;
      const row = toNoticeRow(h);
      // Active pre-announcements and market dialogues have no tender deadline: not biddable yet.
      if (!row[0] || !row[1] || !row[4] || row[4] < today) { skipped++; continue; }
      if (!byId.has(row[0])) fresh++;
      byId.set(row[0], row);
    }
    return fresh;
  }

  async function sweep(sortBy) {
    for (let n = 1; n <= 10; n++) {
      const body = await page(n, sortBy);
      total = Number(body.numHitsTotal) || total;
      take(body.hits);
      if (!body.hits?.length || n * 100 >= Math.min(total, Number(body.numHitsAccessible) || 1000)) break;
    }
  }

  await sweep("PUBLICATION_DATE_DESC");
  if (total > 1000) {
    const before = byId.size;
    await sweep("PUBLICATION_DATE_ASC");
    notes.push(`${total} active; reached the oldest with a second, ascending sweep (+${byId.size - before})`);
  }

  const rows = [...byId.values()];
  log(`Doffin: ${requests} request(s), ${total} active notices, ${hits} hits read, ${skipped} without an open deadline; index now ${rows.length}`);
  notes.push(`requests ${requests}`, `active ${total}`, `kept ${rows.length}`);
  return { rows, notes, state: { updatedAt: new Date().toISOString() } };
}
