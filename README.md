# Open Tender Finder

A free tool that turns plain language ("wooden chairs", "surgical gloves", "road resurfacing") into
the official EU procurement codes, then shows the **open public tenders** buying that thing right now.

Public contracts are open to anyone, but most small suppliers never see them: notices are filed under
numeric CPV codes, not words. This is the translation layer.

## Deploy to Netlify (about 3 minutes)

1. Push this folder to a GitHub repository.
2. In Netlify: **Add new site -> Import an existing project**, pick the repo.
3. Leave the build command empty; publish directory `.`; functions directory `netlify/functions`.
   (`netlify.toml` already sets this.)
4. Deploy. That's it — no environment variables, no database, no API key.

Local preview: `npm i -g netlify-cli && netlify dev`

## Ranking (assets/rank.mjs)

The plain-language -> CPV ranking lives in one module used by BOTH the website and
`tools/rank-test.mjs`, so ranking can be checked against the real 9,454-code vocabulary offline:

```
node tools/rank-test.mjs
node tools/rank-test.mjs "ballistic helmets" "fire hoses"
```

Scoring principles, each learned from real output:

1. **Covering all the user's words beats matching one.** An early version gave a large bonus when a
   label equalled any single query word, so "solar panels" ranked the generic *Panels* above
   *Solar panels*. Full coverage now dominates.
2. **Exact phrase equality is the strongest signal**, then containing the phrase.
3. **Shorter labels break ties**, because CPV nests general -> specific.
4. **Light plural handling** ("helmets" -> "helmet", "batteries" -> "battery"), because CPV labels
   are inconsistent about number.

A query with no CPV match is not a failure — the search falls back to full text across the sources.

## The coverage map

The page opens with a tile cartogram: one square per country, arranged roughly geographically. It is
deliberately **not** a geographic projection.

- Coverage is country-level, so borders carry no information here.
- A tile grid makes Malta and Luxembourg as legible as Germany.
- It cannot mislead about geography, which a hand-drawn or simplified border map easily can.

Squares are colour-coded: national portal ingested, EU-wide source only, or not covered yet.
Uncovered countries are shown on purpose — the gaps are information. After a search, countries that
returned results are highlighted with a count, and tapping any covered country filters the search to
it (tapping it again clears the filter).

To add a country to the map, add one entry to `TILES` in `index.html`:
`["ISO3","Name",gridColumn,gridRow,"deep|ted|none"]`. Set it to `deep` when a national portal is
ingested for it.

## Sources

| Source | Coverage | Auth | How it's queried | Licence | Status |
|---|---|---|---|---|---|
| **TED** | EU/EEA, above-threshold | none | CPV codes (precise) | EU reuse policy | live |
| **BOAMP** | France, **incl. below-threshold** | none | Text search (`objet`) | Licence Ouverte (Etalab) | live |
| **SAM** | US federal | **API key** (ingest only) | daily bulk CSV -> index | US public domain | cached |
| **CANADA** | Canada federal | none | daily open CSV -> index | Open Government Licence - Canada | cached |
| **PROZORRO** | Ukraine | none | incremental feed crawl -> index | Open data (Prozorro) | cached |
| **UK-FTS** | UK above-threshold | none | OCDS release packages -> index | OGL v3 | cached |
| **UK-CF** | UK **below-threshold** | none | OCDS search (stages=planning,tender) -> index | OGL v3 | cached |
| **AUSTENDER** | Australia federal | none | current-ATM RSS -> index | CC BY 3.0 AU (verify) | cached |
| **PLACSP** | Spain, **incl. below-threshold** | none | open-data ATOM feed (CODICE) -> index | Spanish public-sector reuse (verify); robots.txt is a blanket `Disallow`, used under the open-data exception in HANDOFF.md | cached |
| **PNCP** | Brazil, all levels of government | none | paged "open for proposals" API -> index | Brazilian public open data (verify) | cached |

Sources declare which countries they cover, so a US search never spends latency on TED and a French
search never calls SAM.gov. The coverage line under the results says which portals answered, which
were out of scope, and which are unavailable — the tool never implies it searched everywhere.

## Two kinds of source: live and cached

**Live** sources are queried per request (TED, BOAMP). They have generous, keyless, searchable APIs.

