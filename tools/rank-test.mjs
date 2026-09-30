#!/usr/bin/env node
// Rank a few plain-language queries against the real CPV vocabulary.
//   node tools/rank-test.mjs
//   node tools/rank-test.mjs "ballistic helmets" "fire hoses"
// Uses the SAME ranking module the website uses, so what you see here is what users get.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rankCpv } from "../assets/rank.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "data", "cpv-full.json");
if (!fs.existsSync(file)) {
  console.error("data/cpv-full.json not found. Build it first:\n  node tools/build-cpv-list.mjs <cpv_2008.xml>");
  process.exit(1);
}
const { codes, count } = JSON.parse(fs.readFileSync(file, "utf8"));
console.log(`Loaded ${count} CPV codes.\n`);

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["beehives", "office chairs", "ballistic helmets", "school meals", "solar panels",
     "translation services", "fire hoses", "bakery bread", "laptop computers", "road resurfacing"];

for (const q of queries) {
  const hits = rankCpv(q, codes, new Set(), 4);
  console.log(q + ":");
  if (!hits.length) console.log("  (no code matched — the search falls back to full text)");
  for (const h of hits) console.log(`  ${String(h.score).padStart(3)}  ${h.code}  ${h.label}`);
  console.log("");
}
