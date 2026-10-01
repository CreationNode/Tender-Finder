# HANDOFF — Open Tender Finder

Briefing for the coding agent taking over this project. Read this first, then `README.md`
(operational detail, per-source notes) and `OPERATIONS.md` (update/publish/SEO plan).

---

## 0. Before you touch anything

**Confirm which build you are working from.** This document describes the build in
`tender-finder-netlify.zip` (package version 1.0.0, eight sources, verified live Aug 2026). The owner
has since received a later build from another session — **tender-finder-v3 (v1.1.0)** — which adds a
`site/` directory, a `GITHUB-SETUP.md`, and a decision to add **Spain PLACSP** as a ninth source before
the repo goes to GitHub. If you have been given v3, it is the base; use this document for architecture
and history, and diff against v3 before assuming any file path below. Open v3 items noted by the owner:
PLACSP to be (re-)added if wanted, SAM key rotation, `data/cpv-full.json` to be copied in.

**Secrets.**
- Never commit, log, echo, or write a credential into source, docs, commit messages or PR text.
- Keys live only in a git-ignored `.env` locally and in GitHub Actions secrets / Netlify env vars.
- An earlier zip of this project shipped with a populated `.env` inside it. The SAM.gov key in it is
  **considered exposed and must be rotated**. It expires around 14 Nov 2026 anyway; rotate by ~8 Nov.
  SAM allows one active individual key at a time, so rotation = update `.env` **and** the
  `SAM_API_KEY` GitHub secret together.
- Before any push: `git status --porcelain | grep '\.env'` must return nothing (`.env.example` is fine).

