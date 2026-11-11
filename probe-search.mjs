// TEMPORARY probe for the boamp-french-phrases PR; removed before merge.
import * as boamp from "./netlify/lib/sources/boamp.js";
import * as ted from "./netlify/lib/sources/ted.js";
import fs from "node:fs";
import { matchCodes, searchPayload } from "./assets/match.mjs";
const map = JSON.parse(fs.readFileSync("data/cpv-map.json", "utf8"));
const show = (label, r, n = 8) => {
  console.log(`\n=== ${label}: status=${r.status} variant=${r.variant} matched=${r.matched} returned=${r.notices.length} ${r.diagnostics.join(" | ")}`);
  for (const x of r.notices.slice(0, n)) console.log(`  ${x.deadline || "NO-DATE"} | ${x.title.slice(0, 100)}`);
};
// Every dictionary entry once, by its first English term, to catch French phrases that match the wrong things.
for (const e of map.entries) {
  const q = e.terms[0];
  const p = searchPayload(q, matchCodes(q, map), {});
  show(`BOAMP "${q}"`, await boamp.search({ ...p, daysBack: 90, limit: 40 }), 6);
}
const p = searchPayload("body armor", matchCodes("body armor", map), {});
const r = await ted.search({ ...p, limit: 100 });
const nod = r.notices.filter((n) => !n.deadline);
console.log(`\nTED: ${r.notices.length} notices, ${nod.length} with no deadline`);
const pubs = nod.map((n) => n.id.replace(/^TED-/, ""));
const cands = ["notice-type", "procedure-type", "form-type", "deadline-receipt-expressions-date-lot", "dispatch-invitation-tender-date-lot", "deadline-date-lot", "DT", "deadline", "TD", "PR", "framework-agreement-lot", "dps-usage-lot", "touchpoint-internet-address-buyer"];
for (const f of cands) {
  const res = await fetch("https://api.ted.europa.eu/v3/notices/search", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: `publication-number IN (${pubs.join(" ")})`, scope: "ALL", limit: "100", paginationMode: "ITERATION", fields: ["publication-number", f] }) });
  const t = await res.text();
  if (!res.ok) { console.log(`field ${f}: HTTP ${res.status} ${t.slice(0, 120)}`); continue; }
  const rows = JSON.parse(t).notices || [];
  console.log(`field ${f}: ` + rows.map((x) => `${x["publication-number"]}=${JSON.stringify(x[f] ?? null).slice(0, 60)}`).join("  "));
}
