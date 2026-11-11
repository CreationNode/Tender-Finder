// RSS feed for a saved search: /feed?q=body+armour&country=GBR
//
// The same search the page runs, as RSS 2.0, so anyone can follow a search in a feed reader with no
// account and no email address. The words go through the same dictionary (assets/match.mjs) and the
// same search core (netlify/lib/run-search.js) as the page, so the feed lists what the page would.
//
// Feed readers poll, often hourly. Responses are cached on Netlify's CDN for an hour per URL, so a
// popular feed asks TED and BOAMP once an hour however many people follow it. Feed requests are not
// counted in the search statistics.

import { normalize, runSearch } from "../lib/run-search.js";
import { matchCodes, searchPayload } from "../../assets/match.mjs";

let mapMemo = null;
async function loadMap(origin) {
  if (mapMemo && Date.now() - mapMemo.at < 3600e3) return mapMemo.map;
  const res = await fetch(`${origin}/data/cpv-map.json`);
  if (!res.ok) throw new Error(`dictionary: HTTP ${res.status}`);
  mapMemo = { map: await res.json(), at: Date.now() };
  return mapMemo.map;
}

const xml = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
const rfc822 = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? new Date(t).toUTCString() : null; };
const httpLink = (u) => (/^https?:\/\//i.test(String(u ?? "").trim()) ? String(u).trim() : null);

// Cached sources append an estimated value to the codes field as "· 120000 EUR".
function codesAndValue(raw) {
  const parts = String(raw || "").split(" · ").filter(Boolean);
  const m = /^(\d+(?:\.\d+)?) ([A-Z]{3})$/.exec(parts[parts.length - 1] || "");
  if (m) parts.pop();
  return [parts.length && `Codes: ${parts.join(" · ")}`, m && `Value: ${Number(m[1]).toLocaleString("en-GB")} ${m[2]}`];
}

function text(status, body) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export default async (request) => {
  const url = new URL(request.url);
  const origin = url.origin;
  const q = (url.searchParams.get("q") || "").replace(/\s+/g, " ").trim().slice(0, 120);
  const country = (url.searchParams.get("country") || "").replace(/[^A-Z]/gi, "").slice(0, 3).toUpperCase();
  const extra = (url.searchParams.get("cpv") || "").split(",").map((c) => c.replace(/\D/g, "")).filter((c) => c.length === 8).slice(0, 10);
  if (!q) return text(400, "Add what you supply, for example /feed?q=body+armour");

  let map;
  try { map = await loadMap(origin); }
  catch (err) { return text(503, `The dictionary could not be loaded (${err.message}). Try again later.`); }

  const hits = matchCodes(q, map);
  const { params, error } = normalize(searchPayload(q, hits, { country, extra }), origin);
  if (error) return text(400, error);
  const { results, sources } = await runSearch(params);

  const labelOf = Object.fromEntries(sources.map((s) => [s.source, s.label]));
  const answered = sources.filter((s) => !s.skipped && (s.status === "ok" || s.status === "stale")).map((s) => s.label);
  const failed = sources.filter((s) => !s.skipped && s.status && s.status !== "ok" && s.status !== "stale").map((s) => s.label);

  // Newest first, which is what a feed reader expects; notices without a published date go last.
  const items = [...results]
    .sort((a, b) => (Date.parse(b.published) || 0) - (Date.parse(a.published) || 0))
    .slice(0, 60);

  const pageLink = `${origin}/?${new URLSearchParams({ q, ...(country ? { country } : {}) })}`;
  const selfLink = `${origin}/feed?${url.searchParams}`;
  const title = `What They Buy: ${q}${country ? ` (${country})` : ""}`;
  const about = [
    `Open public tenders matching “${q}”${hits.length ? `, read as ${hits.map((h) => h.label).join(", ")}` : ""}.`,
    `Searched: ${answered.join(", ") || "none"}.`,
    failed.length ? `Not reached this time: ${failed.join(", ")}.` : "",
    "Each notice belongs to the portal that published it; always confirm details there.",
  ].filter(Boolean).join(" ");

  const itemXml = items.map((n) => {
    const link = httpLink(n.link);
    const lines = [
      n.buyer && `Buyer: ${n.buyer}`,
      n.country && `Country: ${n.country}`,
      `Deadline: ${n.deadline ? String(n.deadline).slice(0, 10) : "not given"}`,
      ...codesAndValue(n.cpv),
      `Source: ${labelOf[n.source] || n.source}`,
    ].filter(Boolean);
    const pub = rfc822(n.published);
    return [
      "<item>",
      `<title>${xml(n.title || "Untitled notice")}</title>`,
      link ? `<link>${xml(link)}</link>` : "",
      `<guid isPermaLink="false">${xml(`${n.source}:${n.id || link || n.title}`)}</guid>`,
      pub ? `<pubDate>${pub}</pubDate>` : "",
      `<description>${xml(lines.join("\n"))}</description>`,
      "</item>",
    ].join("");
  }).join("\n");

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(title)}</title>
<link>${xml(pageLink)}</link>
<atom:link href="${xml(selfLink)}" rel="self" type="application/rss+xml"/>
<description>${xml(about)}</description>
<language>en</language>
<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
<ttl>60</ttl>
${itemXml}
</channel>
</rss>
`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "public, max-age=1800",
      "netlify-cdn-cache-control": "public, durable, max-age=3600, stale-while-revalidate=3600",
    },
  });
};

export const config = { path: "/feed", method: "GET" };
