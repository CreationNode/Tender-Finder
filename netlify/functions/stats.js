// Read-only view of what people search for and where the dictionary falls short.
//
// GET /.netlify/functions/stats           -> last 14 days
// GET /.netlify/functions/stats?days=30   -> last 30 days
//
// Returns aggregate counts plus the top unmatched search terms — the working list of dictionary
// entries to add. No personal data is stored or returned (see netlify/lib/telemetry.js).

export default async (request) => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days"), 10) || 14, 1), 90);

  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("tender-finder-stats");

    const totals = { searches: 0, matched: 0, unmatched: 0, zeroResults: 0 };
    const misses = {};
    const daysCovered = [];

    for (let i = 0; i < days; i++) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const rec = await store.get(`daily/${day}.json`, { type: "json" });
      if (!rec) continue;
      daysCovered.push(day);
      totals.searches += rec.searches || 0;
      totals.matched += rec.matched || 0;
      totals.unmatched += rec.unmatched || 0;
      totals.zeroResults += rec.zeroResults || 0;
      for (const [term, n] of Object.entries(rec.misses || {})) misses[term] = (misses[term] || 0) + n;
    }

    const topMisses = Object.entries(misses)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([term, count]) => ({ term, count }));

    return new Response(
      JSON.stringify({
        windowDays: days,
        daysWithData: daysCovered.sort(),
        totals,
        matchRate: totals.searches ? +(totals.matched / totals.searches).toFixed(3) : null,
        emptyRate: totals.searches ? +(totals.zeroResults / totals.searches).toFixed(3) : null,
        topMisses,
        note: "topMisses are the phrases to add to data/cpv-map.json. High emptyRate with high matchRate means the codes are right but nothing is being bought right now — that is not a bug.",
      }, null, 2),
      { status: 200, headers }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        error: "Durable stats are unavailable.",
        detail: "Netlify Blobs is not reachable here. Per-request metrics are still in the function logs (search for SEARCH_METRIC).",
        name: err.name,
      }, null, 2),
      { status: 200, headers }
    );
  }
};
