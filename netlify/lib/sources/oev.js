// Source: oeffentlichevergabe.de (Germany), served from the daily ingested index.
//
// National German notices from the federal notice service's open-data exports. EU-wide German
// tenders are on TED, which is searched live. Titles are German; CPV codes let English searches
// match. Set OEV_DISABLED=1 in Netlify to switch it off without new code.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "OEV",
  label: "oeffentlichevergabe.de (Germany)",
  countries: ["DEU"],
  indexName: "oev",
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.OEV_DISABLED !== "1";
export const search = cached.search;
