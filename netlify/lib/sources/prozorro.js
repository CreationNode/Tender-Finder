// Source: Prozorro (Ukraine), served from the incrementally crawled index.
//
// Cached because Prozorro's public API is a change FEED, not a search endpoint: you cannot ask it
// "who is buying chairs", only "what changed since this cursor". The ingester walks that feed on a
// schedule and keeps an index of currently-open tenders; this searches it in milliseconds.
//
// Note on language: Prozorro titles are Ukrainian, with English titles present on some tenders.
// The ingester prefers `title_en` when available, so English keyword search works on part of the
// index and Ukrainian search works across all of it.

import { makeCachedSource, cpvPrefixes } from "./cached.js";

const cached = makeCachedSource({
  id: "PROZORRO",
  label: "Prozorro (Ukraine)",
  countries: ["UKR"],
  indexName: "prozorro",
  // Titles are Ukrainian; the ДК 021 (= CPV) codes stored at ingest are what English searches match.
  codeMatcher: cpvPrefixes,
});

export const id = cached.id;
export const label = cached.label;
export const countries = cached.countries;
export const enabled = cached.enabled;
export const search = cached.search;
