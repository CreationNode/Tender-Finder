// TEMPORARY probe for the boamp-french-phrases PR; removed before merge.
import * as boamp from "./netlify/lib/sources/boamp.js";
import * as ted from "./netlify/lib/sources/ted.js";
import fs from "node:fs";
import { matchCodes, searchPayload } from "./assets/match.mjs";
const map = JSON.parse(fs.readFileSync("data/cpv-map.json", "utf8"));
const show = (label, r) => {
  console.log(`\n=== ${label}: status=${r.status} variant=${r.variant} matched=${r.matched} returned=${r.notices.length} ${r.diagnostics.join(" | ")}`);
  for (const n of r.notices.slice(0, 15)) console.log(`  ${n.deadline || "NO-DATE"} | ${n.title.slice(0, 110)} | ${n.buyer.slice(0, 40)}`);
};
for (const q of ["body armor", "office chairs", "cleaning services", "software", "cpr manikins", "electrical installation", "road salt"]) {
  const p = searchPayload(q, matchCodes(q, map), {});
  show(`BOAMP "${q}" fr=${JSON.stringify(p.frTerms)}`, await boamp.search({ ...p, daysBack: 90, limit: 40 }));
}
const p = searchPayload("body armor", matchCodes("body armor", map), {});
const r = await ted.search({ ...p, limit: 100 });
show("TED body armor", r);
const nodate = r.notices.filter((n) => !n.deadline).length;
const past = r.notices.filter((n) => n.daysLeft !== null && n.daysLeft < 0).length;
console.log(`TED: ${r.notices.length} notices, ${nodate} with no deadline, ${past} past deadline (dropped by the page)`);
// Raw check that TED returns the request-deadline field at all.
const raw = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ query: "classification-cpv IN (35815100 35813000)", scope: "ACTIVE", limit: "100", paginationMode: "ITERATION", fields: ["publication-number", "deadline-receipt-tender-date-lot", "deadline-receipt-request-date-lot", "notice-type", "procedure-type"] }) });
const j = await raw.json();
const rows = j.notices || [];
console.log(`raw TED: HTTP ${raw.status}, ${rows.length} rows, tender-deadline ${rows.filter((x) => x["deadline-receipt-tender-date-lot"]).length}, request-deadline ${rows.filter((x) => x["deadline-receipt-request-date-lot"]).length}, neither ${rows.filter((x) => !x["deadline-receipt-tender-date-lot"] && !x["deadline-receipt-request-date-lot"]).length}`);
for (const x of rows.filter((x) => !x["deadline-receipt-tender-date-lot"]).slice(0, 30)) console.log("  ", x["publication-number"], JSON.stringify(x["notice-type"]), JSON.stringify(x["procedure-type"]), JSON.stringify(x["deadline-receipt-request-date-lot"]));
