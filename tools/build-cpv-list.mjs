#!/usr/bin/env node
/**
 * Build data/cpv-full.json from the OFFICIAL EU CPV vocabulary file.
 *
 * Why this is a script you run, and not a file shipped in the repo:
 * the CPV vocabulary is ~9,500 codes. Nobody should hand-write or recall those — a wrong code does
 * not error, it silently searches for the wrong thing, which is the worst failure a tool like this
 * can have. So the full list is generated from the official source, or it is not used at all. The
 * app works fine without it (the curated dictionary in data/cpv-map.json still runs); this simply
 * widens coverage from ~78 curated concepts to the entire vocabulary.
 *
 * ONE-TIME SETUP
 * --------------
 * 1. Download the official CPV codelist from https://simap.ted.europa.eu/web/simap/cpv
 *    (it arrives as a ZIP containing all EU languages).
 * 2. Run it straight against the ZIP — no manual extraction needed:
 *      node tools/build-cpv-list.mjs C:\Users\you\Downloads\cpv_2008.zip
 *    A already-extracted .csv or .xml works too, as does an http(s) URL.
 * 3. It writes ../data/cpv-full.json and prints a summary. Commit that file.
 *
 * Re-run whenever the Commission revises the vocabulary.
 *
 * INPUT SHAPES ACCEPTED
 *   CSV : a column containing the code (e.g. "CODE" / "Code") and one containing the English
 *         description (e.g. "EN" / "Description" / "Label").
 *   XML : elements carrying a CODE attribute with a nested English text node.
 * The parser is intentionally forgiving about column order and naming, and it will tell you what it
 * found rather than guessing silently.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listZipEntries, readZipEntry } from "./lib/zip.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const input = process.argv[2];

if (!input) {
  console.error("Usage: node tools/build-cpv-list.mjs <official-cpv-file.csv|.xml>");
  console.error("Download the file first: https://simap.ted.europa.eu/web/simap/cpv");
  process.exit(1);
}
if (!/^https?:\/\//i.test(input) && !fs.existsSync(input)) {
  console.error(`File not found: ${input}`);
  process.exit(1);
}

// Accept a URL, a ZIP, or a plain CSV/XML file. The official download is a ZIP of every language,
// so unpacking it here removes the step where people pick the wrong file out of the archive.
let raw;
let sourceName = input;

if (/^https?:\/\//i.test(input)) {
  console.log(`Downloading ${input} …`);
  const res = await fetch(input, { headers: { "user-agent": "OpenTenderFinder/1.0 (CPV import)" } });
  if (!res.ok) { console.error(`Download failed: HTTP ${res.status}`); process.exit(1); }
  const buf = Buffer.from(await res.arrayBuffer());
  raw = looksLikeZip(buf) ? pickFromZip(buf) : buf.toString("utf8");
} else {
  const buf = fs.readFileSync(input);
  raw = looksLikeZip(buf) ? pickFromZip(buf) : buf.toString("utf8");
}

function looksLikeZip(buf) {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;   // "PK"
}

/** Choose the English CSV/XML from the official multi-language archive. */
function pickFromZip(buf) {
  const entries = listZipEntries(buf).filter((e) => /\.(csv|xml|txt)$/i.test(e.name));
  if (!entries.length) {
    console.error("The ZIP contains no CSV/XML/TXT entries. Contents:");
    for (const e of listZipEntries(buf)) console.error("  " + e.name);
    process.exit(1);
  }
  // Prefer an entry that names English; otherwise the largest, which is the full codelist.
  const english = entries.find((e) => /(^|[^a-z])(en|eng|english)([^a-z]|$)/i.test(e.name));
  const chosen = english || entries.sort((a, b) => b.compressedSize - a.compressedSize)[0];
  console.log(`ZIP contains ${entries.length} data file(s); using "${chosen.name}"`);
  if (!english) {
    console.log("  (No file obviously marked English — picked the largest. If the labels come out");
    console.log("   in another language, re-run against the English file inside the archive.)");
  }
  sourceName = chosen.name;
  return readZipEntry(buf, chosen).toString("utf8");
}

