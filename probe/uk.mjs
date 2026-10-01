const UA = "Mozilla/5.0 (compatible; WhatTheyBuy/1.0; +https://github.com/CreationNode/Tender-Finder)";
const get = async (u, o = {}) => { const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, redirect: "follow", ...o }); return r; };
const title = async (u) => { const r = await fetch(u, { headers: { "user-agent": UA }, redirect: "follow" }); const t = await r.text(); return `${r.status} ${r.url.slice(0, 90)} ${(/<title>([^<]*)/i.exec(t) || [])[1]?.trim().slice(0, 70)}`; };
const now = new Date(); const from = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 19);
// FTS
const f = await (await get(`https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages?updatedFrom=${from}&limit=3&stages=tender`)).json();
for (const r of (f.releases || []).slice(0, 2)) {
  console.log("FTS release id", r.id, "ocid", r.ocid, "tender.id", r.tender?.id, "keys", Object.keys(r).join(","));
  console.log("FTS docs", JSON.stringify((r.tender?.documents || []).slice(0, 2).map((d) => d.url)), "links", JSON.stringify(r.links || null));
  for (const c of [r.id, r.tender?.id, String(r.id || "").replace(/^.*?-(\d{6}-\d{4})$/, "$1")]) if (c) console.log("  try", c, "->", await title(`https://www.find-tender.service.gov.uk/Notice/${encodeURIComponent(c)}`));
}
console.log("FTS links", JSON.stringify(f.links));
// CF
for (const extra of ["", "&limit=100", "&size=100"]) {
  const u = `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search?publishedFrom=${from}&publishedTo=${now.toISOString().slice(0, 19)}&stages=planning,tender${extra}`;
  const p = await (await get(u)).json();
  console.log(`CF ${extra || "(none)"}: releases ${p.releases?.length}, top keys ${Object.keys(p).join(",")}, links ${JSON.stringify(p.links)}, maxResults? ${p.maxResults ?? ""}`);
  if (!extra) for (const r of p.releases.slice(0, 2)) {
    console.log("CF release id", r.id, "ocid", r.ocid, "tender.id", r.tender?.id, "docs", JSON.stringify((r.tender?.documents || []).slice(0, 2).map((d) => d.url)));
    const guid = String(r.ocid).replace(/^ocds-b5fd17-/, "");
    for (const c of [`Notice/${guid}`, `notice/${guid}`, `Notice/${r.id}`, `notice/${guid}?origin=SearchResults&p=1`]) console.log("  try", c, "->", await title(`https://www.contractsfinder.service.gov.uk/${c}`));
  }
}
