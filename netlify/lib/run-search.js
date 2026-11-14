// The search itself: which sources to ask, the shared deadline, and the merged, honest report.
//
// Used by the search function (the page) and the feed function (RSS), so both give the same
// answer for the same request.

import { dedupe, isStillOpen, byUrgency } from "./sources/contract.js";
import * as ted from "./sources/ted.js";
import * as boamp from "./sources/boamp.js";
import * as sam from "./sources/sam.js";
import * as canadabuys from "./sources/canadabuys.js";
import * as prozorro from "./sources/prozorro.js";
import * as ukfts from "./sources/ukfts.js";
import * as ukcf from "./sources/ukcf.js";
import * as austender from "./sources/austender.js";
import * as pncp from "./sources/pncp.js";
import * as placsp from "./sources/placsp.js";
import * as tenderned from "./sources/tenderned.js";
import * as bzp from "./sources/bzp.js";
import * as oev from "./sources/oev.js";
import * as doffin from "./sources/doffin.js";
import * as nspa from "./sources/nspa.js";

// The source registry. Order is irrelevant (they run in parallel); what matters is that each one
// declares `enabled` and `countries`, so we never spend latency on a portal that cannot possibly
// have results for the selected country.
const SOURCES = [ted, boamp, sam, canadabuys, prozorro, ukfts, ukcf, austender, pncp, placsp, tenderned, bzp, oev, doffin, nspa];

/** Which sources can serve this request? null `countries` means multi-country coverage. */
function selectSources(country) {
  return SOURCES.filter((s) => {
    if (s.enabled === false) return false;
    if (!country) return true;                       // "all countries": query everything enabled
    // "INT" (international bodies such as NATO's NSPA) is not a country TED can filter on.
    if (!s.countries) return country !== "INT";      // multi-country source (TED)
    return s.countries.includes(country);
  });
}

/**
 * Validate a request body into search parameters. Every list field must be an array and every
 * scalar a string; anything else is treated as absent. Returns { params } or { error }.
 */
export function normalize(body, origin) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Could not read the request." };
  // Every list field must be an array and every scalar a string; anything else is treated as absent
  // rather than crashing the function with a 500.
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const k of ["cpvCodes", "keywords", "curatedLabels", "matchedTerms", "ptTerms", "frTerms", "pscCodes", "naicsCodes", "gsinCodes", "unspscCodes"]) body[k] = list(body[k]);
  if (typeof body.country !== "string") body.country = "";

  const cpvCodes = (body.cpvCodes || []).slice(0, 20).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  const keywords = (body.keywords || []).slice(0, 10).map((k) => String(k).slice(0, 60));
  const curatedLabels = (body.curatedLabels || []).slice(0, 6).map((k) => String(k).slice(0, 80));
  const matchedTerms = (body.matchedTerms || []).slice(0, 6).map((k) => String(k).slice(0, 60));
  // Portuguese dictionary terms for the matched entries, used by the Brazil index.
  const ptTerms = (body.ptTerms || []).slice(0, 40).map((k) => String(k).slice(0, 60));
  // French dictionary phrases for the matched entries, used to search BOAMP's titles.
  const frTerms = (body.frTerms || []).slice(0, 20).map((k) => String(k).slice(0, 60));
  const daysBack = Math.min(Math.max(parseInt(body.daysBack, 10) || 90, 1), 365);
  const country = (body.country || "").replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase();
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 40, 1), 100);

  // PSC codes are alphanumeric ("7E20", "Y1LB"); a prefix such as "Y1" matches a whole family.
  const pscCodes = (body.pscCodes || []).slice(0, 16).map((c) => String(c).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4)).filter(Boolean);
  const naicsCodes = (body.naicsCodes || []).slice(0, 5).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  const gsinCodes = (body.gsinCodes || []).slice(0, 5).map((c) => String(c).trim()).filter(Boolean);
  const unspscCodes = (body.unspscCodes || []).slice(0, 5).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  // `origin`: cached sources load their index from this site's own CDN, so they need it.
  const params = { cpvCodes, keywords, curatedLabels, matchedTerms, ptTerms, frTerms, pscCodes, naicsCodes, gsinCodes, unspscCodes,
                   daysBack, country, limit, origin };
  if (!cpvCodes.length && !keywords.length && !curatedLabels.length) return { error: "Tell us what you supply first." };
  return { params };
}

/** Ask every source that can serve the request; never throws. */
export async function runSearch(params) {
  const { country } = params;
  // One deadline for the whole request, inside Netlify's 10-second limit. Each source gets the
  // signal; a source still running at the deadline is reported as timed out and the others' results
  // are returned, instead of the whole search failing because one portal was slow.
  const deadlineMs = Number(process.env.SEARCH_DEADLINE_MS || 8000);
  const controller = new AbortController();
  params.signal = controller.signal;
  const active = selectSources(country);
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => { controller.abort(); resolve("deadline"); }, deadlineMs); });
  const settled = await Promise.all(active.map((s) =>
    Promise.race([
      Promise.resolve().then(() => s.search(params)).then((value) => ({ status: "fulfilled", value }), (reason) => ({ status: "rejected", reason })),
      deadline.then(() => ({ status: "deadline" })),
    ])
  ));
  clearTimeout(timer);

  const all = [];
  const sourceReport = [];
  for (let i = 0; i < active.length; i++) {
    const src = active[i];
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      const v = outcome.value;
      const open = v.notices.filter(isStillOpen);
      all.push(...open);
      sourceReport.push({
        source: src.id,
        label: src.label,
        // ok | stale | missing (index not built) | error | timeout. The page shows this, never a
        // guess from the diagnostics text, so a source that failed can't read as "0 found".
        status: v.status || "ok",
        found: open.length,
        // How many matched before the cut to `limit`, so the page can say "40 of 814".
        matched: Number.isFinite(v.matched) ? Math.max(v.matched, open.length) : open.length,
        closedDropped: v.notices.length - open.length,
        variant: v.variant,
        ageHours: v.ageHours ?? null,   // cached sources report index freshness
        diagnostics: v.diagnostics,
      });
    } else if (outcome.status === "deadline") {
      sourceReport.push({
        source: src.id, label: src.label, status: "timeout", found: 0, matched: 0,
        diagnostics: [`no answer within ${deadlineMs / 1000} s`],
      });
    } else {
      // An adapter threw despite the contract. Record it loudly; do not fail the request.
      sourceReport.push({
        source: src.id, label: src.label, status: "error", found: 0, matched: 0, error: String(outcome.reason?.message || outcome.reason),
      });
    }
  }

  // Name the sources we deliberately did not query, so the coverage line never implies we searched
  // everywhere. A user searching France should see that SAM.gov was out of scope, not assume it
  // was checked and empty.
  for (const src of SOURCES) {
    if (active.includes(src)) continue;
    sourceReport.push({
      source: src.id, label: src.label, found: 0,
      skipped: src.enabled === false ? "disabled" : "out of scope for the selected country",
    });
  }

  const results = dedupe(all).sort(byUrgency);
  const anyAnswered = sourceReport.some((s) => !s.skipped && (s.status === "ok" || s.status === "stale"));

  return { results, anyAnswered, sources: sourceReport };
}
