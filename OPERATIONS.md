# Operations & Growth Plan

*Open Tender Finder — from working build to live public service.*

Four parts: **Updating** (keeping data fresh), **Improving** (making it better), **Publishing**
(going public responsibly), **SEO** (being findable). Do them roughly in that order — a stale or
noisy tool should not be promoted.

Current state: seven sources (TED, BOAMP, UK Find a Tender, UK Contracts Finder, Prozorro,
SAM.gov, AusTender), ~30,000 open notices, full 9,454-code CPV vocabulary, indexes built manually.

---

# PART 1 — UPDATING

The single unfinished thing: **nothing refreshes the indexes automatically.** A stale index looks
identical to a working one, which is the failure mode this project has spent its whole life
engineering against. GitHub Actions closes it.

## 1.1 One-time setup (about 30 minutes)

**Create the repository**

```powershell
cd "$HOME\Downloads\tf-new\tender-finder"
git init
git add .
git commit -m "Open Tender Finder"
git branch -M main
git remote add origin https://github.com/YOUR-NAME/tender-finder.git
git push -u origin main
```

`.gitignore` already excludes `.env`, so your SAM key stays local. Verify before pushing:

```powershell
git status --porcelain | Select-String "\.env"    # must return nothing
```

**Add the secrets** — repo → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value | Required |
|---|---|---|
| `SAM_API_KEY` | your SAM.gov public API key | yes, for US data |
| `SAM_BULK_CSV_URL` | only if the default path stops working | no |
| `AUSTENDER_RSS_URL` | only if catalogue discovery fails | no |
| `CANADABUYS_CSV_URL` | only if the default paths change | no |

**Enable write permissions** — Settings → Actions → General → Workflow permissions →
**Read and write permissions** → Save. Without this the workflow runs green but silently cannot
publish anything. This is the most common single point of failure in the whole setup.

**Run it once by hand** — Actions tab → "Ingest tender sources" → Run workflow. Then read the
**Report** and **"Fail only if every source failed"** steps: they print which sources succeeded with
row counts, and why any failed.

## 1.2 Where indexes live (decide once)

The workflow publishes indexes to a **force-pushed orphan branch** called `indexes`, not to `main`.

Why: the SAM index alone is ~7 MB. Committing a fresh copy daily to `main` adds roughly **2 GB of
permanent git history per year** — clone times climb until the repo is painful, and none of that
history has value because only today's data matters. Force-pushing an orphan branch keeps exactly
one copy and no history.

To use it, set an environment variable in Netlify (Site configuration → Environment variables):

```
INDEX_BASE_URL = https://raw.githubusercontent.com/YOUR-NAME/tender-finder/indexes/data/index
```

Benefits beyond size: **data refreshes no longer require a site redeploy.** Ingestion updates the
branch; the search function picks it up within its 10-minute cache window.

If you would rather keep everything in one place, set the repository variable
`COMMIT_INDEXES_TO_MAIN = true` and leave `INDEX_BASE_URL` unset — acceptable at low volume, but
revisit it before adding more large sources.

## 1.3 The recurring calendar

| When | What | Why |
|---|---|---|
| Daily, automatic | 05:17 UTC ingestion | keeps every index fresh |
| Weekly, 5 min | check the latest Actions run is green; skim `/.netlify/functions/stats?days=7` | catches a source that died quietly |
| **~8 November** | **rotate `SAM_API_KEY`** (expires ~14 Nov) | key rotation is the most predictable outage you will have |
| Monthly, 15 min | read the telemetry top-misses list; add dictionary entries | the only demand signal you get |
| Quarterly | re-run `node ingest/verify.mjs` locally | confirms sources still behave outside CI |

Set the SAM reminder now, in a calendar, today. Everything else degrades gracefully; that one stops
US data cold, and the site will keep serving an ageing index without complaint.

## 1.4 When something breaks

1. **Actions run red?** Open it — the summary names each source and its error.
2. **A source shows "index not built yet"?** Ingestion never published. Check workflow permissions.
3. **Results look old?** The coverage line shows index age and flags anything over 48 hours as STALE.
4. **Need to reproduce locally?** `node ingest/verify.mjs` (writes nothing) then `node ingest/run.mjs`.
5. **A source changed format?** The yield canary refuses to overwrite a healthy index with a
   collapsed one, so the old data stays live while you fix it. Override with `FORCE=1` once checked.