**Cached** sources are ingested on a schedule into `data/index/<source>.json`, committed to the repo,
served from CDN, and searched in memory (SAM.gov). This is not an optimisation — it is the only way
those sources work at all:

| Source | Why it cannot be live |
|---|---|
| SAM.gov | A non-federal personal API key allows ~**10 requests per day**. Live querying breaks after two or three visitors. The daily bulk CSV is **one** request and returns everything. |
| Prozorro | Public API is a change **feed** (ids + modification times), not a search endpoint. Crawled forward from a saved cursor. |
| CanadaBuys | Multi-megabyte CSV; too slow to fetch per request. Ingested daily instead — **no key required at all**. |

### Secrets: use .env locally, GitHub secrets in CI

Never put a credential in a source file or a script. Copy `.env.example` to `.env` and fill it in —
`.gitignore` excludes `.env`, so it cannot be committed:

```
SAM_API_KEY=SAM-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
SAM_BULK_CSV_URL=https://…
```

`node ingest/verify.mjs` and `node ingest/run.mjs` load it automatically and print which credentials
they can see, masked. An environment variable set in the shell always beats the file, so
`$env:SAM_API_KEY="…"` still works for a one-off test.

**Rotation:** SAM keys expire about every 90 days and only one individual key is active at a time.
When you rotate, update `.env` locally and the `SAM_API_KEY` repository secret — a stale key shows up
as a red ingestion run, not a broken site, because the previous index stays in place.

### SAM.gov setup

1. **Get a key:** sam.gov -> profile -> **Account Details** -> request a Public API Key (you re-enter
   your password; the key is shown once).
2. **Get the bulk URL:** sam.gov -> **Data Services** -> Contract Opportunities -> copy the CSV
   download URL.
3. **Add both as GitHub Actions secrets** (Settings -> Secrets and variables -> Actions):
   `SAM_API_KEY` and `SAM_BULK_CSV_URL`.
4. Run the workflow by hand once: Actions tab -> "Ingest tender sources" -> Run workflow.

**Keys rotate every 90 days and cannot be extended.** SAM auto-generates a replacement and emails
reminders from 15 days out; you update the GitHub secret. Because ingestion is a scheduled job, a
dead key shows up as a failed (red) Actions run rather than a broken website — the site keeps serving
the previous index. Set a calendar reminder anyway.

## Known live behaviour (verified 2026-08)

| Source | Status | Note |
|---|---|---|
| UK-FTS | working | 100 releases/page; ~20% are opportunities, the rest awards/contracts |
| UK-CF | working | ~87% opportunities — below-threshold notices, the richest source for small suppliers |
| Prozorro | working via fallback | the public feed does **not** honour `opt_fields`; details are fetched per tender, capped per run (`PROZORRO_MAX_DETAILS`, default 400) so the index warms up over several days. **Cursor direction matters:** a cold start sweeps newest-first, then parks an *ascending* cursor so later runs move forward in time. Following the descending feed would crawl into the past forever and never see a new tender |
| CanadaBuys | 403 from a home connection | bot protection, not a bad URL. Three official locations are tried and each status reported; a datacentre IP (GitHub Actions) is often accepted where a residential one is not — **run the workflow before concluding it is down** |
| AusTender | working, with a caveat | URL discovered from the data.gov.au CKAN record. **The feed publishes no closing dates and no agency** — only title, link, one-line description and publication date (verified against live output). Notices are therefore retired `AUSTENDER_MAX_AGE_DAYS` (default 90) after publication: an estimate, not data. Australian results show no deadline and no buyer |
| SAM | needs credentials | `SAM_API_KEY` + `SAM_BULK_CSV_URL` |
| PLACSP | working, slowly | open-data ATOM change log. Measured from GitHub: ~130 KB/s per connection and ~15 MB per full page, so ~115 s a page and ~8 pages in the 15-minute budget (`PLACSP_BUDGET_MS`, per-page deadline `PLACSP_PAGE_TIMEOUT_MS` 240 s). The head keeps the index current; coverage converges within one bidding window (2 to 4 weeks), helped by a 14-day backfill. Newest state per contract folder wins; only status PUB is kept |
| PNCP | working | ~27,000 open procurements, 50 per page (the API rejects larger pages). Each run reads the newest pages, then continues a ring cursor through the rest within `PNCP_BUDGET_MS` (default 12 min, about 200 pages; the full ring takes about three days). Expect an index of roughly 10 MB. Titles are Portuguese with no CPV: English searches match through the `pt` terms in `data/cpv-map.json` |

