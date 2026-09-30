// Shared HTTP for ingestion.
//
// Government CDNs (Akamai, Cloudflare) routinely reject requests carrying Node's default
// `user-agent: node`, which is why CanadaBuys returned HTTP 403 while the same URL opens fine in a
// browser. We identify ourselves honestly instead of pretending to be a browser: a descriptive
// agent string with a contact URL is what a well-behaved collector does, and it is what lets an
// operator contact us rather than silently block us.

// The conventional format for a well-behaved crawler is the "Mozilla/5.0 (compatible; Name/version;
// +url)" pattern — the same shape Googlebot and Bingbot use. It is NOT impersonation: the bot names
// itself and gives a contact URL. It matters practically because many CDN filters match on the
// leading token, so a bare "Name/1.0" is rejected by naive rules while the conventional form passes.
// Identifying honestly and being readable by the filters are not in conflict.
export const USER_AGENT =
  process.env.INGEST_USER_AGENT ||
  "Mozilla/5.0 (compatible; OpenTenderFinder/1.0; public-interest tender search; +https://github.com/tender-finder)";

export function ingestHeaders(extra = {}) {
  return {
    "user-agent": USER_AGENT,
    "accept-language": "en-GB,en;q=0.9",
    // Some CDN rules reject requests that send no Accept-Encoding at all, treating them as scripted.
    "accept-encoding": "gzip, deflate",
    ...extra,
  };
}

/**
 * fetch with our agent, a timeout, and a polite retry on 429/5xx.
 *
 * On a 403 it retries ONCE with a fuller set of ordinary request headers (Referer, Accept). Some
 * CDN rules reject requests that omit headers a normal client always sends, and supplying them is
 * not deception — the User-Agent still names this project and links to it. If the second attempt is
 * also refused, the block is not about headers, and the caller reports the status rather than
 * escalating further.
 */
export async function politeFetch(url, { headers = {}, timeoutMs = 60000, retries = 1 } = {}) {
  let sawForbidden = false;

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const extra = sawForbidden
        ? {
            accept: headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            referer: new URL(url).origin + "/",
          }
        : {};
      const res = await fetch(url, { headers: ingestHeaders({ ...headers, ...extra }), signal: controller.signal });

      if (res.status === 403 && !sawForbidden) {
        sawForbidden = true;
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return res;
    } finally {
      clearTimeout(timer);
    }
  }
}
