// Ingest: PNCP — Brazil's Portal Nacional de Contratações Públicas.
//
// Since Lei 14.133/2021 every public buyer in Brazil (federal, state and municipal) must publish its
// procurements on PNCP, so one source covers the whole country. Its public consultation API has an
// endpoint for exactly what this tool wants: procurements still accepting proposals.
//
//   GET /api/consulta/v1/contratacoes/proposta?dataFinal=YYYYMMDD&pagina=N&tamanhoPagina=50
//
// VERIFIED from a GitHub runner (2026-10-01): keyless, JSON, ~27,000 open procurements closing in
// the next 60 days, ordered oldest-published first. Page size is capped at 50 (500 returns HTTP 400),
// so a full sweep is ~550 requests. PNCP serves no robots.txt (404) and documents the API publicly.
//
// VERIFIED (2026-10-01, paced dry run): 69 pages in 4 minutes with one 429, about 17 pages a minute,
// so a 12-minute budget covers ~200 pages and the ring completes in about three days.
// PNCP rate-limits: an unpaced crawl got HTTP 429 after 8 requests. So requests are spaced
// (PNCP_DELAY_MS, default 1.5 s), a 429 waits for Retry-After (or 30 s) and retries up to 3 times.
//
// A full sweep is therefore longer than one run should take, so each run:
//   1. reads the LAST pages first, where newly published procurements land, and
//   2. spends the rest of its budget continuing a ring cursor through the older pages.
// Rows merge into the previous index; anything past its closing date is pruned. A procurement
// cancelled before its deadline can linger until the ring revisits it, at most a few days.
//
// Titles are Portuguese and PNCP carries no CPV codes. English searches reach these rows through the
// Portuguese terms in data/cpv-map.json (`pt`), which the search page sends alongside the query.

import { toRow } from "../lib/index-format.mjs";
import { fetchText } from "../lib/http.mjs";

export const source = "PNCP";
export const label = "PNCP (Brazil)";

const API = process.env.PNCP_API || "https://pncp.gov.br/api/consulta/v1/contratacoes/proposta";
const PAGE_SIZE = 50;

const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const isoDate = (v) => (/^(\d{4}-\d{2}-\d{2})/.exec(String(v || "")) || [])[1] || "";
const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

function toNoticeRow(c) {
  const cnpj = c.orgaoEntidade?.cnpj;
  const u = c.unidadeOrgao || {};
  const place = [u.municipioNome, u.ufSigla].filter(Boolean).join("/");
  const unit = clean(u.nomeUnidade || c.orgaoEntidade?.razaoSocial);
  const amount = Number(c.valorTotalEstimado);
  return toRow({
    id: c.numeroControlePNCP ? `BR-${c.numeroControlePNCP}` : "",
    title: clean(c.objetoCompra),
    buyer: place ? `${unit} (${place})` : unit,
    country: "BRA",
    deadline: isoDate(c.dataEncerramentoProposta),
    published: isoDate(c.dataPublicacaoPncp),
    codes: amount > 1 ? `${Math.round(amount)} BRL` : "",
    link: cnpj && c.anoCompra && c.sequencialCompra
      ? `https://pncp.gov.br/app/editais/${cnpj}/${c.anoCompra}/${c.sequencialCompra}`
      : "https://pncp.gov.br/app/editais",
  });
}

export async function ingest({ fetchImpl = fetchText, log = console.log, previousRows = [], previousState = {} } = {}) {
  const budgetMs = Number(process.env.PNCP_BUDGET_MS || 12 * 60 * 1000);
  const tailPages = Number(process.env.PNCP_TAIL_PAGES || 30);
  const horizonDays = Number(process.env.PNCP_HORIZON_DAYS || 180);
  const startedAt = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const dataFinal = ymd(new Date(Date.now() + horizonDays * 864e5));

  const byId = new Map();
  for (const row of previousRows) byId.set(row[0], row);

  let requests = 0, kept = 0, failed = 0;
  const notes = [];

  const delayMs = Number(process.env.PNCP_DELAY_MS ?? 1500);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let throttled = 0;

  async function page(n) {
    const url = `${API}?dataFinal=${dataFinal}&pagina=${n}&tamanhoPagina=${PAGE_SIZE}`;
    let res;
    for (let attempt = 0; ; attempt++) {
      if (requests > 0) await sleep(delayMs);
      requests++;
      res = await fetchImpl(url, { headers: { accept: "application/json" }, retries: 0, timeoutMs: 60000 });
      if (res.status !== 429 || attempt >= 3) break;
      throttled++;
      const wait = Math.min(res.retryAfter || 30, 120);
      log(`PNCP: rate limited on page ${n}; waiting ${wait} s`);
      await sleep(wait * 1000);
    }
    if (res.status === 204) return { data: [], totalPaginas: 0 };
    if (!res.ok) throw new Error(`HTTP ${res.status} on page ${n}`);
    const body = JSON.parse(res.text || "{}");
    for (const c of body.data || []) {
      const row = toNoticeRow(c);
      if (!row[0] || !row[1]) continue;
      if (row[4] && row[4] < today) { byId.delete(row[0]); continue; }
      byId.set(row[0], row);
      kept++;
    }
    return body;
  }

  // Page 1 tells us how many pages exist, so a failure here fails the source. A dropped connection
  // ("fetch failed") is retried twice after a pause; an HTTP error is a real answer and throws at once.
  let first;
  for (let attempt = 0; ; attempt++) {
    try { first = await page(1); break; }
    catch (err) {
      if (/^HTTP \d/.test(err.message) || attempt >= 2) throw err;
      log(`PNCP: page 1 failed (${err.message}); retrying in 30 s`);
      await sleep(30000);
    }
  }
  const totalPages = Number(first.totalPaginas) || 1;
  log(`PNCP: ${first.totalRegistros} open procurements across ${totalPages} pages (closing by ${dataFinal})`);

  const done = new Set([1]);
  const visit = async (n) => {
    if (done.has(n) || n < 1 || n > totalPages) return true;
    if (Date.now() - startedAt > budgetMs) return false;
    done.add(n);
    try { await page(n); }
    catch (err) {
      failed++;
      if (/HTTP 429/.test(err.message)) { notes.push("rate limited; stopping politely"); return false; }
    }
    return true;
  };

  // 1. Newest first: the tail is where today's procurements appear.
  let ok = true;
  for (let n = totalPages; ok && n > Math.max(1, totalPages - tailPages); n--) ok = await visit(n);

  // 2. Ring cursor through the rest, resuming where the last run stopped.
  let cursor = Number(previousState.cursor) || 2;
  let wrapped = false;
  while (ok && Date.now() - startedAt < budgetMs && done.size < totalPages) {
    if (cursor > totalPages) { cursor = 2; wrapped = true; }
    ok = await visit(cursor);
    if (ok) cursor++;
  }
  if (failed && failed >= requests / 2) {
    throw new Error(`PNCP: ${failed} of ${requests} page requests failed. Check PNCP_API.`);
  }

  let expired = 0;
  for (const [id, row] of byId) if (row[4] && row[4] < today) { byId.delete(id); expired++; }

  const rows = [...byId.values()];
  log(`PNCP: ${requests} request(s), ${failed} failed, ${kept} rows refreshed, ${expired} expired pruned; index now ${rows.length}`);
  notes.push(`requests ${requests}`, `failed ${failed}`, `throttled ${throttled}`, `pages ${totalPages}`, `cursor ${cursor}`, wrapped ? "ring wrapped" : "ring continuing");

  return {
    rows,
    notes,
    state: { cursor, totalPages, updatedAt: new Date().toISOString() },
  };
}
