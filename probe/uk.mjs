const UA = "WhatTheyBuy/1.0 (+https://whattheybuy.org)";
const url = "https://www.contractsfinder.service.gov.uk/api/rest/2/search_notices/json";
const post = async (body) => { const r = await fetch(url, { method: "POST", headers: { "user-agent": UA, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) }); return { status: r.status, text: await r.text() }; };
let r = await post({ searchCriteria: { types: ["Contract"], statuses: ["Open"] }, size: 2 });
console.log("status", r.status); const j = JSON.parse(r.text); console.log("top keys", Object.keys(j), "hitCount", j.hitCount);
console.log(JSON.stringify(j.noticeList?.[0], null, 1));
for (const size of [1000, 2000]) { r = await post({ searchCriteria: { types: ["Contract"], statuses: ["Open"] }, size }); const k = JSON.parse(r.text); console.log(`size ${size}: status ${r.status} got ${k.noticeList?.length} of ${k.hitCount} bytes ${r.text.length}`); }
r = await post({ searchCriteria: { types: ["Contract", "Pipeline"], statuses: ["Open"] }, size: 1 }); console.log("with pipeline", r.status, r.text.slice(0, 120));
const types = {}; const k = JSON.parse((await post({ searchCriteria: { types: ["Contract"], statuses: ["Open"] }, size: 1000 })).text);
for (const n of k.noticeList || []) { const t = `${n.item.noticeType}/${n.item.noticeStatus}/${n.item.parentId ? "child" : "root"}`; types[t] = (types[t] || 0) + 1; }
console.log("types", JSON.stringify(types)); console.log("no deadline", (k.noticeList || []).filter((n) => !n.item.deadlineDate).length);
console.log("sample cpv", (k.noticeList || []).slice(0, 5).map((n) => JSON.stringify(n.item.cpvCodes)).join(" | "));
