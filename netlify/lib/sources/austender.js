// Source: AusTender (Australia federal), served from the daily ingested index.
// See ingest/sources/ for how the data is collected and why it is cached rather than queried live.

import { makeCachedSource } from "./cached.js";

const cached = makeCachedSource({
  id: "AUSTENDER",
  label: "AusTender (Australia federal)",
  countries: ["AUS"],
  indexName: "austender",
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
