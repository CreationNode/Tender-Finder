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
import * as tenderned from "./sources/tenderned.mjs";
import * as bzp from "./sources/bzp.mjs";
import * as oev from "./sources/oev.mjs";
import * as doffin from "./sources/doffin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, "..", "data", "index");

const INGESTERS = { sam: samBulk, canadabuys, prozorro, ukfts: ukFts, ukcf: ukCf, austender, tenderned, bzp, oev, doffin, pncp, placsp };

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}

// Write to a temporary file, then rename: a job killed mid-write must never leave a truncated JSON
// that the next run reads as "no previous index" and rebuilds from scratch.
function writeAtomic(file, text) {
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
}

// The whole run gets one deadline, so the last sources are skipped cleanly (and reported as
// skipped) instead of being killed mid-write by the job timeout. One source also never gets more
// than SOURCE_LIMIT, so a stalled download costs that source's update, not everyone's.
const RUN_LIMIT_MS = Number(process.env.INGEST_RUN_MINUTES || 48) * 60000;
const SOURCE_LIMIT_MS = Number(process.env.INGEST_SOURCE_MINUTES || 20) * 60000;
const MIN_START_MS = 2 * 60000;

function withDeadline(promise, ms, key) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${key} did not finish within ${Math.round(ms / 60000)} min; previous index kept`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function main() {
  const only = process.argv[2];
  const force = process.env.FORCE === "1";
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  const manifest = readJson(manifestPath, { sources: {} });
  const failures = [];
  const startedAt = Date.now();
  // Every source this run touches is stamped with the run's start time, so the job's verdict can tell
  // "ran and succeeded today" from "yesterday's clean entry, restored but never re-run".
  manifest.runStartedAt = new Date(startedAt).toISOString();
  manifest.runId = process.env.GITHUB_RUN_ID || "local";

  // Saved after EVERY source, not just at the end: when a slow source runs the job out of time, the
  // sources that already finished must still be recorded (the first Brazil/Spain run lost them all).
  const saveManifest = () => {
    manifest.generatedAt = new Date().toISOString();
    writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  };

  for (const [key, mod] of Object.entries(INGESTERS)) {
    if (only && only !== key) continue;
    saveManifest();   // records the previous source before this one starts
    const outPath = path.join(OUT_DIR, `${key}.json`);
    const statePath = path.join(OUT_DIR, `${key}.state.json`);
    const previous = readJson(outPath);
    // A manifest that remembers rows for a source whose index file is missing or unreadable means the
    // restore went wrong for that file: compare against the remembered count, not against zero.
    const previousCount = previous?.count || manifest.sources[key]?.count || 0;

    const remaining = RUN_LIMIT_MS - (Date.now() - startedAt);
    if (remaining < MIN_START_MS) {
      const reason = `skipped: the run reached its ${RUN_LIMIT_MS / 60000}-minute limit before this source started`;
      failures.push(`${key}: ${reason}`);
      console.error(`SKIP ${key}: ${reason}`);
      manifest.sources[key] = { ...(manifest.sources[key] || {}), lastAttempt: new Date().toISOString(), lastError: reason };
      continue;
    }
    // Incremental sources (feed crawlers) resume from a saved cursor and merge into the previous
    // rows, instead of rebuilding the whole index from a bulk file each run.
    const previousState = readJson(statePath, {});

    try {
      const { rows, notes, state } = await withDeadline(mod.ingest({
        log: (m) => console.log(m),
        previousRows: previous?.rows || [],
        previousState,
      }), Math.min(remaining - 60000, SOURCE_LIMIT_MS), key);

      // Canary: refuse to replace a healthy index with a collapsed one. A source that quietly
      // stops publishing must fail loudly, not silently empty the site.
      const verdict = canaryVerdict(previousCount, rows.length);
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
      writeAtomic(outPath, JSON.stringify(index));
      if (state) writeAtomic(statePath, JSON.stringify(state, null, 2));
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

  saveManifest();

  if (failures.length) {
    console.error(`\n${failures.length} source(s) failed. The previous index files were left intact.`);
    process.exit(1);   // surfaces as a red run in GitHub Actions
  }
  console.log("\nIngestion complete.");
  // An abandoned source (see withDeadline) may still hold open sockets; nothing left to wait for.
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
