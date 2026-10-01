// Coverage summary for the "Where we look" table: how many open notices each cached source holds and
// when it last refreshed, read from the ingest manifest. The table used to be hand-written, so it
// could advertise a source that was failing or had never loaded; now the page fills in the numbers
// from the data itself and falls back to the static text if this call fails.
//
// GET /.netlify/functions/coverage -> { generatedAt, sources: { <key>: { count, updated, failing } } }

const INDEX_BASE = (process.env.INDEX_BASE_URL || "").replace(/\/+$/, "");

export default async (request) => {
  const headers = { "content-type": "application/json", "cache-control": "public, max-age=600" };
  const base = INDEX_BASE || `${new URL(request.url).origin}/data/index`;
  try {
    const res = await fetch(`${base}/manifest.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    const sources = {};
    for (const [key, s] of Object.entries(manifest.sources || {})) {
      sources[key] = {
        count: Number.isFinite(s.count) ? s.count : null,
        updated: s.generatedAt || null,
        // The last attempt failed (the previous index, if any, is still being served).
        failing: Boolean(s.lastError),
      };
    }
    return new Response(JSON.stringify({ generatedAt: manifest.generatedAt || null, sources }), { status: 200, headers });
  } catch (err) {
    return new Response(JSON.stringify({ error: "coverage unavailable", detail: String(err.message || err) }),
      { status: 200, headers: { ...headers, "cache-control": "no-store" } });
  }
};