### Settling the CanadaBuys 403 (temporary probe)

`netlify/functions/probe.js` answers one question: is the 403 bot protection against home IPs, or a
bad URL? Netlify runs from a datacentre IP, which government CDNs often allow where they block
residential connections.

1. Netlify -> Site configuration -> Environment variables -> add `PROBE_KEY` = any random string.
2. Deploy, then open `https://YOUR-SITE.netlify.app/.netlify/functions/probe?key=YOUR-VALUE`.
3. Read the `verdict` field.
4. **Delete `netlify/functions/probe.js`** once answered.

It only GETs a fixed allow-list of public open-data URLs, returns status codes plus the first ~180
bytes, and requires the shared secret — it cannot be used as an open proxy.

### Finding the AusTender feed URL

Open <https://www.tenders.gov.au/atm> in a browser, look for the RSS icon or "Subscribe"/"RSS" link
on the Current ATM page, right-click -> Copy link address, and set it as `AUSTENDER_RSS_URL` (a
GitHub secret for CI, or `$env:AUSTENDER_RSS_URL="..."` in PowerShell for a local test). The feed is
also catalogued on data.gov.au as "AusTender approaches to market RSS feed".

## Troubleshooting: cached sources show "index not built yet"

That message means `data/index/<source>.json` does not exist — the site is fine, the ingestion has
not produced an index. In order:

1. **Has the workflow run?** Actions tab -> "Ingest tender sources" -> Run workflow.
2. **Did it commit?** Check for a `Refresh tender indexes (date)` commit and files in `data/index/`.
   The commit step runs even when some sources fail, by design — a source failing must never discard
   another source's successful output.
3. **Which portals actually respond?** Run the verifier locally — it writes nothing and takes under
   a minute.

   **Windows:** double-click `Verify_Sources.cmd`.

   **PowerShell** (note: `VAR=value command` is bash syntax and does NOT work here):
   ```powershell
   node ingest/verify.mjs                 # all sources
   node ingest/verify.mjs austender       # just one
   $env:SAM_API_KEY = "your-key-here"     # set first, on its own line
   node ingest/verify.mjs sam
   ```

   **macOS / Linux:**
   ```bash
   node ingest/verify.mjs
   SAM_API_KEY=xxx node ingest/verify.mjs sam
   ```

   It prints, per source, OK with a row count and a sample notice, or FAILED with the exact reason
   and the URL it tried. Paste the SUMMARY block when asking for help.

4. **Reachable but zero rows?** The portal answered and our filters removed everything — usually the
   date window or an over-tight status filter. That is a parsing problem, not a connectivity one.

## The ingestion pipeline

```
GitHub Actions (daily cron)  ->  ingest/run.mjs  ->  data/index/*.json  ->  committed  ->  CDN  ->  search
```

- `node ingest/run.mjs` runs everything; `node ingest/run.mjs sam` runs one source.
- **Yield canary:** if a source returns less than 40% of its previous row count, the run FAILS and
  the old index is left intact. A source that quietly changes format or stops publishing cannot
  silently empty the site. Override with `FORCE=1` once you have checked why.
- **Freshness is surfaced, never hidden.** Each cached result reports index age; over 48 hours the
  coverage line reads `SAM: 12 (index 3d old — STALE)`.
- Failures leave the previous index in place, so the site degrades to older data rather than nothing.
- `data/index/manifest.json` records per-source counts, sizes, timestamps and last error.

### Adding a cached source

1. Write `ingest/sources/<name>.mjs` exporting `source`, `label`, and `ingest()` returning
   `{ rows, notes }`, with rows built by `toRow()` from `ingest/lib/index-format.mjs`.
2. Register it in `INGESTERS` in `ingest/run.mjs`.
3. Create `netlify/lib/sources/<name>.js` using `makeCachedSource({ id, label, countries, indexName })`.
4. Add it to `SOURCES` in `netlify/functions/search.js`.

### CanadaBuys

