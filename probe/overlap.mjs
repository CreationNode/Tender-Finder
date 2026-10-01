// Temporary probe: how many open Doffin notices are also open on TED, and does dedupe() catch them?
import { dedupe, normaliseText } from "../netlify/lib/sources/contract.js";
const key = (process.env.DOFFIN_API_KEY || "").trim();
const today = new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const d10 = (v) => (/(\d{4}-\d{2}-\d{2})/.exec(String(Array.isArray(v) ? v[0] : v || "")) || [])[1] || "";

// ---- Doffin, raw
const raw = new Map(); let total = 0, reqs = 0, first = null;
async function sweep(sortBy) {
  for (let n = 1; n <= 10; n++) {
    if (reqs++) await sleep(2500);
    const res = await fetch(`https://api.doffin.no/public/v2/search?status=ACTIVE&numHitsPerPage=100&page=${n}&sortBy=${sortBy}`,
      { headers: { accept: "application/json", "Ocp-Apim-Subscription-Key": key } });
    if (!res.ok) { console.log("doffin HTTP", res.status); return; }
    const b = await res.json(); total = b.numHitsTotal;
    for (const h of b.hits || []) { first ||= h; raw.set(h.id, h); }
    if (!b.hits?.length || n * 100 >= Math.min(total, b.numHitsAccessible || 1000)) break;
  }
}
await sweep("PUBLICATION_DATE_DESC"); if (total > 1000) await sweep("PUBLICATION_DATE_ASC");
const doffin = [...raw.values()].filter((h) => d10(h.deadline) >= today);
console.log(`DOFFIN active ${total}, read ${raw.size}, open-deadline ${doffin.length}`);
console.log("DOFFIN hit keys:", Object.keys(first || {}).join(","));

const tally = (f) => { const m = {}; for (const h of doffin) { const k = JSON.stringify(f(h)); m[k] = (m[k] || 0) + 1; } return m; };
for (const k of []) {
  const vals = new Set(doffin.map((h) => JSON.stringify(h[k])));
  if (vals.size <= 12) console.log(`DOFFIN field ${k}:`, JSON.stringify(tally((h) => h[k])));
}

// ---- TED, Norwegian buyers, open calls for competition, paced to stay under TED's rate limit
const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
const qs = [
  `buyer-country IN (NOR) AND notice-type IN (cn-standard cn-social cn-desg) AND deadline-receipt-tender-date-lot>=${today.replace(/-/g, "")}`,
  `buyer-country IN (NOR) AND notice-type IN (cn-standard cn-social cn-desg) AND publication-date>=${since}`,
];
const tedMap = new Map(); let tedTotal = 0, usedQ = "";
for (const q of qs) {
  let ok = true;
  for (let page = 1; page <= 40; page++) {
    let res;
    for (let a = 0; a < 4; a++) {
      res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, fields: ["publication-number", "notice-title", "buyer-name", "deadline-receipt-tender-date-lot", "notice-type", "procedure-identifier"],
          limit: "250", page, onlyLatestVersions: false }) });
      if (res.status !== 429) break;
      console.log("TED 429, waiting 30 s"); await sleep(30000);
    }
    if (!res.ok) { console.log("TED HTTP", res.status, q, (await res.text()).slice(0, 200)); ok = page > 1; break; }
    const b = await res.json(); tedTotal = b.totalNoticeCount;
    for (const n of b.notices || []) tedMap.set(n["publication-number"], n);
    if ((b.notices || []).length < 250) break;
    await sleep(4000);
  }
  if (ok && tedMap.size) { usedQ = q; break; }
}
const ted = [...tedMap.values()];
const tedOpen = ted.filter((n) => [].concat(n["deadline-receipt-tender-date-lot"] || []).some((d) => d10(d) >= today));
console.log(`TED query: ${usedQ}\nTED total ${tedTotal}, read ${ted.length}, open-deadline ${tedOpen.length}`);
const procs = new Set(tedOpen.map((n) => JSON.stringify(n["procedure-identifier"] || n["publication-number"])));
console.log(`TED open distinct procedures: ${procs.size}`);

// ---- matching
const toks = (s) => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
const ov = (a, b) => { if (!a.size || !b.size) return 0; let h = 0; for (const t of a) if (b.has(t)) h++; return h / Math.min(a.size, b.size); };
const dNotices = doffin.map((h) => ({ id: "NO-" + h.id, title: h.heading, buyer: (h.buyer || []).map((b) => b.name).join(", "), country: "NOR", deadline: d10(h.deadline), source: "DOFFIN" }));
const tNotices = tedOpen.map((n) => ({ id: "TED-" + n["publication-number"], title: normaliseText(n["notice-title"]),
  buyer: normaliseText(n["buyer-name"]), country: "NOR", deadline: d10(n["deadline-receipt-tender-date-lot"]), source: "TED" }));
// What search() would do: TED results first, then Doffin; count merges that join a TED and a Doffin record.
const merged = dedupe([...tNotices.map((t) => ({ ...t })), ...dNotices.map((d) => ({ ...d }))]);
const cross = merged.filter((m) => m.source === "TED" && (m.alsoOn || []).includes("DOFFIN")).length;
console.log(`DEDUPE cross-source merges: ${cross} (records in ${dNotices.length + tNotices.length}, out ${merged.length})`);
// Likely the same tender: same deadline and same buyer.
const matchedD = new Set(); let strict = 0; const pairs = [];
for (const t of tNotices) {
  const d = dNotices.find((d) => d.deadline === t.deadline && ov(toks(d.buyer), toks(t.buyer)) >= 0.6);
  if (d) { strict++; matchedD.add(d.id); if (pairs.length < 4) pairs.push({ ted: t.title, doffin: d.title, dl: t.deadline }); }
}
console.log(`STRICT same deadline + same buyer: ${strict} of ${tNotices.length} open TED notices; ${matchedD.size} of ${dNotices.length} open Doffin notices`);
const byType = {}; for (const h of doffin) if (matchedD.has("NO-" + h.id)) byType[h.type] = (byType[h.type] || 0) + 1; console.log("matched Doffin by type", JSON.stringify(byType));
for (const p of pairs) console.log("PAIR", JSON.stringify(p));
