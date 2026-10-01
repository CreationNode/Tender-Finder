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
console.log("DOFFIN sample:", JSON.stringify(first).slice(0, 1500));
const tally = (f) => { const m = {}; for (const h of doffin) { const k = JSON.stringify(f(h)); m[k] = (m[k] || 0) + 1; } return m; };
for (const k of Object.keys(first || {})) {
  const vals = new Set(doffin.map((h) => JSON.stringify(h[k])));
  if (vals.size <= 12) console.log(`DOFFIN field ${k}:`, JSON.stringify(tally((h) => h[k])));
}

// ---- TED, Norwegian buyers, published in the last 200 days
const since = new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10).replace(/-/g, "");
const ted = []; let tedTotal = 0;
for (let page = 1; page <= 40; page++) {
  const res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `buyer-country IN (NOR) AND publication-date>=${since} SORT BY publication-number DESC`,
      fields: ["publication-number", "notice-title", "buyer-name", "deadline-receipt-tender-date-lot", "notice-type", "publication-date"],
      limit: "250", page, onlyLatestVersions: false }) });
  if (!res.ok) { console.log("TED HTTP", res.status, (await res.text()).slice(0, 300)); break; }
  const b = await res.json(); tedTotal = b.totalNoticeCount;
  ted.push(...(b.notices || []));
  if ((b.notices || []).length < 250) break;
  await sleep(1000);
}
const tedOpen = ted.filter((n) => d10(n["deadline-receipt-tender-date-lot"]) >= today);
console.log(`TED NOR notices since ${since}: total ${tedTotal}, read ${ted.length}, open-deadline ${tedOpen.length}`);
const nt = {}; for (const n of tedOpen) nt[n["notice-type"]] = (nt[n["notice-type"]] || 0) + 1; console.log("TED open by notice-type", JSON.stringify(nt));
if (tedOpen[0]) console.log("TED sample:", JSON.stringify(tedOpen[0]).slice(0, 1200));

// ---- matching
const toks = (s) => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
const ov = (a, b) => { if (!a.size || !b.size) return 0; let h = 0; for (const t of a) if (b.has(t)) h++; return h / Math.min(a.size, b.size); };
const nob = (t) => (t && typeof t === "object") ? normaliseText(t.nor || t.nob || t.nno || t.NOR || "") : "";
const dNotices = doffin.map((h) => ({ id: "NO-" + h.id, title: h.heading, buyer: (h.buyer || []).map((b) => b.name).join(", "), country: "NOR", deadline: d10(h.deadline), source: "DOFFIN" }));
const tNotices = tedOpen.map((n) => ({ id: "TED-" + n["publication-number"], title: normaliseText(n["notice-title"]), titleNo: nob(n["notice-title"]),
  buyer: normaliseText(n["buyer-name"]), country: "NOR", deadline: d10(n["deadline-receipt-tender-date-lot"]), source: "TED" }));
const viaDedupe = dNotices.length + tNotices.length - dedupe([...tNotices.map((t) => ({ ...t })), ...dNotices.map((d) => ({ ...d }))]).length;
let byNo = 0, loose = 0; const missed = [];
for (const t of tNotices) {
  const sameDay = dNotices.filter((d) => d.deadline === t.deadline);
  if (sameDay.some((d) => ov(toks(d.title), toks(t.titleNo)) >= 0.7)) byNo++;
  const l = sameDay.find((d) => ov(toks(d.title), toks(t.titleNo || t.title)) >= 0.5 || ov(toks(d.buyer), toks(t.buyer)) >= 0.6);
  if (l) { loose++; if (missed.length < 6) missed.push({ ted: t.title, tedNo: t.titleNo, doffin: l.title, tb: t.buyer, db: l.buyer, dl: t.deadline }); }
}
console.log(`MATCH current dedupe merges ${viaDedupe}; Norwegian-title match ${byNo}; loose (same deadline + title or buyer) ${loose} of ${tNotices.length} open TED NOR`);
const tedWithNo = tNotices.filter((t) => t.titleNo).length; console.log(`TED open with a Norwegian title: ${tedWithNo}`);
for (const m of missed) console.log("PAIR", JSON.stringify(m));
