// Temporary: checks Brazil's PNCP API and Spain's PLACSP feed respond from GitHub runners,
// and prints their shape. Deleted before merge.
import { politeFetch } from "../ingest/lib/http.mjs";
const show = async (name, url, n = 2500) => {
  try {
    const r = await politeFetch(url, { headers: { accept: "*/*" }, timeoutMs: 45000 });
    const t = await r.text();
    console.log(`\n==== ${name} HTTP ${r.status} ${t.length} bytes ${r.headers.get("content-type")}\n${url}`);
    console.log(t.slice(0, n));
    return t;
  } catch (e) { console.log(`\n==== ${name} ERROR ${e.name} ${e.message}`); return ""; }
};
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const in60 = new Date(Date.now() + 60 * 864e5);
await show("pncp robots", "https://pncp.gov.br/robots.txt", 800);
const p = await show("pncp proposta", `https://pncp.gov.br/api/consulta/v1/contratacoes/proposta?dataFinal=${ymd(in60)}&pagina=1&tamanhoPagina=50`, 4000);
try {
  const j = JSON.parse(p);
  console.log("KEYS", Object.keys(j), "total", j.totalRegistros, "pages", j.totalPaginas);
  const d = j.data?.[0]; if (d) console.log(JSON.stringify(d, null, 1).slice(0, 4000));
  const mods = {}; for (const x of j.data || []) mods[x.modalidadeNome] = (mods[x.modalidadeNome] || 0) + 1; console.log(mods);
  if (d) {
    await show("pncp itens", `https://pncp.gov.br/api/pncp/v1/orgaos/${d.orgaoEntidade.cnpj}/compras/${d.anoCompra}/${d.sequencialCompra}/itens?pagina=1&tamanhoPagina=5`, 3000);
  }
} catch (e) { console.log("parse fail", e.message); }
await show("pncp proposta big page", `https://pncp.gov.br/api/consulta/v1/contratacoes/proposta?dataFinal=${ymd(in60)}&pagina=1&tamanhoPagina=500`, 300);
await show("placsp robots", "https://contrataciondelsectorpublico.gob.es/robots.txt", 1500);
const a = await show("placsp atom 643", "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_643/licitacionesPerfilesContratanteCompleto3.atom", 200);
if (a) {
  console.log("entries", (a.match(/<entry>/g) || []).length, "links", (a.match(/<link[^>]*rel="next"[^>]*>/g) || []).slice(0, 2));
  const e = a.slice(a.indexOf("<entry>"), a.indexOf("</entry>") + 8); console.log(e.slice(0, 6000));
  const st = {}; for (const m of a.matchAll(/ContractFolderStatusCode[^>]*>([^<]+)</g)) st[m[1]] = (st[m[1]] || 0) + 1; console.log("status", st);
  console.log("updated range", (a.match(/<updated>[^<]+/g) || []).slice(0, 2), (a.match(/<updated>[^<]+/g) || []).slice(-1));
}
await show("placsp atom 1044 (aggregated regional)", "https://contrataciondelsectorpublico.gob.es/sindicacion/sindicacion_1044/PlataformasAgregadasSinMenores.atom", 300);
