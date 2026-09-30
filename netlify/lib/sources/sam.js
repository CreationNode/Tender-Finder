// Source: SAM.gov — US federal contract opportunities, served from the daily ingested index.
//
// WHY THIS IS NOT A LIVE API CALL:
// a non-federal personal SAM.gov API key allows roughly TEN Get Opportunities requests per DAY.
// Live querying would exhaust the quota after two or three visitors and return 429s for everyone
// else. The daily bulk CSV is ONE request per day and yields the entire active dataset, so the same
// key that cannot power a website comfortably powers the whole index. See ingest/sources/sam-bulk.mjs.

import { makeCachedSource } from "./cached.js";

const cached = makeCachedSource({
  id: "SAM",
  label: "SAM.gov (US federal)",
  countries: ["USA"],
  indexName: "sam",
  // SAM classifies with PSC and NAICS, not CPV, so pass those through when the caller supplies them.
  codeMatcher: (params) => [
    ...(params.pscCodes || []).map((c) => `PSC ${c}`),
    ...(params.naicsCodes || []).map((c) => `NAICS ${c}`),
  ],
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
