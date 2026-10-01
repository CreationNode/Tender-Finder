const UA = "Mozilla/5.0 (compatible; WhatTheyBuy/1.0; +https://github.com/CreationNode/Tender-Finder)";
const title = async (u) => { const r = await fetch(u, { headers: { "user-agent": UA }, redirect: "follow" }); const t = await r.text(); return `${r.status} ${r.url.slice(0, 100)} | ${(/<title>([^<]*)/i.exec(t) || [])[1]?.trim().slice(0, 70)}`; };
const j = async (u) => (await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } })).json();
const to = new Date().toISOString().slice(0, 19), from = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 19);
const base = "https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search";
for (const q of [`stages=planning,tender`, `stages=tender`, `stages=planning`, ``, `stages=tender&limit=100&cursor=`]) {
  const p = await j(`${base}?publishedFrom=${from}&publishedTo=${to}&${q}`);
  const tags = {}; for (const r of p.releases || []) for (const t of r.tag || []) tags[t] = (tags[t] || 0) + 1;
  console.log(`CF [${q}] releases ${p.releases?.length} tags ${JSON.stringify(tags)} keys ${Object.keys(p).join(",")}`);
}
const p = await j(`${base}?publishedFrom=${from}&publishedTo=${to}&stages=tender`);
for (const r of (p.releases || []).slice(0, 3)) { const u = (r.tender?.documents || []).map((d) => d.url).find((x) => /\/Notice\//i.test(x)); console.log("doc url", u, "->", u && await title(u)); }
// one-day windows: does a 1-day window return more per day than a 2-day one? (cap check)
for (let d = 1; d <= 3; d++) { const a = new Date(Date.now() - d * 864e5).toISOString().slice(0, 10); const pp = await j(`${base}?publishedFrom=${a}T00:00:00&publishedTo=${a}T23:59:59`); console.log(`CF day ${a}: ${pp.releases?.length}`); }
const s = await (await fetch("https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json", { method: "POST", headers: { "user-agent": UA, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ searchCriteria: { types: ["Contract"], statuses: ["Open"], publishedFrom: null }, size: 1 }) })).text();
console.log("CF v2 search open:", s.slice(0, 300));