---

# PART 2 — IMPROVING & EXTENDING

Ordered by value per unit of effort. **Resist adding countries until the first two are done** — more
sources make a noisy tool noisier, and the bottleneck is no longer coverage.

## 2.1 Retrieval quality (do this first)

Everything so far proves the tool *runs*. Nothing yet proves it *works*.

Take ten searches you would expect to succeed — across several countries and sectors — and judge the
results honestly. Write down what you searched and what came back. Specifically suspect the US: with
28,000 notices matched on title keywords alone, precision is likely the weak point, and 500 notices
behaves very differently from 28,000.

Then fix what that exposes, which is probably one of:
- **Ranking** — tune `assets/rank.mjs` (shared by the site and `tools/rank-test.mjs`, so it is
  measurable offline against the real vocabulary).
- **Dictionary gaps** — add entries to `data/cpv-map.json`.
- **Cross-source dedupe** — currently conservative; loosen only with evidence.

## 2.2 Telemetry-driven dictionary work

Once real visitors arrive, `/.netlify/functions/stats?days=30` returns match rate, empty rate and
the top unmatched search terms. That list is your queue. Add entries, redeploy, watch the match rate.

Read it carefully: **high match rate + high empty rate is not a bug.** It means the codes are right
and nobody is buying that thing right now. Only a low *match* rate means the dictionary is lacking.

## 2.3 Scale work, before it hurts

- **Inverted index.** The search function parses a whole index and scans every row — fine at 30k,
  wrong at 500k. Build token → row-id maps at ingest time, shard by prefix, fetch only what a query
  needs. Do this before coverage doubles.
- **Index pruning.** Consider a deadline horizon (drop notices closing more than a year out) if
  indexes keep growing.

## 2.4 The language layer

This now matters more than any additional country. Prozorro's titles are Ukrainian; Greek, Japanese
and Arabic sources would be worse. Coverage already exceeds comprehension.

- **Classification crosswalk** — map CPV ↔ UNSPSC ↔ PSC/NAICS ↔ GSIN so one concept resolves across
  every source regardless of language. Codes are language-neutral; words are not.
- **Translated dictionary terms** for the largest markets.

## 2.5 More sources

Verify endpoints **before** writing an ingester, and confirm the publisher offers an *opportunity*
feed rather than contract history — most procurement open data is published for transparency, not
for suppliers. That single question would have saved the Mexico investigation.

Next candidates, in order: **Spain (PLACSP)** and **Norway (Doffin)** — both likely drop into the
existing `ingest/lib/ocds.mjs` helper; then **Netherlands (TenderNed)** and **Ireland (eTenders)**.
**CanadaBuys** may simply start working from Actions' datacentre IP — check the first run.

Adding a source is four steps, documented in the README: write the ingester, register it in
`ingest/run.mjs`, add a cached source module, register it in `netlify/functions/search.js`. Then add
one line to `TILES` in `index.html` so it appears on the map.

## 2.6 Alerts — last, deliberately

"Email me when something matches" is the most-requested feature and the one that changes the
project's nature: stored email addresses, GDPR obligations, unsubscribe handling, deliverability,
indefinitely. Only worth it once coverage is good enough that alerts would actually fire.

---

# PART 3 — PUBLISHING

## 3.1 Pre-launch checklist

**Housekeeping**
- [ ] Delete `netlify/functions/probe.js` (temporary diagnostic).
- [ ] Ensure `.env` is not in the deployed folder; set `SAM_API_KEY` as a Netlify environment
      variable instead.
- [ ] Replace `REPLACE-WITH-YOUR-DOMAIN` in `robots.txt`, `sitemap.xml` and `index.html`.
- [ ] Set the GitHub repo URL in the "suggest a better match" link in `index.html`
      (currently `YOUR-USERNAME`).

