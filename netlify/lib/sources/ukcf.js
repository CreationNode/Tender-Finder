// Source: Contracts Finder (UK, below threshold), served from the daily ingested index.
// See ingest/sources/ for how the data is collected and why it is cached rather than queried live.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "UK-CF",
  label: "Contracts Finder (UK, below threshold)",
  countries: ["GBR"],
  indexName: "ukcf",
  // UK notices carry CPV codes, so the dictionary's codes are real evidence here.
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
