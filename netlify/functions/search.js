// Search orchestrator.
//
// Queries every registered source IN PARALLEL and merges the results. The guarantees:
//   * No single source can break the page. Promise.allSettled plus per-source timeouts mean a
//     dead portal degrades to "results from the others, and here is what went wrong".
//   * Every result carries its provenance, because a public tool should be honest about where a
//     row came from and which portals it did not reach.
//   * Closed notices are dropped everywhere: a passed deadline is not an opportunity.
//
// Adding a source: write one module exporting { id, label, search() } returning the shared notice
// shape, then add it to SOURCES below. Nothing else changes.

import { logMetric, recordAggregate, safeTerm } from "../lib/telemetry.js";
import { dedupe, isStillOpen, byUrgency } from "../lib/sources/contract.js";
import * as ted from "../lib/sources/ted.js";
import * as boamp from "../lib/sources/boamp.js";
import * as sam from "../lib/sources/sam.js";
import * as canadabuys from "../lib/sources/canadabuys.js";
import * as prozorro from "../lib/sources/prozorro.js";
import * as ukfts from "../lib/sources/ukfts.js";
import * as ukcf from "../lib/sources/ukcf.js";
import * as austender from "../lib/sources/austender.js";

// The source registry. Order is irrelevant (they run in parallel); what matters is that each one
// declares `enabled` and `countries`, so we never spend latency on a portal that cannot possibly
// have results for the selected country.
const SOURCES = [ted, boamp, sam, canadabuys, prozorro, ukfts, ukcf, austender];

/** Which sources can serve this request? null `countries` means multi-country coverage. */
function selectSources(country) {
  return SOURCES.filter((s) => {
    if (s.enabled === false) return false;
    if (!country) return true;                       // "all countries": query everything enabled
    if (!s.countries) return true;                   // multi-country source (TED)
    return s.countries.includes(country);
  });
}

export default async (request) => {
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=300" };
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Send a POST request." }), { status: 405, headers });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "Could not read the request." }), { status: 400, headers }); }

  const cpvCodes = (body.cpvCodes || []).slice(0, 20).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  const keywords = (body.keywords || []).slice(0, 10).map((k) => String(k).slice(0, 60));
  const curatedLabels = (body.curatedLabels || []).slice(0, 6).map((k) => String(k).slice(0, 80));
  const matchedTerms = (body.matchedTerms || []).slice(0, 6).map((k) => String(k).slice(0, 60));
  const daysBack = Math.min(Math.max(parseInt(body.daysBack, 10) || 90, 1), 365);
  const country = (body.country || "").replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase();
  const limit = Math.min(Math.max(parseInt(body.limit, 10) || 40, 1), 100);

  if (!cpvCodes.length && !keywords.length && !curatedLabels.length) {
    return new Response(JSON.stringify({ error: "Tell us what you supply first." }), { status: 400, headers });
  }

  const term = safeTerm(body.term);
  const matched = cpvCodes.length > 0;
  const startedAt = Date.now();
  const pscCodes = (body.pscCodes || []).slice(0, 5).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  const naicsCodes = (body.naicsCodes || []).slice(0, 5).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  // Cached sources load their index from this site's own CDN, so they need the origin.
  const origin = new URL(request.url).origin;
  const gsinCodes = (body.gsinCodes || []).slice(0, 5).map((c) => String(c).trim()).filter(Boolean);
  const unspscCodes = (body.unspscCodes || []).slice(0, 5).map((c) => String(c).replace(/\D/g, "")).filter(Boolean);
  const params = { cpvCodes, keywords, curatedLabels, matchedTerms, pscCodes, naicsCodes, gsinCodes, unspscCodes,
                   daysBack, country, limit, origin };

  const active = selectSources(country);
  const settled = await Promise.allSettled(active.map((s) => s.search(params)));

  const all = [];
  const sourceReport = [];
  for (let i = 0; i < active.length; i++) {
    const src = active[i];
    const outcome = settled[i];
    if (outcome.status === "fulfilled") {
      const open = outcome.value.notices.filter(isStillOpen);
      all.push(...open);
      sourceReport.push({
        source: src.id,
        label: src.label,
        found: open.length,
        closedDropped: outcome.value.notices.length - open.length,
        variant: outcome.value.variant,
        ageHours: outcome.value.ageHours ?? null,   // cached sources report index freshness
        diagnostics: outcome.value.diagnostics,
      });
    } else {
      // An adapter threw despite the contract. Record it loudly; do not fail the request.
      sourceReport.push({
        source: src.id, label: src.label, found: 0, error: String(outcome.reason?.message || outcome.reason),
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
  const anySucceeded = sourceReport.some((s) => s.found > 0);

  logMetric({
    ok: anySucceeded, matched, codes: cpvCodes.length, results: results.length,
    ms: Date.now() - startedAt, country: country || "ALL",
    bySource: Object.fromEntries(sourceReport.map((s) => [s.source, s.found])),
  });
  await recordAggregate({ matched, term, resultCount: results.length });

  return new Response(
    JSON.stringify({ results, total: results.length, sources: sourceReport }),
    { status: 200, headers }
  );
};
