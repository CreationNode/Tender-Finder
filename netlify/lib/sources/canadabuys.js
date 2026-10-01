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
// Off: the CanadaBuys portal refuses requests from our servers (HTTP 403, including from GitHub
// runners), so there is no index to read. Searches report it as disabled instead of asking for a
// file that will never exist. Turn back on once the operator grants access.
export const enabled = process.env.CANADABUYS_ENABLED === "1";
export const search = cached.search;
