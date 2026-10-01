// Source: TenderNed (Netherlands), served from the daily ingested index.
//
// National notices only: Dutch tenders above the EU threshold are on TED, which is searched live.
// Titles are Dutch; CPV codes (looked up per notice during ingest) let English searches match.
// Set TENDERNED_DISABLED=1 in Netlify to switch it off without new code.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "TENDERNED",
  label: "TenderNed (Netherlands)",
  countries: ["NLD"],
  indexName: "tenderned",
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.TENDERNED_DISABLED !== "1";
export const search = cached.search;
