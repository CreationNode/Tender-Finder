// Load secrets from a local .env file.
//
// Credentials must never be typed into a source file or pasted into a script that gets committed.
// This reads a .env at the repo root (which .gitignore excludes) and copies anything not already
// set into process.env — so the same code works locally and in CI, where the values come from
// GitHub secrets instead.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadEnv(file = path.join(ROOT, ".env")) {
  if (!fs.existsSync(file)) return { loaded: false, keys: [] };
  const keys = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Tolerate quoted values; Windows users often paste them with quotes.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // An environment variable already set (CI, or an explicit $env: assignment) always wins.
    if (!process.env[key]) {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

/** Never print a secret. Show only enough to confirm the right value is loaded. */
export function maskSecret(value) {
  const s = String(value || "");
  if (!s) return "(not set)";
  return s.length <= 12 ? "***" : `${s.slice(0, 8)}…${s.slice(-4)} (${s.length} chars)`;
}
