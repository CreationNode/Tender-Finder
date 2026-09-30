#!/usr/bin/env node
// Connectivity check for every cached source. Answers one question fast:
// "which portals actually respond, and with what?"
//
//   node ingest/verify.mjs                 # check all
//   SAM_API_KEY=xxx node ingest/verify.mjs # include SAM
//   node ingest/verify.mjs austender       # check one
//
// It writes NOTHING. Each source runs with a tiny budget, so this finishes in under a minute and
// tells you whether the problem is the portal, the credentials, or our parsing.

import { loadEnv, maskSecret } from "./lib/env.mjs";
loadEnv();   // pick up .env before any source module reads process.env

import * as samBulk from "./sources/sam-bulk.mjs";
import * as canadabuys from "./sources/canadabuys.mjs";
import * as prozorro from "./sources/prozorro.mjs";
import * as ukFts from "./sources/uk-fts.mjs";
import * as ukCf from "./sources/uk-cf.mjs";
import * as austender from "./sources/austender.mjs";

const SOURCES = { sam: samBulk, canadabuys, prozorro, ukfts: ukFts, ukcf: ukCf, austender };

// Keep every check small: one or two pages is enough to prove reachability and shape.
process.env.PROZORRO_MAX_PAGES ||= "1";
process.env.PROZORRO_BUDGET_MS ||= "30000";
process.env.FTS_MAX_PAGES ||= "1";
process.env.FTS_BUDGET_MS ||= "30000";
process.env.CF_MAX_PAGES ||= "1";
process.env.CF_BUDGET_MS ||= "30000";

const only = process.argv[2];
const results = [];

// Show which credentials are visible, masked. "SAM failed" is ambiguous between a bad key and no
// key at all, and that ambiguity has cost time already.
console.log("Credentials:");
console.log("  SAM_API_KEY        " + maskSecret(process.env.SAM_API_KEY));
console.log("  SAM_BULK_CSV_URL   " + (process.env.SAM_BULK_CSV_URL ? "(set)" : "(not set — the ingester will try its default path)"));
console.log("  AUSTENDER_RSS_URL  " + (process.env.AUSTENDER_RSS_URL ? "(set)" : "(not set — discovered from the data.gov.au catalogue)"));

for (const [key, mod] of Object.entries(SOURCES)) {
  if (only && only !== key) continue;
  const started = Date.now();
  process.stdout.write(`\n=== ${key} (${mod.label}) ===\n`);
  try {
    const { rows, notes } = await mod.ingest({ log: (m) => console.log("  " + m) });
    const ms = Date.now() - started;
    const sample = rows[0];
    results.push({ key, ok: true, rows: rows.length, ms });
    console.log(`  RESULT: OK — ${rows.length} open notice(s) in ${(ms / 1000).toFixed(1)}s`);
    if (notes?.length) console.log(`  notes: ${notes.join(" | ")}`);
    if (sample) {
      console.log(`  sample: ${sample[1]}`);
      console.log(`          buyer=${sample[2] || "(none)"} country=${sample[3]} closes=${sample[4] || "(none)"}`);
      console.log(`          link=${sample[7]}`);
    } else {
      console.log("  WARNING: reachable but produced zero rows — check the filters or the date window.");
    }
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ key, ok: false, error: err.message, ms });
    console.log(`  RESULT: FAILED after ${(ms / 1000).toFixed(1)}s`);
    console.log(`  ${err.message}`);
  }
}

console.log("\n================ SUMMARY ================");
for (const r of results) {
  console.log(r.ok
    ? `  OK    ${r.key.padEnd(11)} ${String(r.rows).padStart(6)} rows`
    : `  FAIL  ${r.key.padEnd(11)} ${r.error.slice(0, 90)}`);
}
const okCount = results.filter((r) => r.ok && r.rows > 0).length;
console.log(`\n${okCount}/${results.length} source(s) returned data.`);
console.log("Paste this summary if you need help diagnosing a failure.\n");
