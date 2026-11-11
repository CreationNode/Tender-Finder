// TEMPORARY probe for the boamp-french-phrases PR; removed before merge.
import * as boamp from "./netlify/lib/sources/boamp.js";
import * as ted from "./netlify/lib/sources/ted.js";
import fs from "node:fs";
import { matchCodes, searchPayload } from "./assets/match.mjs";
const map = JSON.parse(fs.readFileSync("data/cpv-map.json", "utf8"));
for (const q of ["bedding", "tools", "desk", "school supplies", "packaging", "body armour"]) {
  const r = await boamp.search({ ...searchPayload(q, matchCodes(q, map), {}), daysBack: 90, limit: 40 });
  console.log(`=== BOAMP "${q}": kept=${r.matched}`);
  for (const x of r.notices.slice(0, 5)) console.log(`  ${x.title.slice(0, 90)}`);
}
const body = (query) => JSON.stringify({ query, scope: "ACTIVE", limit: "100", paginationMode: "ITERATION", fields: ["publication-number", "form-type", "deadline-receipt-tender-date-lot", "deadline-receipt-request-date-lot"] });
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const base = "classification-cpv IN (35815100 35813000) AND form-type IN (competition change)";
for (const q of [base,
  `${base} AND (deadline-receipt-tender-date-lot>=${today} OR deadline-receipt-request-date-lot>=${today})`,
  `${base} AND (deadline-receipt-tender-date-lot >= ${today} OR deadline-receipt-request-date-lot >= ${today})`]) {
  const res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" }, body: body(q + " SORT BY publication-number DESC") });
  const t = await res.text();
  if (!res.ok) { console.log(`TED [${q}]: HTTP ${res.status} ${t.slice(0, 200)}`); continue; }
  const j = JSON.parse(t); const rows = j.notices || [];
  const last = (v) => [].concat(v || []).map((d) => String(d).slice(0, 10)).sort().pop() || "";
  const dl = rows.map((n) => last(n["deadline-receipt-tender-date-lot"]) || last(n["deadline-receipt-request-date-lot"]));
  const iso = new Date().toISOString().slice(0, 10);
  console.log(`TED [${q}]: total ${j.totalNoticeCount}, rows ${rows.length}, no date ${dl.filter((d) => !d).length}, past ${dl.filter((d) => d && d < iso).length}, open ${dl.filter((d) => d >= iso).length}`);
}