**Credibility — the part that decides whether people trust it**
- [ ] Write `SOURCES.md`: for each portal, the access method, the licence, and what its terms
      permit. Seven sources with genuinely different terms; for a public-good project this
      transparency is a feature, not paperwork.
- [ ] Add a short privacy note: no accounts, no cookies, no tracking; searches are counted and only
      *failed* searches retain text, truncated, with emails and long digit strings discarded.
- [ ] Attribute each source visibly (already shown per result and in the footer).

**Quality**
- [ ] Mobile check: the tile map and results on a phone.
- [ ] Keyboard and screen-reader pass on the map, search and results.
- [ ] Empty and error states read clearly to a stranger, not just to you.
- [ ] Confirm the coverage line honestly reports out-of-scope and unavailable sources.

## 3.2 Domain and hosting

A real domain matters more than it should: `tenderfinder.eu` reads as a service,
`starlit-cupcake-1234.netlify.app` reads as an experiment. Netlify handles DNS and TLS.

## 3.3 How to launch (realistic)

This will not spread on its own. It reaches people through the places small suppliers already are:

1. **Open-data and civic-tech communities** — the Open Contracting Partnership community, national
   open-data forums. This is genuinely their kind of project and they will give useful criticism.
2. **Trade and SME bodies** — chambers of commerce, sector associations. They have the audience that
   benefits most and mailing lists that reach it.
3. **Show HN / relevant subreddits** — expect blunt feedback; the honest limitations documented in
   the README will help rather than hurt.
4. **Procurement professionals on LinkedIn** — the people who already know CPV codes exist.

Lead with the specific problem, not the technology: *public contracts are open to everyone, but
they are filed under numeric codes nobody outside the profession knows, so most small suppliers
never see them.* That sentence is the product.

## 3.4 Handling what comes back

Expect three kinds of feedback: missing trades (dictionary work — welcome it), missing countries
(roadmap), and "it found nothing for me" (check whether it is a match failure or genuinely no open
tenders — the distinction is in the telemetry and it matters).

---

# PART 4 — BASIC SEO

Already implemented in this build: canonical URL, meta description, Open Graph and Twitter cards,
JSON-LD `WebApplication` structured data, `robots.txt`, `sitemap.xml`. Replace the domain
placeholders and they are live.

## 4.1 Immediately after launch

- **Google Search Console** and **Bing Webmaster Tools**: verify the domain, submit the sitemap.
- **Check the social preview** by pasting the URL into any chat app. A link that unfurls with a title
  and description gets clicked far more than a bare URL — this is the highest-return five minutes in
  the whole SEO section.
- **PageSpeed Insights**: the site is a single static page and should score very well; fix anything
  that does not.

## 4.2 The honest limitation

The tool is one page whose value appears *after* a search. Search engines cannot see those results,
so there is little for them to index. Ranking for "public tenders" against established commercial
aggregators with large content operations is not realistic.

## 4.3 What would actually work

Write a small number of genuinely useful static pages — the kind of thing that does not exist for
free anywhere:

- **"How to find public contracts if you have never bid before"** — the CPV code problem explained
  in plain language, which is exactly what the tool solves.
- **"Which countries publish below-threshold contracts, and where"** — you have researched this in
  unusual depth; almost nobody has written it down.
- **Per-country pages** — "Finding public contracts in France", covering BOAMP and the
  below-threshold distinction, one per source, each linking into the tool.

These earn links because they are useful, and they give search engines something substantive to
index. Three good pages beat thirty thin ones.

Secondary, and cheap: submit to open-data catalogues and civic-tech directories, which produce both
referrals and credible inbound links.

## 4.4 What not to do

No keyword stuffing, no doorway pages per country with identical content, no paid links. For a
public-interest tool, credibility *is* the distribution strategy — one recommendation from a trade
body outperforms months of thin SEO.

---

# THE SHORT VERSION

**This week:** push to GitHub, add secrets, enable write permissions, run the workflow, set
`INDEX_BASE_URL`, and put the SAM key rotation in your calendar for 8 November.

**Next:** run the retrieval quality check on ten real searches. Fix what it exposes. That decides
whether the next effort goes into ranking or into more countries — and doing it in that order is the
difference between a tool that impresses and one that is used.
