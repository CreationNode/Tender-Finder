// Source: PLACSP (Spain), served from the daily ingested index.
//
// Disabled until PLACSP_ENABLED=1 is set in Netlify: the platform's robots.txt disallows bots, so
// under this project's access policy we ask the operator first (see ingest/sources/placsp.mjs).
// Notices carry CPV codes, so English searches match through the dictionary's codes.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "PLACSP",
  label: "PLACSP (Spain)",
  countries: ["ESP"],
  indexName: "placsp",
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.PLACSP_ENABLED === "1";
export const search = cached.search;
