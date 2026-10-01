// Ingest: PLACSP — Spain's Plataforma de Contratación del Sector Público.
//
// The platform publishes these ATOM feeds on its open-data page for reuse. The same host's
// robots.txt says "Disallow: /" for every agent (checked 2026-10-01); the owner decided that a
// documented open-data feed is fair to use under a blanket rule aimed at page crawlers (see the
// access-ethics section of HANDOFF.md). Keep it light: one run a day, honest agent, link back.
//
// The feed (sindicación 643: every buyer profile hosted on PLACSP, including below-threshold
// contracts) is a CHANGE LOG, newest first, ~127 entries and ~4 MB per page, with a rel="next" link
// to the previous page in time. Each entry is the latest state of one contract folder at that
// moment, in CODICE XML, and carries CPV codes, the submission deadline, buyer and budget.
//
// Each run:
//   1. reads from the head until it reaches the newest entry seen last run (incremental), then
//   2. continues a one-off backfill towards PLACSP_BACKFILL_DAYS ago, within a page budget, so a
//      cold start fills over a few days instead of downloading hundreds of MB at once.
// Within a run the first (newest) entry seen for a folder wins. Only status PUB (open for bids)
// is kept; any later status (EV, ADJ, RES, ANUL) removes the row. Deleted entries are honoured.

import { toRow } from "../lib/index-format.mjs";
import { politeFetch } from "../lib/http.mjs";

export const source = "PLACSP";
export const label = "PLACSP (Spain)";

const HEAD = process.env.PLACSP_FEED ||
  "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom";

const decode = (s) => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const first = (xml, re) => { const m = re.exec(xml); return m ? decode(m[1]) : ""; };
const entryId = (url) => (/(\d+)\s*$/.exec(url) || [])[1] || "";

export function parseEntry(xml) {
  const url = first(xml, /<id>([^<]+)<\/id>/);
  const id = entryId(url);
  const status = first(xml, /<cbc-place-ext:ContractFolderStatusCode[^>]*>([^<]+)</);
  const deadlineBlock = (/<cac:TenderSubmissionDeadlinePeriod>([\s\S]*?)<\/cac:TenderSubmissionDeadlinePeriod>/.exec(xml) || [])[1] || "";
  const party = (/<cac-place-ext:LocatedContractingParty>([\s\S]*?)<cac-place-ext:ParentLocatedParty>/.exec(xml) || [])[1] || xml;
  const cpv = [...new Set([...xml.matchAll(/<cbc:ItemClassificationCode[^>]*>(\d{8})</g)].map((m) => m[1]))].slice(0, 6);
  const amt = /<cbc:(?:TaxExclusiveAmount|EstimatedOverallContractAmount) currencyID="([A-Z]{3})">([\d.]+)</.exec(xml);
  return {
    id,
    status,
    updated: first(xml, /<updated>([^<]+)<\/updated>/),
    row: toRow({
      id: id ? `ES-${id}` : "",
      title: first(xml, /<title>([^<]*)<\/title>/),
      buyer: first(party, /<cac:PartyName>\s*<cbc:Name>([^<]+)<\/cbc:Name>/),
      country: "ESP",
      deadline: first(deadlineBlock, /<cbc:EndDate>(\d{4}-\d{2}-\d{2})/),
      published: first(xml, /<updated>(\d{4}-\d{2}-\d{2})/),
      codes: [...cpv.map((c) => `CPV ${c}`), amt && Number(amt[2]) > 1 ? `${Math.round(Number(amt[2]))} ${amt[1]}` : ""]
        .filter(Boolean).join(" · "),
      link: first(xml, /<link href="([^"]+)"\s*\/>/) || url,
    }),
  };
}

export async function ingest({ fetchImpl = politeFetch, log = console.log, previousRows = [], previousState = {} } = {}) {
  const maxPages = Number(process.env.PLACSP_MAX_PAGES || 40);
  const backfillDays = Number(process.env.PLACSP_BACKFILL_DAYS || 45);
  const today = new Date().toISOString().slice(0, 10);
  const backfillUntil = previousState.backfillUntil ||
    new Date(Date.now() - backfillDays * 864e5).toISOString();

  const byId = new Map();
  for (const row of previousRows) byId.set(row[0], row);
  // Folders whose newest state has already been applied. While a backfill is running it persists
  // across runs: otherwise an older "open" entry met during backfill would resurrect a folder that a
  // previous run already saw awarded or cancelled.
  const decided = new Set(previousState.backfillNext ? previousState.seen || [] : []);
  let pages = 0, entries = 0, kept = 0, removed = 0, newestSeen = "";
  const notes = [];

  // Walks rel="next" links from `url`, stopping at `stopAt` (an ISO timestamp) or the page budget.
  async function walk(url, stopAt) {
    while (url && pages < maxPages) {
      const res = await fetchImpl(url, { headers: { accept: "application/atom+xml" } });
      if (!res.ok) {
        if (pages === 0) throw new Error(`PLACSP returned HTTP ${res.status} on the first page`);
        notes.push(`HTTP ${res.status} after ${pages} page(s)`);
        return url;
      }
      const xml = await res.text();
      pages++;
      for (const m of xml.matchAll(/<at:deleted-entry[^>]*ref="([^"]+)"/g)) {
        const key = `ES-${entryId(m[1])}`;
        if (!decided.has(key)) { decided.add(key); if (byId.delete(key)) removed++; }
      }
      let reachedStop = false;
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = parseEntry(m[1]);
        if (!e.id) continue;
        entries++;
        if (!newestSeen || e.updated > newestSeen) newestSeen = e.updated;
        if (stopAt && e.updated && e.updated <= stopAt) { reachedStop = true; continue; }
        const key = e.row[0];
        if (decided.has(key)) continue;
        decided.add(key);
        const open = e.status === "PUB" && (!e.row[4] || e.row[4] >= today);
        if (open) { byId.set(key, e.row); kept++; }
        else if (byId.delete(key)) removed++;
      }
      if (reachedStop) return null;
      url = (/<link href="([^"]+)" rel="next"\s*\/>/.exec(xml) || [])[1] || null;
    }
    return url;
  }

  // 1. Incremental: head back to where the last run started.
  const incrementalStop = previousState.headUpdated || backfillUntil;
  const leftover = await walk(HEAD, incrementalStop);
  if (leftover) notes.push("page budget hit before reaching last run's head; the gap fills on later runs");

  // 2. Backfill (cold start only), resuming from a saved page.
  let backfillNext = previousState.backfillNext === undefined ? leftover : previousState.backfillNext;
  if (!previousState.headUpdated) backfillNext = leftover;
  if (backfillNext && pages < maxPages) backfillNext = await walk(backfillNext, backfillUntil);
  notes.push(backfillNext ? "backfill continuing" : "backfill complete");

  let expired = 0;
  for (const [id, row] of byId) if (row[4] && row[4] < today) { byId.delete(id); expired++; }

  const rows = [...byId.values()];
  log(`PLACSP: ${pages} page(s), ${entries} entries -> ${kept} open kept, ${removed} closed/removed, ${expired} expired; index now ${rows.length}`);
  notes.push(`pages ${pages}`, `entries ${entries}`, `kept ${kept}`, `removed ${removed}`);

  return {
    rows,
    notes,
    state: {
      headUpdated: newestSeen || previousState.headUpdated || "",
      backfillNext: backfillNext || null,
      backfillUntil,
      seen: backfillNext ? [...decided] : undefined,
      updatedAt: new Date().toISOString(),
    },
  };
}
