// TEMPORARY probe for the boamp-french-phrases PR; removed before merge.
import * as boamp from "./netlify/lib/sources/boamp.js";
import * as ted from "./netlify/lib/sources/ted.js";
import fs from "node:fs";
import { matchCodes, searchPayload } from "./assets/match.mjs";
const map = JSON.parse(fs.readFileSync("data/cpv-map.json", "utf8"));
const show = (label, r, n) => {
  console.log(`=== ${label}: ${r.status} kept=${r.matched} | ${r.diagnostics.join(" | ")}`);
  for (const x of r.notices.slice(0, n)) console.log(`  ${x.deadline || "NO-DATE"} | ${x.title.slice(0, 90)}`);
};
for (const e of map.entries) {
  const q = e.terms[0];
  show(`BOAMP "${q}"`, await boamp.search({ ...searchPayload(q, matchCodes(q, map), {}), daysBack: 90, limit: 40 }), 3);
}
for (const q of ["body armor", "road salt", "ballistic shields"]) {
  const p = searchPayload(q, [], {});
  show(`BOAMP no-dictionary "${q}"`, await boamp.search({ ...p, daysBack: 90, limit: 40 }), 3);
}
// TED: which query form excludes award results and advance notices?
const body = (query) => JSON.stringify({ query, scope: "ACTIVE", limit: "100", paginationMode: "ITERATION", fields: ["publication-number", "form-type"] });
for (const q of ["classification-cpv IN (35815100 35813000)", "classification-cpv IN (35815100 35813000) AND form-type IN (competition)", "(classification-cpv IN (35815100 35813000)) AND form-type IN (competition change)", "classification-cpv IN (35815100 35813000) AND NOT form-type IN (result planning)"]) {
  const res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" }, body: body(q) });
  const t = await res.text();
  if (!res.ok) { console.log(`TED [${q}]: HTTP ${res.status} ${t.slice(0, 150)}`); continue; }
  const j = JSON.parse(t); const c = {};
  for (const n of j.notices || []) c[n["form-type"]] = (c[n["form-type"]] || 0) + 1;
  console.log(`TED [${q}]: total ${j.totalNoticeCount}, first 100 by form-type ${JSON.stringify(c)}`);
}
const p = searchPayload("body armor", matchCodes("body armor", map), {});
const r = await ted.search({ ...p, limit: 100 });
console.log(`TED search(): ${r.status} ${r.variant} returned ${r.notices.length}, no deadline ${r.notices.filter((n) => !n.deadline).length}, open ${r.notices.filter((n) => n.daysLeft === null || n.daysLeft >= 0).length} ${r.diagnostics.join(" | ")}`);