Needs no configuration whatsoever — no key, no secret, no URL to paste. The daily open-data CSV is
published under the Open Government Licence - Canada and the ingester runs on the same schedule as
SAM. If the file ever moves, set `CANADABUYS_CSV_URL` as a secret to override the default.

GSIN codes carry plain-English descriptions ("Armour, Personal"), which are indexed alongside the
title — so a search for "armour" finds a notice titled "Fragmentation Protective Vests".

### Prozorro (incremental sources)

Prozorro is the first **incremental** ingester and the template for any future feed-based source.
It differs from the bulk ingesters in three ways worth understanding:

1. **Cursor.** The feed returns pages of changes plus a `next_page.offset`. That offset is saved to
   `data/index/prozorro.state.json` and the next run resumes from it, so each run does a bounded
   amount of work instead of re-crawling from 2016.
2. **Merge, not replace.** The ingester receives the previous index rows and merges: newly-open
   tenders are added, tenders that have since closed or completed are REMOVED, and anything whose
   deadline has passed is pruned even if the crawl did not revisit it.
3. **One request per 100 tenders.** `opt_fields` inlines title/status/dates into the listing, so a
   page costs one request rather than 101. If the API ever stops honouring it, the run ABORTS with
   an explanation rather than indexing a hundred blank titles.

Cold start: the first run walks newest-first, so the index is immediately useful and fills in over
the following days. Tune with `PROZORRO_MAX_PAGES` (default 40), `PROZORRO_PAGE_SIZE` (100), and
`PROZORRO_BUDGET_MS` (8 minutes).

**Language:** Prozorro titles are Ukrainian; `title_en` exists on some tenders and is preferred when
present. English search therefore covers part of the index and Ukrainian search covers all of it —
a real limitation, and an argument for adding translated keywords to the dictionary later.

### OCDS sources (UK, and the template for many more)

`ingest/lib/ocds.mjs` maps any Open Contracting Data Standard publisher to our row format. Dozens of
countries publish OCDS, so each new one is a thin file rather than a new parser.

The critical detail is the release `tag`. An OCDS release describes a STAGE — planning, tender,
award, contract, implementation. Only `tender`/`planning` is something you can still bid on;
`award` and `contract` are history. Without that filter the index fills with completed contracts
that look exactly like opportunities. Both UK sources use it, and a release that turns into an award
between runs is REMOVED from the index.

**Two UK sources, deliberately.** Find a Tender carries above-threshold notices; Contracts Finder
carries the below-threshold ones (from ~£12k central / £30k wider public sector). For the small
suppliers this tool serves, Contracts Finder is the more valuable of the two.

### AusTender (RSS)

Australia publishes an RSS feed of all **current ATMs** — approaches to market, i.e. live
opportunities. This is preferred over `api.tenders.gov.au`, which requires an auth token and serves
post-award contract notices rather than opportunities.

The feed path has moved between AusTender releases, so the ingester **discovers** it: it reads the
Current ATM page, follows the declared `<link type="application/rss+xml">`, and falls back to known
paths. Set `AUSTENDER_RSS_URL` to skip discovery. If neither works the run fails with the page URL
to copy the link from — it never silently indexes nothing.

### Still to come

Norway (Doffin) and Spain (PLACSP) are the next candidates but were **not verified** — no official
API documentation found for Doffin. Mexico's CompraNet was downgraded after checking: the published
datasets are historical (through 2022) and no current live-opportunity feed was confirmed.

**Lesson worth keeping:** most procurement open data exists for transparency (awards, spend), not
for suppliers (open opportunities). Before writing any ingester, confirm the publisher offers an
OPPORTUNITY feed, not just contract history.

### Enabling the UK source

`netlify/lib/sources/ukfts.js` ships with `enabled = false` because its endpoint and date parameters
were never verified against the live service, and an unverified source on a public site produces
either silent zeroes or misleading results. To promote it: set `enabled = true`, deploy, search with
country = United Kingdom, and read the coverage line and diagnostics. Rows means promote it for good;
an HTTP error tells you exactly which parameter shape was rejected.

BOAMP matters because below-threshold contracts never reach TED — they are exactly the ones a small
supplier can realistically win, and exactly the ones that are hardest to find.

