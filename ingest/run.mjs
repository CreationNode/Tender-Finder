#!/usr/bin/env node
// Ingestion runner. Executed by GitHub Actions on a schedule, or by hand:
//
//   SAM_API_KEY=xxx node ingest/run.mjs            # all sources
//   SAM_API_KEY=xxx node ingest/run.mjs sam        # one source
//   FORCE=1 ... node ingest/run.mjs                # overwrite despite a canary failure
//
// Writes data/index/<source>.json and data/index/manifest.json. Those files are committed, so the
// site serves them straight from CDN and every ingestion run is a public, diffable audit trail.

import { loadEnv, maskSecret } from "./lib/env.mjs";
loadEnv();   // pick up .env before any source module reads process.env

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, canaryVerdict } from "./lib/index-format.mjs";
import * as samBulk from "./sources/sam-bulk.mjs";
import * as canadabuys from "./sources/canadabuys.mjs";
import * as prozorro from "./sources/prozorro.mjs";
import * as ukFts from "./sources/uk-fts.mjs";
import * as ukCf from "./sources/uk-cf.mjs";
import * as austender from "./sources/austender.mjs";
import * as pncp from "./sources/pncp.mjs";
import * as placsp from "./sources/placsp.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "data", "index");

const INGESTERS = { sam: samBulk, canadabuys, prozorro, ukfts: ukFts, ukcf: ukCf, austender, pncp, placsp };

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

async function main() {
  const only = process.argv[2];
  const force = process.env.FORCE === "1";
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  const manifest = readJson(manifestPath, { sources: {} });
  const failures = [];

  for (const [key, mod] of Object.entries(INGESTERS)) {
    if (only && only !== key) continue;
    const outPath = path.join(OUT_DIR, `${key}.json`);
    const statePath = path.join(OUT_DIR, `${key}.state.json`);
    const previous = readJson(outPath);
    // Incremental sources (feed crawlers) resume from a saved cursor and merge into the previous
    // rows, instead of rebuilding the whole index from a bulk file each run.
    const previousState = readJson(statePath, {});

    try {
      const { rows, notes, state } = await mod.ingest({
        log: (m) => console.log(m),
        previousRows: previous?.rows || [],
        previousState,
      });

      // Canary: refuse to replace a healthy index with a collapsed one. A source that quietly
      // stops publishing must fail loudly, not silently empty the site.
      const verdict = canaryVerdict(previous?.count || 0, rows.length);
      if (!verdict.ok && !force) {
        failures.push(`${key}: ${verdict.reason}`);
        console.error(`FAIL ${key}: ${verdict.reason}`);
        manifest.sources[key] = {
          ...(manifest.sources[key] || {}),
          lastAttempt: new Date().toISOString(),
          lastError: verdict.reason,
        };
        continue;
      }

      const index = buildIndex({ source: mod.source, label: mod.label, rows, notes });
      fs.writeFileSync(outPath, JSON.stringify(index));
      if (state) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
      const kb = (fs.statSync(outPath).size / 1024).toFixed(0);

      manifest.sources[key] = {
        source: mod.source,
        label: mod.label,
        count: rows.length,
        sizeKb: Number(kb),
        generatedAt: index.generatedAt,
        lastAttempt: index.generatedAt,
        lastError: null,
        notes,
        canary: verdict.reason,
      };
      console.log(`OK   ${key}: ${rows.length} open notices, ${kb} KB`);
      // The search function fetches and parses each index it needs. A few MB is fine (CDN-cached,
      // gzipped, and reused across warm invocations); tens of MB is not. Warn before it becomes a
      // latency problem rather than after users notice.
      if (Number(kb) > 5000) {
        console.log(`     NOTE: ${key}.json is ${(Number(kb) / 1024).toFixed(1)} MB. Above ~10 MB, consider narrowing`);
        console.log(`     the ingest (shorter deadline horizon) or sharding the index.`);
      }
    } catch (err) {
      failures.push(`${key}: ${err.message}`);
      console.error(`FAIL ${key}: ${err.message}`);
      manifest.sources[key] = {
        ...(manifest.sources[key] || {}),
        lastAttempt: new Date().toISOString(),
        lastError: err.message,
      };
    }
  }

  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  if (failures.length) {
    console.error(`\n${failures.length} source(s) failed. The previous index files were left intact.`);
    process.exit(1);   // surfaces as a red run in GitHub Actions
  }
  console.log("\nIngestion complete.");
}

main().catch((err) => { console.error(err); process.exit(1); });
