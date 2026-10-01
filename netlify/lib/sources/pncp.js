// Source: PNCP (Brazil), served from the daily ingested index.
//
// Cached because a full sweep of PNCP's open procurements is ~550 paged requests: fine once a day
// from GitHub Actions, far too slow per search. Titles are Portuguese and carry no CPV codes, so
// English searches match through the dictionary's Portuguese terms (`ptTerms`), and Portuguese
// searches match the titles directly.

import { makeCachedSource } from "./cached.js";

const cached = makeCachedSource({
  id: "PNCP",
  label: "PNCP (Brazil)",
  countries: ["BRA"],
  indexName: "pncp",
  localTerms: (params) => params.ptTerms || [],
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
