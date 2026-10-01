// Source: PLACSP (Spain), served from the daily ingested index.
//
// Spain's own platform, including below-threshold contracts that TED never sees. Notices carry CPV
// codes, so English searches match through the dictionary's codes. Set PLACSP_DISABLED=1 in Netlify
// to switch it off without a deploy of new code.

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
export const enabled = process.env.PLACSP_DISABLED !== "1";
export const search = cached.search;