const isXml = /\.xml$/i.test(sourceName) || raw.trimStart().startsWith("<");

/** Split a CSV line respecting quotes and both comma and semicolon delimiters. */
function splitCsvLine(line, delim) {
  const out = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim().replace(/^"|"$/g, ""));
}

const entries = [];

if (isXml) {
  // <CPV CODE="03000000-1"><TEXT LANG="EN">Agricultural ... </TEXT></CPV>
  // The official file nests one <TEXT LANG="..."> per language inside each code element:
  //   <CPV CODE="03000000-1"><TEXT LANG="BG">…</TEXT><TEXT LANG="EN">Agricultural …</TEXT>…</CPV>
  // The element must be captured WHOLE (backreference on the tag name). Matching lazily to the
  // first closing tag stopped at </TEXT> of the FIRST language — Bulgarian — so labels would have
  // come out in the wrong language or empty.
  const re = /<([A-Za-z_][\w.-]*)\b[^>]*\bCODE="(\d{8})(?:-\d)?"[^>]*>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const code = m[2];
    const block = m[3];
    // Do not require a trailing "<": the captured block already ends at the closing tag, so
    // demanding one made every XML row fail to yield a label.
    const en =
      /LANG="EN"[^>]*>([^<]*)/i.exec(block)?.[1] ??
      /<TEXT[^>]*>([^<]*)/i.exec(block)?.[1] ??
      "";
    const label = en.trim();
    if (code && label) entries.push({ code, label });
  }
} else {
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const delim = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
  const header = splitCsvLine(lines[0], delim).map((h) => h.toLowerCase());

  const codeIdx = header.findIndex((h) => /^code$|cpv/.test(h));
  let labelIdx = header.findIndex((h) => /^en$|^eng$|english/.test(h));
  if (labelIdx === -1) labelIdx = header.findIndex((h) => /desc|label|name|text/.test(h));

  if (codeIdx === -1 || labelIdx === -1) {
    console.error("Could not identify the code and English-description columns.");
    console.error("Columns found:", header.join(" | "));
    console.error("Rename the header or edit this script's column detection, then re-run.");
    process.exit(1);
  }
  console.log(`Using column "${header[codeIdx]}" as code and "${header[labelIdx]}" as English label.`);

  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line, delim);
    const code = (cells[codeIdx] || "").replace(/\D/g, "").slice(0, 8);
    const label = (cells[labelIdx] || "").trim();
    if (code.length === 8 && label) entries.push({ code, label });
  }
}

if (!entries.length) {
  console.error("No CPV entries parsed. Check that this is the official CPV codelist file.");
  process.exit(1);
}

// Deduplicate by code, keep the first (most general) label seen.
const byCode = new Map();
for (const e of entries) if (!byCode.has(e.code)) byCode.set(e.code, e.label);

const out = {
  _readme:
    "Generated from the official EU CPV vocabulary by tools/build-cpv-list.mjs. Do not hand-edit: " +
    "re-run the script against the official file instead. Curated plain-language synonyms live in " +
    "data/cpv-map.json, which takes priority over this list.",
  source: "https://simap.ted.europa.eu/web/simap/cpv",
  generated: new Date().toISOString().slice(0, 10),
  count: byCode.size,
  // Compact array-of-pairs keeps the file small enough to ship to the browser.
  codes: [...byCode.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([code, label]) => [code, label]),
};

const target = path.join(here, "..", "data", "cpv-full.json");
fs.writeFileSync(target, JSON.stringify(out));
const kb = (fs.statSync(target).size / 1024).toFixed(0);
console.log(`Wrote ${target}`);
console.log(`${out.count} CPV codes, ${kb} KB.`);
if (out.count < 5000) {
  console.log("Note: the official 2008 vocabulary has roughly 9,500 codes. A much smaller count " +
              "usually means only a summary sheet was parsed — check the input file.");
}
