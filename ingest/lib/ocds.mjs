// Shared OCDS (Open Contracting Data Standard) helpers.
//
// OCDS is the closest thing procurement has to a lingua franca: the UK, Mexico, Australia (awards),
// and dozens of others publish it. Anything speaking OCDS can reuse this mapping, so each new OCDS
// publisher becomes a thin file rather than a new parser.
//
// The one subtlety that matters for THIS tool: an OCDS release carries a `tag` array describing its
// stage — planning, tender, award, contract, implementation. Only `tender` (and `planning`, which
// signals an upcoming buy) represents something you can still bid on. Award and contract releases
// are history. Filtering on tag is what stops the index filling with completed contracts.

import { toRow } from "./index-format.mjs";

export const OPPORTUNITY_TAGS = new Set(["tender", "planning"]);

export function isOpportunity(release) {
  const tags = Array.isArray(release.tag) ? release.tag : [release.tag].filter(Boolean);
  if (!tags.length) return Boolean(release.tender);      // some publishers omit tags
  // An award/contract release is history even if it also carries a tender tag.
  if (tags.includes("award") || tags.includes("contract") || tags.includes("implementation")) return false;
  return tags.some((t) => OPPORTUNITY_TAGS.has(t));
}

function isoDate(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

/** Collect CPV-ish classifications from wherever the publisher put them. */
function classifications(tender) {
  const out = [];
  const push = (c) => {
    if (!c) return;
    const id = String(c.id || "").trim();
    if (id) out.push(id);
  };
  push(tender.classification);
  for (const c of tender.additionalClassifications || []) push(c);
  for (const item of tender.items || []) {
    push(item.classification);
    for (const c of item.additionalClassifications || []) push(c);
  }
  return [...new Set(out)].slice(0, 6);
}

/**
 * Map one OCDS release to an index row.
 * @param opts.country  ISO3 country code for this publisher
 * @param opts.idPrefix short prefix so ids stay unique across sources
 * @param opts.linkFor  function(release) -> public URL
 */
export function releaseToRow(release, { country, idPrefix, linkFor }) {
  const tender = release.tender || {};
  const deadline =
    isoDate(tender.tenderPeriod?.endDate) ||
    isoDate(tender.enquiryPeriod?.endDate) ||
    "";
  const buyer =
    release.buyer?.name ||
    (release.parties || []).find((p) => (p.roles || []).includes("buyer"))?.name ||
    "";
  const codes = classifications(tender);
  const value = tender.value?.amount;
  const currency = tender.value?.currency || "";

  const rawId = String(release.ocid || release.id || "");
  return toRow({
    id: rawId ? `${idPrefix}-${rawId}` : "",
    title: String(tender.title || release.title || "").trim(),
    buyer: String(buyer).trim(),
    country,
    deadline,
    published: isoDate(release.date || tender.tenderPeriod?.startDate),
    codes: [
      ...codes.map((c) => `CPV ${c}`),
      value ? `${Math.round(value)} ${currency}` : "",
    ].filter(Boolean).join(" · "),
    link: linkFor(release) || "",
  });
}

/**
 * Walk a paginated OCDS endpoint. Publishers signal the next page via `links.next`; we stop at
 * the page budget, the time budget, or when the link disappears.
 */
/**
 * Find the "next page" link. Publishers put it in different places, and getting this wrong is
 * expensive but SILENT: you simply get the first 100 records and think that is all there is.
 * (That is exactly what happened on the first live UK run — 100 releases, one page, done.)
 * So we look in every documented location and, when we cannot find one, report what keys WERE
 * present instead of quietly stopping.
 */
function findNextLink(pkg) {
  const candidates = [
    pkg?.links?.next,
    pkg?.links?.nextPage,
    pkg?.next_page?.uri,
    pkg?.nextPage,
    pkg?.pagination?.next,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^https?:\/\//.test(c)) return c;
  }
  return null;
}

export async function crawlOcds({ startUrl, fetchImpl, maxPages, budgetMs, onPage, log }) {
  const startedAt = Date.now();
  let url = startUrl;
  let pages = 0;
  const notes = [];

  while (url && pages < maxPages && Date.now() - startedAt < budgetMs) {
    const res = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (res.status === 429) { notes.push(`rate limited after ${pages} page(s)`); break; }
    if (!res.ok) {
      if (pages === 0) throw new Error(`HTTP ${res.status} on the first page of ${url}`);
      notes.push(`HTTP ${res.status} after ${pages} page(s); keeping what we have`);
      break;
    }
    const pkg = await res.json();
    const releases = pkg.releases || [];
    onPage(releases, pkg);
    pages++;

    if (!releases.length) { notes.push("stopped: empty page"); break; }

    const next = findNextLink(pkg);
    if (!next) {
      // Diagnostic, not silence: tell us where to look next time.
      const linkKeys = Object.keys(pkg.links || {});
      const topKeys = Object.keys(pkg).filter((k) => /link|next|page|cursor/i.test(k));
      notes.push(
        `stopped after ${pages} page(s): no next-page link found. ` +
        `links keys=[${linkKeys.join(",") || "none"}] top-level pagination-ish keys=[${topKeys.join(",") || "none"}]`
      );
      break;
    }
    if (next === url) { notes.push("stopped: next link equals current URL"); break; }
    url = next;
    if (log && pages % 5 === 0) log(`  …${pages} pages`);
  }
  return { pages, notes };
}
