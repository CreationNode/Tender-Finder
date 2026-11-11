// Plain words -> dictionary entries, and the search request built from them.
//
// Shared by the page (assets/app.mjs) and the RSS feed function (netlify/functions/feed.js), so a
// feed returns exactly what the same search on the page returns.

function termRegex(term){
  const t=term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${t}(?:s|es)?)(?=$|[^\\p{L}\\p{N}])`,"u");
}
export function matchCodes(text,map){
  const q=text.toLowerCase().trim();
  if(!q) return [];
  const hits=[];
  for(const entry of map.entries){
    for(const term of [...entry.terms].sort((a,b)=>b.length-a.length)){
      const m=termRegex(term).exec(q);
      if(m){
        const start=m.index+m[1].length;
        hits.push({label:entry.label,cpv:entry.cpv,psc:entry.psc||[],pt:entry.pt||[],fr:entry.fr||[],matched:term,start,end:start+m[2].length});
        break;
      }
    }
  }
  const kept=hits.filter(h=>!hits.some(o=>o!==h&&o.end-o.start>h.end-h.start&&o.start<=h.start&&o.end>=h.end));
  return kept.sort((a,b)=>b.matched.length-a.matched.length).slice(0,4);
}

/**
 * The request body the search function takes, from the user's words and the dictionary hits.
 * `extra` holds official codes the user opted into on the page.
 */
export function searchPayload(text, hits, { country = "", extra = [] } = {}) {
  const curated = new Set(hits.flatMap((h) => h.cpv));
  return {
    cpvCodes: [...new Set([...curated, ...extra])],
    keywords: text.split(/\s+/).slice(0, 6),               // national portals search words, not codes
    curatedLabels: hits.map((h) => h.label),
    matchedTerms: hits.map((h) => h.matched),              // cached sources match these as whole phrases
    pscCodes: [...new Set(hits.flatMap((h) => h.psc))],    // SAM.gov rows carry PSC, not CPV
    ptTerms: [...new Set(hits.flatMap((h) => h.pt))].slice(0, 40),   // Brazil's titles are Portuguese
    frTerms: [...new Set(hits.flatMap((h) => h.fr || []))].slice(0, 20),   // BOAMP is searched by French title words
    country,
    daysBack: 90, limit: 40,
  };
}
