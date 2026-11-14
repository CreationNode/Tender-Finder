// Source: NSPA, the NATO Support and Procurement Agency, served from the daily ingested index.
//
// NSPA's open requests for proposals, from the XML file it publishes for partners' systems.
// Titles are English with no classification codes, so only words match. Listed under the
// "International" pseudo-country INT. Set NSPA_DISABLED=1 in Netlify to switch it off.

import { makeCachedSource } from "./cached.js";

const cached = makeCachedSource({
  id: "NSPA",
  label: "NSPA (NATO)",
  countries: ["INT"],
  indexName: "nspa",
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = process.env.NSPA_DISABLED !== "1";
export const search = cached.search;