**Access ethics (non-negotiable project policy).**
- Do not scrape any site whose robots.txt or terms disallow automated access.
- Exception, decided by the owner on 2026-10-01: a feed or API that the operator itself documents as
  open data for reuse may be used even under a blanket robots.txt (`Disallow: /`), which is aimed at
  crawlers walking web pages. Use it lightly, identify the agent, link back to every notice. Web
  pages still follow robots.txt. (Spain's PLACSP ATOM feed is used on this basis.)
- No headless-browser evasion, browser impersonation, residential proxies or other bot-evasion to get
  around a block. The user agent is an honest crawler string with a contact URL.
- If an official source blocks automated access, the answer is: request access from the operator, or
  document the gap in `SOURCES.md`. (Texas ESBD was rejected on these grounds; CanadaBuys is pending.)

---

## 1. What this is

A free, no-account public web app. A supplier types what they make in plain words ("ballistic
helmets", "school furniture", "solar panels"); the app translates that into procurement classification
codes (CPV, plus PSC/NAICS, GSIN/UNSPSC for the US/Canada), queries official tender portals, and shows
**currently open** public contracts, with honest per-source coverage reporting.

It began as an internal Python tool for a ballistic-armour company (the "Adept Tender Engine"); that
codebase is separate and **not** part of this handoff. This project is the generalised public tool.

**Product target (agreed with owner):**
> A small supplier anywhere in the EU types what they make, in their own words, and sees every open
> public contract for it — including below-threshold ones — in under two seconds, free, with no account.

**Success metrics:** dictionary match rate > 80%; below-threshold notices from ≥ 5 countries; the page
still returns TED results when every national source is down; contributions (dictionary suggestions)
arrive from users.

---

## 2. Architecture

```
Browser (index.html, ES module, no framework, no build step)
   │  POST /.netlify/functions/search  { cpvCodes, keywords, curatedLabels, country, daysBack, ... }
   ▼
Netlify Function: search.js  ── orchestrator
   ├── LIVE sources (queried per request):   TED, BOAMP
   └── CACHED sources (read JSON index, filter in memory):
         SAM.gov, CanadaBuys, Prozorro, UK Find a Tender, UK Contracts Finder, AusTender
                    ▲
                    │ JSON indexes (data/index/<source>.json) fetched from INDEX_BASE_URL
                    │ (orphan `indexes` branch on GitHub) or, fallback, from the site itself
                    │
GitHub Actions (daily 05:17 UTC) → node ingest/run.mjs → builds indexes → force-pushes `indexes` branch
```

- **Hosting:** Netlify. `netlify.toml`: `publish = "."`, `functions = "netlify/functions"`, esbuild
  bundler, security headers. No database. Telemetry aggregates in **Netlify Blobs**.
- **Runtime:** Node ≥ 18 (developed/tested on Node 20–22). `package.json` is `"type": "module"`.
  No npm dependencies at all — everything uses `fetch` and the standard library. Keep it that way
  unless there is a strong reason.
- **Owner's environment:** Windows + PowerShell. The `.cmd` helpers exist for them. Any instructions
  you give the owner must be PowerShell-correct (no `VAR=x cmd` bash syntax; `notepad .env` saves as
  `.env.txt` — a real past pitfall).

### 2.1 The source contract (the core abstraction)

Every source module in `netlify/lib/sources/` exports:

```js
export const id = "ukfts";
export const label = "UK Find a Tender";
export const countries = ["GBR"];     // null = multi-country (TED)
export const enabled = true;
export async function search(params) { ... }  // MUST NEVER THROW
// returns { notices: Notice[], variant: string, diagnostics: string[], ageHours?: number }
```

Notice shape (shared by all sources):
```js
{ id, title, buyer, country, deadline, daysLeft, published, cpv, link, source }
```

Orchestrator guarantees (`search.js`):
- Sources selected by country (`selectSources`); out-of-scope and disabled sources are reported, not
  silently skipped.
- `Promise.allSettled` + 6 s per-source timeout (`fetchWithTimeout` in `contract.js`). One dead portal
  can never break the page.
- Closed notices are dropped everywhere (`isStillOpen`).
- Conservative cross-source dedupe (`contract.js`: same country + same deadline + ≥ 0.7 title-token
  overlap; survivor gets `alsoOn`). Loosen only with evidence.
- Sorted by urgency (`byUrgency`).
- Per-source coverage status is returned and rendered: found / no results / not in scope / needs key /
  key expired / unavailable / STALE (> 48 h old index). **Honest coverage reporting is a core product
  value — never hide a failing source.**

### 2.2 Cached sources and the index format

- `netlify/lib/sources/cached.js` → `makeCachedSource({ id, label, countries, indexName, codeMatcher })`.
  Reads `${INDEX_BASE_URL}/<indexName>.json` (else `${origin}/data/index/…`), memoised 10 min,
  flags STALE after 48 h, returns `ageHours`. Filtering is a full scan of the index per request.
- Index format (`ingest/lib/index-format.mjs`): rows as arrays,
  `COLUMNS = ["id","title","buyer","country","deadline","published","codes","link"]`. Only open
  notices are stored.
- **Yield canary** (`canaryVerdict`, minRatio 0.4, floor 50): ingestion refuses to overwrite a healthy
  index if the new row count falls below 40% of the previous one. Override with `FORCE=1`. This exists
  because a stale-but-working-looking index was the recurring failure mode of the predecessor project.
- Incremental sources persist a cursor in `<source>.state.json`. `manifest.json` records per-source
  results for the workflow's report step.

### 2.3 Classification / query translation (front end)

- `data/cpv-map.json` — curated dictionary: 78 concepts, ~426 plain-language terms → CPV codes (+ US
  and Canadian codes where relevant).
- `data/cpv-full.json` — the full official CPV 2008 vocabulary (9,454 codes, ~380 KB), **generated**
  from the EU XML via `node tools/build-cpv-list.mjs <path-to-cpv_2008.xml | .zip | URL>`. Not included
  in the zip; must be generated or copied in. The official ZIP uses Deflate64, which neither Node nor
  PowerShell can extract — extract it with 7-Zip first (the tool raises an actionable error).
- `assets/rank.mjs` — **shared** ranker used by both the site and `tools/rank-test.mjs`, so ranking is
  testable offline. Score = `hits*3 + partials`, +10 if all query words hit, +15 exact phrase, +6
  contains phrase, ties → shorter label. (The all-words bonus fixed "Panels" outranking "Solar panels".)
  `index.html` imports it, so **`assets/rank.mjs` must always deploy alongside `index.html`.**

---

## 3. File map

```
index.html                     Whole UI: search, translation strip, code chips, tile map (TILES array,
                               39 tiles; "deep" = CAN USA GBR FRA UKR AUS), grouped country dropdown,
                               results, coverage line, diagnostics disclosure, SEO head block.
assets/rank.mjs                Shared CPV ranker (see 2.3).
data/cpv-map.json              Curated dictionary.
data/cpv-full.json             Generated full vocabulary (absent from zip).
data/index/                    Local index output (README only in repo; real data lives on `indexes` branch).
netlify.toml
netlify/functions/search.js    Orchestrator.
netlify/functions/stats.js     GET ?days=N → totals, matchRate, emptyRate, topMisses.
netlify/functions/probe.js     TEMPORARY CanadaBuys/AusTender reachability probe, gated by PROBE_KEY.
                               DELETE after the CanadaBuys question is settled.
netlify/lib/telemetry.js       safeTerm, logMetric ("SEARCH_METRIC"), recordAggregate (Blobs store
                               "tender-finder-stats", daily/YYYY-MM-DD.json, top 300 misses).
netlify/lib/sources/
  contract.js                  fetchWithTimeout, daysUntil, isStillOpen, normaliseText, dedupe, byUrgency.
  ted.js                       LIVE. See quirks in §4.
  boamp.js                     LIVE, France only. OpenDataSoft v2.1 API.
  cached.js                    Factory for cached sources.
  sam.js canadabuys.js prozorro.js ukfts.js ukcf.js austender.js   Thin cached wrappers.
ingest/run.mjs                 Runs ingesters (all, or named ones as args); writes indexes/state/manifest;
                               canary; warns > 5 MB; exit 1 if any source failed.
ingest/verify.mjs              Dry run: writes nothing, masked creds, 1-page budgets, OK/FAIL + sample row.
ingest/lib/csv.mjs             Streaming CSV (streamCsvRows).
ingest/lib/index-format.mjs    COLUMNS, toRow, buildIndex, canaryVerdict.
ingest/lib/ocds.mjs            OCDS helpers: isOpportunity (tender/planning tags only), releaseToRow,
                               crawlOcds with multi-location next-link detection + diagnostic.
ingest/lib/http.mjs            USER_AGENT, ingestHeaders, politeFetch (403 header retry, 429/5xx backoff).
ingest/lib/env.mjs             loadEnv (.env), maskSecret.
ingest/sources/*.mjs           One ingester per cached source (see §4).
tools/build-cpv-list.mjs       CPV vocabulary builder (ZIP/URL/CSV/XML).
tools/lib/zip.mjs              Minimal ZIP reader (stored/deflate).
tools/rank-test.mjs            Offline ranking check against the real vocabulary.
.github/workflows/ingest.yml   Daily ingestion (see §5).
*.cmd                          Windows helpers: Verify_Sources, Run_Ingest, Commit_Indexes, Set_Secrets.
robots.txt sitemap.xml         Domain placeholders.
README.md OPERATIONS.md        Operational docs.
.env.example                   Template. `.env` must never be committed or deployed.
```

All `.js`/`.mjs` files pass `node --check`. There is **no automated test suite** beyond
`tools/rank-test.mjs` and `ingest/verify.mjs` (a live smoke test).

---

## 4. Sources — status and quirks

Verified live from the owner's machine, Aug 2026, and deployed working on Netlify.

| Source | Kind | Scope | Status | Notes |
|---|---|---|---|---|
| TED | live | EU/EEA (multi) | ✅ | Payload quirks below. |
| BOAMP | live | FRA | ✅ | Text search on `objet`. |
| SAM.gov | cached | USA | ✅ ~28k open of ~81k | Daily bulk CSV (~6.6 MB index). Needs `SAM_API_KEY`. |
| UK Find a Tender | cached | GBR | ✅ ~570 | OCDS, `updatedFrom/updatedTo` cursor. |
| UK Contracts Finder | cached | GBR | ✅ ~150 | OCDS, `publishedFrom/To`, `stages=planning,tender`. Below-threshold. |
| Prozorro | cached | UKR | ✅ ~560, grows daily | Incremental feed + per-tender detail fetch. |
| AusTender | cached | AUS | ⚠️ ~90 | RSS lacks deadline and buyer; see below. |
| CanadaBuys | cached | CAN | ❌ HTTP 403 | Blocked from owner's residential IP on every URL; untested from CI. |

**TED (`ted.js`)** — the request payload must match exactly what worked in the predecessor engine:
`limit` as a **string**, `onlyLatestVersions: false`, full-text query as bare words. Degrades through an
attempt ladder: country+date+sort → country+date → date+sort → date → default fields → bare. The
`variant` actually used is reported. Past failure: diverging from this payload made every search fail.

**SAM.gov (`sam-bulk.mjs`)** — a non-federal individual key allows ~10 requests/day, so per-request
live API use is impossible; the daily public bulk CSV is used instead. Accept-header negotiation
(`*/*` → `text/csv,…` → none) fixed an HTTP 406. Distinguishes an HTML network-block page from a real
key rejection (a previous version misreported blocks as "key expired"). Drops closed/inactive rows.
`SAM_BULK_CSV_URL` override is optional; default URL works.

**Prozorro (`prozorro.mjs`)** — the feed ignores `opt_fields`, so each candidate tender's detail is
fetched (`PROZORRO_MAX_DETAILS`, default 400/run). Cold start seeds with `descending=1`, then parks an
**ascending** cursor (`ascOffset`); a descending cursor crawled into the past forever. Open statuses:
`active.tendering`, `active.enquiries`, `active.auction`. IDs get `UA-` prefix only if missing (there
was a `UA-UA-` bug). Titles are Ukrainian — see the language-layer roadmap item.

**UK (`uk-fts.mjs`, `uk-cf.mjs`)** — 45-day cold lookback, 2-day overlap on subsequent runs. Pagination
was once stuck at one page; `findNextLink` now checks `links.next`, `links.nextPage`, `next_page.uri`,
`nextPage`, `pagination.next` and emits a diagnostic when none are found.

**AusTender (`austender.mjs`)** — feed discovered via data.gov.au CKAN →
`https://www.tenders.gov.au/public_data/rss/rss.xml`. Needed the conventional crawler UA (403
otherwise). **The feed only has title / link / one-line description / guid / pubDate** — no closing
date, no agency (confirmed with `AUSTENDER_DEBUG=1`). Rows therefore expire by age
(`AUSTENDER_MAX_AGE_DAYS`, default 90), labelled in the UI as an estimate. A known-label parser is kept
in case the feed gains fields. A better AusTender source (per-ATM detail pages, if permitted, or another
official dataset) is an open improvement.

**CanadaBuys (`canadabuys.mjs`)** — candidate CSV URLs plus CKAN discovery
(`open.canada.ca … package_show?id=6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2`); parses bilingual columns and
`*`-separated multi-values. Every URL returns 403 from the owner's IP, apparently IP-level. **Next step:**
see whether it works from the GitHub Actions runner on the first workflow run, and/or deploy the probe
function with `PROBE_KEY` set and call it from Netlify's IPs. If blocked everywhere, contact the
operator and document it — do not circumvent.

---

## 5. Operations

**Ingestion workflow (`.github/workflows/ingest.yml`):** cron `17 5 * * *` + manual dispatch with a
`force` input; `permissions: contents: write`; concurrency-guarded. Steps: Run ingestion (env
`SAM_API_KEY`, `SAM_BULK_CSV_URL`, `FORCE`) → **Publish indexes to orphan `indexes` branch** (force-push,
`if: always()` so one failing source never discards the others' output — a real past bug) → optional
commit to `main` if repo variable `COMMIT_INDEXES_TO_MAIN == 'true'` → Report → "Fail only if every
source failed" (reads `manifest.json`).

Why an orphan branch: the SAM index alone is ~7 MB; daily commits to `main` would add ~2 GB/year of
worthless history. The site reads the branch through
`INDEX_BASE_URL = https://raw.githubusercontent.com/<owner>/<repo>/indexes/data/index`, so **data
refreshes need no redeploy**.

**Environment variables**

| Name | Where | Purpose |
|---|---|---|
| `SAM_API_KEY` | GitHub secret, local `.env` | SAM bulk download. Required for US data. |
| `SAM_BULK_CSV_URL` | optional secret | Override SAM bulk URL. |
| `AUSTENDER_RSS_URL` | optional | Override if CKAN discovery fails. |
| `CANADABUYS_CSV_URL` | optional | Override CanadaBuys URL. |
| `PROZORRO_MAX_DETAILS` | optional | Detail fetches per run (default 400). |
| `AUSTENDER_MAX_AGE_DAYS` | optional | Age-based expiry (default 90). |
| `AUSTENDER_DEBUG` | local | Dump a raw feed item. |
| `FORCE` | workflow input | Bypass the yield canary. |
| `INDEX_BASE_URL` | Netlify env | Where cached sources read indexes. |
| `PROBE_KEY` | Netlify env | Gates the temporary probe function. |
| `COMMIT_INDEXES_TO_MAIN` | GitHub repo variable | Fallback: commit indexes to main instead. |

**Local commands:** `npm run verify` (dry run), `npm run ingest` (all) or
`node ingest/run.mjs <id> …`, `node tools/rank-test.mjs`, `npm run cpv -- <path>`.

**Telemetry:** privacy-preserving by design — no IP, UA or cookies; searches are counted; only
*failed* (unmatched) search text is kept, truncated, with emails and long digit runs discarded. Read via
`/.netlify/functions/stats?days=N`. High match rate + high empty rate means "codes right, nothing open
now", not a bug.

---

## 6. Current state of the deployment

- Deployed to Netlify manually (drag-and-drop of the project folder) with locally built indexes.
  Owner reports "everything seems to work well."
- **Not yet on GitHub.** The owner deliberately held GitHub back until the build was final. Consequently
  the daily workflow has never run, and indexes are only as fresh as the last manual build.
- Placeholders still present: `REPLACE-WITH-YOUR-DOMAIN` (index.html ×3, robots.txt, sitemap.xml) and
  `YOUR-USERNAME` (the "suggest a better match" GitHub issue link in index.html).
- Past operational pitfall: the owner had two copies of the project folder and repeatedly ran/deployed
  the old one. When giving instructions, name one folder explicitly.

---

## 7. Prioritised backlog

**P0 — go live safely**
1. Reconcile with the v3 build (see §0) and pick one canonical tree.
2. Ensure `.env` is absent from the repo and from any Netlify deploy; set `SAM_API_KEY` as a Netlify
   env var only if a function ever needs it (currently only ingestion does).
3. Push to GitHub; add `SAM_API_KEY` secret; set **Settings → Actions → General → Workflow permissions
   → Read and write** (without it the workflow goes green but publishes nothing); run the workflow
   once; set `INDEX_BASE_URL` in Netlify.
4. Rotate the exposed SAM key (update `.env` and secret together). Calendar: rotate again before expiry.
5. Settle CanadaBuys (first CI run and/or probe), then **delete `netlify/functions/probe.js`**.
6. Replace domain and username placeholders.

**P1 — prove it works, then fix what it shows**
7. Retrieval-quality check: ten realistic searches across countries and sectors, written down with
   results. Specifically suspect US precision (28k rows matched on title keywords). Fix via
   `assets/rank.mjs`, `data/cpv-map.json`, or dedupe — with evidence.
8. Add a real test suite (Node's built-in `node:test`, no deps): `rank.mjs`, `index-format.mjs`
   (canary), `ocds.mjs` (`isOpportunity`, `findNextLink`), `contract.js` (dedupe, `isStillOpen`,
   `daysUntil` — **inject `now`, never read the wall clock inside tested logic**; the predecessor had a
   test broken by a hard-coded date), and CSV parsing, using small recorded fixtures. Run in CI.
9. `SOURCES.md`: per portal — access method, licence, terms, attribution. Plus a short privacy note in
   the UI matching §5 telemetry.
10. Accessibility and mobile pass on the tile map, search and results.

**P2 — scale and comprehension**
11. Inverted index: build token → row-id maps at ingest time, shard by prefix, fetch only what a query
    needs. Required before coverage roughly doubles; current full-scan is fine at ~30k rows.
12. Language layer: classification crosswalk CPV ↔ UNSPSC ↔ PSC/NAICS ↔ GSIN, and translated
    dictionary terms for the largest markets (Prozorro titles are Ukrainian; coverage already outruns
    comprehension).
13. Optional deadline horizon / pruning if indexes keep growing.

**P3 — more sources** (verify an *opportunity* feed exists before writing code; most procurement open
data is award/contract history, which is the wrong shape — Mexico and the OCP Data Registry were both
dead ends for this reason)
14. Done 2026-10-01: Spain PLACSP, Brazil PNCP, Netherlands TenderNed (public TNS webservice, CC0) and
    Poland BZP (open notice API: PageSize/PageNumber/PublicationDateFrom/To, verified live).
    Italy is open: ANAC's documented open-data portal (dati.anticorruzione.it) answers GitHub runners
    with an F5 "URL rejected" 403, and the legal-publicity platform's JSON API
    (pubblicitalegale.anticorruzione.it/api/v0/...) works keyless but is the site's own undocumented
    backend, not a feed published for reuse. The owner chose (2026-10-01) to use it with light,
    identified use, but a cloud session's safety check refused to probe it, so it is not built yet. Still unverified: Norway Doffin, Ireland eTenders (OCDS).
15. Adding a source: (a) ingester in `ingest/sources/`, (b) register in `ingest/run.mjs` `INGESTERS`,
    (c) cached wrapper in `netlify/lib/sources/`, (d) add to `SOURCES` in `search.js`, (e) set the
    country tile to `"deep"` in `TILES` in `index.html`, (f) README + SOURCES.md rows.

**P4 — deliberately last**
16. Email alerts. Changes the project's nature (stored emails, GDPR, unsubscribe, deliverability).
    Only once coverage is good enough that alerts would fire.

SEO and launch plan: see `OPERATIONS.md` Parts 3–4 (meta/OG/JSON-LD/robots/sitemap already done;
the real SEO lever is a few genuinely useful static explainer pages per country).

---

## 8. Working conventions

- `search()` never throws; every failure becomes a diagnostic string the UI can show.
- Prefer honesty over coverage: an unavailable source is shown as unavailable, stale data as STALE.
- No new runtime dependencies without a clear reason. No build step for the front end.
- Keep ingesters polite: honest UA, backoff on 429/5xx, modest page budgets, no parallel hammering.
- Code comments explain *why* (most past bugs are documented inline at the fix site — keep that habit).
- The owner prefers direct, detailed explanations and substantive pushback over agreement; flag
  architectural problems plainly rather than working around them.
- The code is MIT-licensed (owner's choice, 2026-10-01; see `LICENSE`). The licence covers the code and
  dictionary, not the tender data, which stays under each portal's own terms.
