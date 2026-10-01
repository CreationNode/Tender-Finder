// Temporary probe: how many open Doffin notices are also open on TED, and does dedupe() catch them?
import { dedupe, normaliseText } from "../fix/netlify/lib/sources/contract.js";
import { toNotice } from "../fix/netlify/lib/sources/ted.js";
const FIX_TED = await import("node:fs").then((fs) => fs.readFileSync(new URL("../fix/netlify/lib/sources/ted.js", import.meta.url), "utf8"));
const FIELDS = eval(/const FIELDS = (\[[\s\S]*?\]);/.exec(FIX_TED)[1]);
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

// ---- TED: first, the live search payload with the new field list must still work
{
  const res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: `(classification-cpv IN (90620000)) AND buyer-country IN (NOR) AND publication-date>=20260101 SORT BY publication-number DESC`,
      limit: "40", scope: "ACTIVE", checkQuerySyntax: false, paginationMode: "ITERATION", onlyLatestVersions: false, fields: FIELDS }) });
  const t = await res.text();
  console.log(`LIVE-PAYLOAD HTTP ${res.status}; ${t.slice(0, 300).replace(/\s+/g, " ")}`);
  await sleep(4000);
}
const tedAll = []; let token = null, tedTotal = 0;
for (let i = 0; i < 20; i++) {
  let res;
  for (let a = 0; a < 4; a++) {
    res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query: `buyer-country IN (NOR) AND publication-date>=20250101 SORT BY publication-number DESC`, limit: "250", scope: "ACTIVE",
        checkQuerySyntax: false, paginationMode: "ITERATION", onlyLatestVersions: false, fields: FIELDS, ...(token ? { iterationNextToken: token } : {}) }) });
    if (res.status !== 429) break;
    console.log("TED 429, waiting 30 s"); await sleep(30000);
  }
  if (!res.ok) { console.log("TED HTTP", res.status, (await res.text()).slice(0, 200)); break; }
  const b = await res.json(); tedTotal = b.totalNoticeCount ?? tedTotal;
  tedAll.push(...(b.notices || []));
  token = b.iterationNextToken; if (!token || !(b.notices || []).length) break;
  await sleep(4000);
}
const tNotices = tedAll.map(toNotice).filter((n) => n.deadline >= today);
console.log(`TED ACTIVE NOR: total ${tedTotal}, read ${tedAll.length}, open ${tNotices.length}, with procedure ${tNotices.filter((n) => n.procedure).length}, distinct procedures ${new Set(tNotices.map((n) => n.procedure || n.id)).size}`);
const procCount = {}; for (const n of tNotices) if (n.procedure) procCount[n.procedure] = (procCount[n.procedure] || 0) + 1;
const multi = Object.entries(procCount).filter(([, c]) => c > 1);
console.log(`TED procedures with >1 open notice: ${multi.length}`);
for (const [p] of multi.slice(0, 3)) console.log("VERSIONS", JSON.stringify(tNotices.filter((n) => n.procedure === p).map((n) => [n.id, n.title.slice(0, 60), n.deadline, n.published])));

// ---- matching with the new dedupe
const toks = (s) => new Set(String(s || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
const ov = (a, b) => { if (!a.size || !b.size) return 0; let h = 0; for (const t of a) if (b.has(t)) h++; return h / Math.min(a.size, b.size); };
const dNotices = doffin.map((h) => ({ id: "NO-" + h.id, title: h.heading, buyer: (h.buyer || []).map((b) => b.name).join(", "), country: "NOR", deadline: d10(h.deadline), source: "DOFFIN" }));
// How often does one buyer close two different Doffin tenders on the same day? (the ambiguous case)
const slot = {}; for (const d of dNotices) { const k = d.deadline + "|" + d.buyer.toLowerCase(); slot[k] = (slot[k] || 0) + 1; }
const shared = Object.values(slot).filter((c) => c > 1).reduce((a, c) => a + c, 0);
console.log(`DOFFIN notices sharing buyer+deadline with another Doffin notice: ${shared} of ${dNotices.length}`);
const merged = dedupe([...tNotices.map((t) => ({ ...t })), ...dNotices.map((d) => ({ ...d }))]);
const cross = merged.filter((m) => m.source === "TED" && (m.alsoOn || []).includes("DOFFIN"));
console.log(`NEW DEDUPE: in TED ${tNotices.length} + Doffin ${dNotices.length} = ${tNotices.length + dNotices.length}; out ${merged.length}; TED records also on Doffin ${cross.length}`);
// Spot-check merged pairs for wrong merges: show 8 at random with the Doffin title they absorbed.
const absorbed = dNotices.filter((d) => !merged.some((m) => m.id === d.id));
const pick = absorbed.sort(() => Math.random() - 0.5).slice(0, 8);
for (const d of pick) { const t = cross.find((c) => c.deadline === d.deadline && ov(toks(c.buyer), toks(d.buyer)) > 0); console.log("MERGED", JSON.stringify({ doffin: d.title, ted: t?.title, buyer: d.buyer })); }