**Why BOAMP is searched by words, not codes:** its public dataset has no reliably populated CPV
column; it classifies with its own vocabulary and carries the subject in `objet`. So TED results are
code-precise and BOAMP results are broader. Every result is tagged with its source so the difference
is visible rather than hidden.

## Adding another source

One file, then one line. Create `netlify/lib/sources/<name>.js` exporting:

```js
export const id = "SHORTTAG";           // shown on each result
export const label = "Human readable";
export async function search(params) {  // must NEVER throw
  return { notices: [...], variant: "which query shape worked", diagnostics: [...] };
}
```

Each notice must be `{ id, title, buyer, country, deadline, daysLeft, published, cpv, link, source }`.
Then add the module to `SOURCES` in `netlify/functions/search.js`. Nothing else changes.

Guarantees the orchestrator gives you: sources run in parallel, each with a 6-second timeout; a
source that fails degrades to "results from the others" plus a visible note; duplicates across
sources are merged conservatively (same country, same deadline, 70%+ title-token overlap) and the
survivor is tagged `also BOAMP`; closed notices are dropped everywhere.

## How it works

- `index.html` — the whole front end. Matches your words against the dictionary and shows the codes.
- `data/cpv-map.json` — the plain-language -> CPV dictionary. **This is the part to extend.**
- `netlify/functions/search.js` — queries the TED API server-side (TED does not allow direct browser
  calls) and returns open notices only.

There is no database and nothing is stored about visitors. Each search is a live lookup.

## The full CPV vocabulary (optional, recommended)

The curated dictionary covers ~78 common concepts. The official EU vocabulary has ~9,500 codes.
To unlock the rest, generate the full list once from the official source:

1. Download the CPV codelist: https://simap.ted.europa.eu/web/simap/cpv
2. `node tools/build-cpv-list.mjs path/to/cpv_2008.csv`  (CSV, semicolon-CSV and XML all work)
3. Commit the generated `data/cpv-full.json`.

The app then offers "other official codes that mention your words" as tappable chips under the
translation strip; users opt in per code and the search re-runs. Without that file the site works
exactly as before on the curated dictionary alone — nothing breaks.

**Why this is generated rather than shipped:** a wrong CPV code does not throw an error, it quietly
searches for the wrong thing. Codes must come from the official file, never from memory.

## Telemetry — what it collects, and what it deliberately does not

The point is to learn which searches this tool fails, so the dictionary can be improved.

Collected per search: whether the dictionary matched, how many codes were used, how many results
came back, which query variant TED accepted, duration, and the country filter. Search *text* is
retained **only for misses** (no dictionary match, or zero results) — those are the actionable ones.

Never collected: IP addresses, user agents, cookies, or any identifier. Terms containing "@" or a
run of 6+ digits are discarded outright, and everything is truncated to 60 characters.

- Per-request metrics appear in the Netlify function logs (search for `SEARCH_METRIC`).
- Aggregates, if Netlify Blobs is available, are readable at `/.netlify/functions/stats?days=30`,
  which returns match rate, empty rate, and the top unmatched terms — your working list of
  dictionary entries to add.

Interpreting it: a high **match rate** with a high **empty rate** means the codes are right and
nobody is buying that thing right now. That is not a bug, and it is the distinction that stops you
"fixing" a dictionary that is already correct.

## Adding your trade to the dictionary

Open `data/cpv-map.json` and add an entry. No code changes needed:

```json
{ "label": "Beekeeping equipment", "cpv": ["03142100"], "terms": ["beehive", "beekeeping", "honey equipment"] }
```

`terms` are the everyday words people actually use; matching is substring-based, so "hives for bees"
will hit "beehive"-style terms if you list the right stems. Find CPV codes at
https://simap.ted.europa.eu/cpv

## Honest limitations

- **TED only.** It covers EU notices above the EU thresholds, plus whatever member states publish
  there voluntarily. Many smaller national contracts appear only on national portals — this tool does
  not see those yet.
- **The dictionary is a starter set,** not the full ~9,500-code CPV list. Unmatched words fall back to
  a full-text search, which is broader and noisier.
- **Always confirm on the official notice** before acting. Deadlines and requirements change.

## Licence

Released for public benefit. Data comes from TED, © European Union, reused under the Commission's
reuse policy. Do check the current TED reuse terms before deploying commercially.
