// Source: BZP (Poland), served from the daily ingested index.
//
// Poland's national bulletin, which carries the below-threshold notices TED never sees. Titles are
// Polish; every notice has CPV codes, so English searches match through the dictionary's codes.
// Set BZP_DISABLED=1 in Netlify to switch it off without new code.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "BZP",
  label: "BZP (Poland)",
  countries: ["POL"],
  indexName: "bzp",
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.BZP_DISABLED !== "1";
export const search = cached.search;
