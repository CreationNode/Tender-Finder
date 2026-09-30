// Source: CanadaBuys, served from the daily ingested index.
//
// Cached rather than live because the open-data file is a multi-megabyte CSV: downloading and
// parsing it inside a request would blow the function's time budget. Ingested once a day, it costs
// nothing and answers in milliseconds. No API key exists or is needed.
//
// GSIN codes mirror NATO supply classes and carry plain-English descriptions ("Armour, Personal"),
// which is why keyword search works well against this index.

import { makeCachedSource } from "./cached.js";

const cached = makeCachedSource({
  id: "CANADA",
  label: "CanadaBuys (Canada federal)",
  countries: ["CAN"],
  indexName: "canadabuys",
  codeMatcher: (params) => [
    ...(params.gsinCodes || []).map((c) => `GSIN ${c}`),
    ...(params.unspscCodes || []).map((c) => `UNSPSC ${c}`),
  ],
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
