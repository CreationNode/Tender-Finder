// Source: Doffin (Norway), served from the daily ingested index.
//
// Norway's national notice database: every public buyer, above and below the EEA threshold.
// Titles are Norwegian; CPV codes let English searches match. Set DOFFIN_DISABLED=1 in Netlify to
// switch it off without new code.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "DOFFIN",
  label: "Doffin (Norway)",
  countries: ["NOR"],
  indexName: "doffin",
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.DOFFIN_DISABLED !== "1";
export const search = cached.search;
