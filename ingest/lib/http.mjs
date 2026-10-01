// Shared HTTP for ingestion.
//
// We identify ourselves honestly instead of pretending to be a browser: a descriptive agent string
// with a contact URL is what a well-behaved collector does, and it is what lets an operator contact
// us rather than silently block us.

// The conventional format for a well-behaved crawler is the "Mozilla/5.0 (compatible; Name/version;
// +url)" pattern — the same shape Googlebot and Bingbot use. It is NOT impersonation: the bot names
// itself and gives a contact URL. It matters practically because many CDN filters match on the
// leading token, so a bare "Name/1.0" is rejected by naive rules while the conventional form passes.
// Identifying honestly and being readable by the filters are not in conflict.
export const USER_AGENT =
  process.env.INGEST_USER_AGENT ||
  "Mozilla/5.0 (compatible; WhatTheyBuy/1.0; public-interest tender search; +https://whattheybuy.org)";

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
 * A 403 is returned to the caller as it is. An earlier version retried it with a made-up Referer,
 * which is a way of getting past a block, and the project's access rules say a source that blocks
 * us is a question for its operator, never something to work around.
 */
export async function politeFetch(url, { headers = {}, timeoutMs = 60000, bodyTimeoutMs = 15 * 60000, retries = 1 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    // timeoutMs covers the response headers. The caller reads the body afterwards, so a second,
    // longer deadline stays armed after we return: a server that stalls mid-body (a 500 MB CSV that
    // stops arriving) is aborted instead of hanging the run. unref() so it never keeps Node alive.
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const bodyTimer = setTimeout(() => controller.abort(), bodyTimeoutMs);
    bodyTimer.unref?.();
    let handedOver = false;
    try {
      const res = await fetch(url, { headers: ingestHeaders(headers), signal: controller.signal });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      handedOver = true;
      return res;
    } finally {
      clearTimeout(timer);
      if (!handedOver) clearTimeout(bodyTimer);
    }
  }
}

/**
 * Fetch and read the whole body under ONE deadline. politeFetch's timeout only covers the response
 * headers, so a server that stalls mid-body hangs the caller forever: this is what froze the first
 * PLACSP run (4 MB pages) for 30 minutes until the job was cancelled.
 * Returns { ok, status, text, retryAfter }; with `binary: true`, the body is in `bytes` (a Buffer).
 */
export async function fetchText(url, { headers = {}, timeoutMs = 90000, retries = 1, binary = false } = {}) {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: ingestHeaders(headers), signal: controller.signal });
      const body = !res.ok ? "" : binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
      return { ok: res.ok, status: res.status, text: binary ? "" : body, bytes: binary ? body : null, retryAfter: Number(res.headers.get("retry-after")) || 0 };
    } catch (err) {
      if (attempt >= retries) throw new Error(`${err.name === "AbortError" ? "timed out" : err.message} reading ${url}`);
      await new Promise((r) => setTimeout(r, 3000));
    } finally {
      clearTimeout(timer);
    }
  }
}
