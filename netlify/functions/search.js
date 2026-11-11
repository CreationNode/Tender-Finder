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
// shape, then add it to SOURCES in netlify/lib/run-search.js. Nothing else changes.

import { logMetric, recordAggregate, safeTerm } from "../lib/telemetry.js";
import { normalize, runSearch } from "../lib/run-search.js";

export default async (request) => {
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=300" };
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Send a POST request." }), { status: 405, headers });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response(JSON.stringify({ error: "Could not read the request." }), { status: 400, headers }); }
  const { params, error } = normalize(body, new URL(request.url).origin);
  if (error) return new Response(JSON.stringify({ error }), { status: 400, headers });

  const term = safeTerm(body.term);
  const matched = params.cpvCodes.length > 0;
  const startedAt = Date.now();
  const { results, anyAnswered, sources: sourceReport } = await runSearch(params);
  const anySucceeded = sourceReport.some((s) => s.found > 0);

  logMetric({
    ok: anySucceeded, matched, codes: params.cpvCodes.length, results: results.length,
    ms: Date.now() - startedAt, country: params.country || "ALL",
    bySource: Object.fromEntries(sourceReport.map((s) => [s.source, s.found])),
  });
  await recordAggregate({ matched, term, resultCount: results.length });

  return new Response(
    JSON.stringify({ results, total: results.length, anyAnswered, sources: sourceReport }),
    { status: 200, headers }
  );
};
