// TEMPORARY DIAGNOSTIC — delete this file once the question is answered.
//
// Purpose: find out whether CanadaBuys' HTTP 403 is bot protection against residential IPs, or a
// genuinely wrong URL. Netlify functions run from a datacentre IP, which government CDNs commonly
// allow where they block home connections. If a URL returns 200 here but 403 on your machine, the
// source works in production and is simply untestable locally.
//
// Usage:  https://YOUR-SITE.netlify.app/.netlify/functions/probe?key=YOUR-SECRET
//
// Safety: it only issues GET requests to a fixed allow-list of public open-data URLs, returns only
// status codes and the first bytes of each response, and requires a shared secret so it cannot be
// used as an open proxy. Set PROBE_KEY in Netlify environment variables.

const TARGETS = [
  { name: "canadabuys-open", url: "https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv" },
  { name: "canadabuys-new", url: "https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv" },
  { name: "austender-atm-page", url: "https://www.tenders.gov.au/atm" },
  { name: "austender-rss", url: "https://www.tenders.gov.au/public_data/rss/rss.xml" },
  { name: "austender-ckan", url: "https://data.gov.au/data/api/3/action/package_show?id=latest-approaches-to-markets-listed-on-austender" },
];

const AGENTS = {
  descriptive: "OpenTenderFinder/1.0 (public-interest tender search; +https://github.com/tender-finder)",
  none: undefined,
};

export default async (request) => {
  const headers = { "content-type": "application/json", "cache-control": "no-store" };
  const url = new URL(request.url);
  const expected = (process.env.PROBE_KEY || "").trim();

  if (!expected) {
    return new Response(JSON.stringify({
      error: "PROBE_KEY is not set.",
      how: "Add PROBE_KEY in Netlify > Site configuration > Environment variables, redeploy, then call this with ?key=THAT-VALUE.",
    }, null, 2), { status: 503, headers });
  }
  if (url.searchParams.get("key") !== expected) {
    return new Response(JSON.stringify({ error: "Bad or missing key." }), { status: 403, headers });
  }

  const results = [];
  for (const target of TARGETS) {
    for (const [agentName, agent] of Object.entries(AGENTS)) {
      const started = Date.now();
      try {
        const res = await fetch(target.url, {
          headers: agent ? { "user-agent": agent, "accept": "*/*" } : { accept: "*/*" },
          signal: AbortSignal.timeout(8000),
        });
        // Read a small sample only — these files can be very large.
        const reader = res.body?.getReader();
        let sample = "";
        if (reader) {
          const { value } = await reader.read();
          sample = new TextDecoder().decode(value || new Uint8Array()).slice(0, 180);
          try { await reader.cancel(); } catch { /* ignore */ }
        }
        results.push({
          target: target.name,
          agent: agentName,
          status: res.status,
          ok: res.ok,
          contentType: res.headers.get("content-type"),
          ms: Date.now() - started,
          sample: sample.replace(/\s+/g, " ").trim(),
        });
      } catch (err) {
        results.push({ target: target.name, agent: agentName, error: err.name, ms: Date.now() - started });
      }
    }
  }

  const verdictFor = (prefix, name) =>
    results.some((r) => r.target.startsWith(prefix) && r.ok)
      ? `${name} IS reachable from this datacentre IP — a local failure was bot protection, and the source will work in production ingestion.`
      : `${name} was NOT reachable from here either — the block is not IP-based, so the URL or request shape needs changing.`;

  const verdict = {
    canadabuys: verdictFor("canadabuys", "CanadaBuys"),
    austender: verdictFor("austender-rss", "The AusTender RSS feed"),
  };

  return new Response(JSON.stringify({ verdict, results, note: "Delete netlify/functions/probe.js once you have your answer." }, null, 2), { status: 200, headers });
};
