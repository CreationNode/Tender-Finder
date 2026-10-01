// Temporary: dry-runs the Brazil ingester from a GitHub runner and checks Spain's robots rules.
// Deleted before merge.
import { politeFetch } from "../ingest/lib/http.mjs";
import { ingest } from "../ingest/sources/pncp.mjs";
for (const u of []) {
  try { const r = await politeFetch(u, { timeoutMs: 30000 }); console.log(`\n==== ${u} HTTP ${r.status}\n${(await r.text()).slice(0, 1200)}`); }
  catch (e) { console.log(u, "ERROR", e.message); }
}
process.env.PNCP_BUDGET_MS = String(4 * 60 * 1000);
const t0 = Date.now();
const r = await ingest({ log: console.log });
const s = (Date.now() - t0) / 1000;
console.log(`\nPNCP dry run: ${s.toFixed(0)} s, ${r.rows.length} rows, ${(JSON.stringify(r.rows).length / 1e6).toFixed(2)} MB`, r.notes, r.state);
for (const row of r.rows.slice(-5)) console.log(row);
const bal = r.rows.filter((x) => /bal[ií]stic/i.test(x[1]));
console.log("ballistic rows:", bal.length, bal.slice(0, 5).map((x) => x[1]));
const mods = {}; for (const x of r.rows) { const d = x[4] ? Math.round((new Date(x[4]) - Date.now()) / 864e5) : "none"; const b = d === "none" ? d : d < 15 ? "<15" : d < 60 ? "15-60" : "60+"; mods[b] = (mods[b] || 0) + 1; }
console.log("deadline buckets", mods);
