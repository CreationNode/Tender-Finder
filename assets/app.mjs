// Page script for index.html. Kept in its own file so the Content-Security-Policy can allow
// scripts from this site only, with no inline script.
import { rankCpv } from "./rank.mjs";

const $=id=>document.getElementById(id);
function esc(s){return String(s??"").replace(/[<>&"]/g,c=>({"<":"&lt;",">":"&gt;","&":"&amp;",'"':"&quot;"}[c]));}
// Links come from third-party portals: only http(s) is ever put in an href.
function safeLink(u){u=String(u??"").trim();return /^https?:\/\//i.test(u)?u:"#";}

// Grouped so it is obvious which markets have national sources, rather than listing every country
// and silently returning little for most of them.
const COUNTRY_GROUPS=[
  ["National sources",[["GBR","United Kingdom"],["USA","United States"],["FRA","France"],["UKR","Ukraine"],["AUS","Australia"],["BRA","Brazil"],["ESP","Spain"],["NLD","Netherlands"],["POL","Poland"],["DEU","Germany"],["NOR","Norway"]]],
  ["EU-wide (TED) only",[["AUT","Austria"],["BEL","Belgium"],["BGR","Bulgaria"],["HRV","Croatia"],["CYP","Cyprus"],["CZE","Czechia"],["DNK","Denmark"],["EST","Estonia"],["FIN","Finland"],["GRC","Greece"],["HUN","Hungary"],["IRL","Ireland"],["ITA","Italy"],["LVA","Latvia"],["LTU","Lithuania"],["LUX","Luxembourg"],["MLT","Malta"],["PRT","Portugal"],["ROU","Romania"],["SVK","Slovakia"],["SVN","Slovenia"],["SWE","Sweden"],["ISL","Iceland"],["CHE","Switzerland"],["LIE","Liechtenstein"]]],
];
const COUNTRY_NAME=Object.fromEntries(COUNTRY_GROUPS.flatMap(([,l])=>l));
const sel=$("country");
for(const [groupName,list] of COUNTRY_GROUPS){
  const g=document.createElement("optgroup");g.label=groupName;
  for(const [code,name] of list){const o=document.createElement("option");o.value=code;o.textContent=name;g.appendChild(o);}
  sel.appendChild(g);
}

// ---------- printout strips ----------
// Dot-matrix style columns of codes and hashes. Seeded, so a given search always prints the same
// strip; after a search it prints the codes that search actually used.
function rng(seed){let s=0;for(const c of String(seed))s=(s*31+c.charCodeAt(0))>>>0;return()=>((s=(s*1664525+1013904223)>>>0)/4294967296);}
function printStrip(el,seed,codes,lines){
  const r=rng(seed), hex="0123456789abcdef";
  const out=[];
  for(let i=0;i<lines;i++){
    const addr=(0x7a00+i*16).toString(16).padStart(6,"0");
    let row=addr+"  ";
    for(let j=0;j<4;j++){let w="";for(let k=0;k<4;k++)w+=hex[Math.floor(r()*16)];row+=w+" ";}
    if(codes.length&&i%5===2) row=addr+"  "+codes[(i/5|0)%codes.length].padEnd(20," ");
    out.push(row.trimEnd());
  }
  el.textContent=out.join("\n");
}
function paintStrips(seed,codes){printStrip($("stripA"),seed+"a",codes,44);printStrip($("stripB"),seed+"b",codes,52);}
paintStrips("open tender finder",[]);

// ---------- dictionary + full vocabulary ----------
let MAP=null, FULL=null, FULL_TRIED=false;
const EXTRA=new Set();               // official codes the user has opted into

async function loadMap(){
  if(MAP) return MAP;
  const res=await fetch("data/cpv-map.json");
  MAP=await res.json();
  return MAP;
}

// The complete CPV vocabulary is optional: it is generated from the official EU file by
// tools/build-cpv-list.mjs. Without it everything still works on the curated dictionary alone.
async function loadFull(){
  if(FULL||FULL_TRIED) return FULL;
  FULL_TRIED=true;
  try{
    const res=await fetch("data/cpv-full.json");
    if(!res.ok) return null;
    const data=await res.json();
    FULL=data.codes||null;
  }catch{ FULL=null; }
  return FULL;
}

// Ranking lives in assets/rank.mjs so the site and tools/rank-test.mjs share one implementation.
function searchFull(text,exclude){
  if(!FULL) return [];
  return rankCpv(text,FULL,exclude,8);
}

// Match the user's words against the dictionary, on WHOLE words (a plural "s"/"es" allowed).
// Substring matching read "healthcare" as "car", "broadband" as "road" and "team" as "tea", and the
// wrong code then replaced the user's words at TED. Where two entries match overlapping words, only
// the longer match is kept: "ballistic helmets" is body armour, not also safety helmets.
function termRegex(term){
  const t=term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])(${t}(?:s|es)?)(?=$|[^\\p{L}\\p{N}])`,"u");
}
function matchCodes(text,map){
  const q=text.toLowerCase().trim();
  if(!q) return [];
  const hits=[];
  for(const entry of map.entries){
    for(const term of [...entry.terms].sort((a,b)=>b.length-a.length)){
      const m=termRegex(term).exec(q);
      if(m){
        const start=m.index+m[1].length;
        hits.push({label:entry.label,cpv:entry.cpv,psc:entry.psc||[],pt:entry.pt||[],matched:term,start,end:start+m[2].length});
        break;
      }
    }
  }
  const kept=hits.filter(h=>!hits.some(o=>o!==h&&o.end-o.start>h.end-h.start&&o.start<=h.start&&o.end>=h.end));
  return kept.sort((a,b)=>b.matched.length-a.matched.length).slice(0,4);
}

function renderOfficial(suggestions){
  const box=$("official"), row=$("pickrow");
  row.innerHTML="";
  if(!suggestions.length){box.hidden=true;return;}
  box.hidden=false;
  for(const s of suggestions){
    const b=document.createElement("button");
    b.type="button";b.className="pick";b.setAttribute("aria-pressed",EXTRA.has(s.code)?"true":"false");
    b.innerHTML=`${esc(s.code)}<span>${esc(s.label)}</span>`;
    b.addEventListener("click",()=>{
      if(EXTRA.has(s.code)) EXTRA.delete(s.code); else EXTRA.add(s.code);
      b.setAttribute("aria-pressed",EXTRA.has(s.code)?"true":"false");
      run();
    });
    row.appendChild(b);
  }
}

function renderTranslation(text,hits){
  const line=$("tline");
  line.innerHTML="";
  const add=(cls,txt)=>{const s=document.createElement("span");s.className=cls;s.textContent=txt;line.appendChild(s);};
  add("said","“"+text+"”");
  add("arrow","→");
  const cpv=[...new Set(hits.flatMap(h=>h.cpv))].slice(0,6);
  const psc=[...new Set(hits.flatMap(h=>h.psc))].slice(0,4);
  if(cpv.length){
    cpv.forEach(c=>add("chip","CPV "+c));
    psc.forEach(c=>add("chip psc","PSC "+c));
    $("tnote").textContent=`Matched ${hits.map(h=>`“${h.matched}”`).join(", ")} in our dictionary (${hits.map(h=>h.label).join("; ")}). CPV is the EU's classification for public contracts; PSC is the US equivalent. Notices are found by these codes and by your own words; results that match your exact words rank first.`;
    $("herocode").textContent="("+cpv[0]+")";
    $("herocode").classList.remove("idle");
  }else{
    add("chip miss","no dictionary match");
    $("tnote").textContent="None of your words are in our dictionary yet, so we search the notice text for them instead. Results may be broader. If your trade is missing, tell us and we'll add it.";
    $("herocode").textContent="(00000000)";
    $("herocode").classList.add("idle");
  }
  paintStrips(text,[...cpv.map(c=>"CPV "+c),...psc.map(c=>"PSC "+c)]);
  $("translate").classList.add("on");
}

// ---------- results ----------
// Cached rows put the value at the end of the codes string ("CPV 45261215 · 88000 GBP").
function splitCodes(raw){
  const parts=String(raw||"").split(" · ").filter(Boolean);
  let value=null;
  const last=parts[parts.length-1]||"";
  const m=/^(\d+(?:\.\d+)?) ([A-Z]{3})$/.exec(last);
  if(m){value={amount:Number(m[1]),currency:m[2]};parts.pop();}
  return {codes:parts,value};
}
function money(v){
  if(!v||!(v.amount>1)) return "";   // "1 GBP" placeholders are not a real estimate
  try{return new Intl.NumberFormat("en-GB",{style:"currency",currency:v.currency,maximumFractionDigits:0,notation:v.amount>=1e7?"compact":"standard"}).format(v.amount);}
  catch{return `${Math.round(v.amount).toLocaleString("en-GB")} ${v.currency}`;}
}

let LAST={results:[],sources:[],term:""};
const FILTER={country:"",source:"",within:""};

// The block is visual; screen readers get one sentence instead, including the urgency that sighted
// readers only see as the inverted colours.
function dueBlock(r){
  if(r.daysLeft===null||r.daysLeft===undefined) return `<div class="due unknown"><b aria-hidden="true">n/a</b><span aria-hidden="true">no date</span><span class="sr">No closing date published.</span></div>`;
  const soon=r.daysLeft<=7;
  const said=r.daysLeft===0?"Closes today":`Closes in ${r.daysLeft} ${r.daysLeft===1?"day":"days"}`;
  const text=r.daysLeft===0?`<b aria-hidden="true">0</b><span aria-hidden="true">today</span>`:`<b aria-hidden="true">${r.daysLeft}</b><span aria-hidden="true">${r.daysLeft===1?"day":"days"}</span>`;
  return `<div class="due${soon?" soon":""}">${text}<span class="sr">${esc(said)}${soon?", closing soon":""}.</span></div>`;
}

// Portal names as the "Where we look" table writes them, instead of internal source ids.
const SOURCE_LABEL={TED:"TED",BOAMP:"BOAMP",SAM:"SAM.gov",PROZORRO:"Prozorro","UK-FTS":"Find a Tender","UK-CF":"Contracts Finder",
  AUSTENDER:"AusTender",PNCP:"PNCP",PLACSP:"PLACSP",TENDERNED:"TenderNed",BZP:"BZP",OEV:"oeffentlichevergabe.de",DOFFIN:"Doffin",CANADABUYS:"CanadaBuys"};
const sourceName=id=>SOURCE_LABEL[id]||id;

function renderList(){
  const list=$("results");list.innerHTML="";
  const rows=LAST.results.filter(r=>
    (!FILTER.country||r.country===FILTER.country)&&
    // A merged result counts for every portal that lists it, so picking BOAMP keeps a French tender
    // shown under TED "also BOAMP".
    (!FILTER.source||r.source===FILTER.source||(r.alsoOn||[]).includes(FILTER.source))&&
    (!FILTER.within||(r.daysLeft!==null&&r.daysLeft!==undefined&&r.daysLeft<=Number(FILTER.within))));
  const n=rows.length, total=LAST.results.length;
  $("status").textContent=`${n} open ${n===1?"tender":"tenders"}`;
  // Each source returns its best matches only; say so when a source had more than it sent.
  const cut=(LAST.sources||[]).some(s=>s.matched>s.found);
  $("substatus").textContent=(n===total?"closing soonest first":`filtered from ${total}`)+(cut?" · some sources had more matches than shown, see below":"");
  if(!total&&!LAST.anyAnswered){
    $("status").textContent="No answer from the sources";$("substatus").textContent="";
    list.innerHTML=`<li class="empty"><b>We couldn’t reach the tender sources just now.</b>
      None of the portals for this search answered, so this is not a sign that nothing is open.
      The line below says what each one returned. Try again in a few minutes.</li>`;
    return;
  }
  if(!total){
    const term=LAST.term;
    list.innerHTML=`<li class="empty"><b>Nothing open right now for “${esc(term)}”.</b>
      Public buying is seasonal. Try a broader description, all countries, or check again next week.
      If the codes above look wrong for what you do,
      <a href="#suggest" data-suggest="${esc(term)}">suggest a better match</a>.</li>`;
    return;
  }
  for(const r of rows){
    const {codes,value}=splitCodes(r.cpv);
    const li=document.createElement("li");li.className="notice";
    const facts=[
      r.buyer?null:"Buyer not stated",
      COUNTRY_NAME[r.country]||r.country,
      r.deadline?"closes "+r.deadline:null,
    ].filter(Boolean);
    const val=money(value);
    li.innerHTML=`
      ${dueBlock(r)}
      <div>
        <h3><a href="${esc(safeLink(r.link))}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
        ${r.buyer?`<div class="buyer">${esc(r.buyer)}</div>`:""}
        <div class="facts">${val?`<span class="value">${esc(val)}</span>`:""}${facts.map(f=>`<span>${esc(f)}</span>`).join("")}</div>
        ${codes.length?`<div class="codes">${esc(codes.slice(0,4).join(" · "))}</div>`:""}
      </div>
      <div class="side"><span class="src">${esc(sourceName(r.source||"?"))}</span>${(r.alsoOn||[]).map(x=>`<span class="also">also ${esc(sourceName(x))}</span>`).join("")}</div>`;
    list.appendChild(li);
  }
}

// Facets replace the old tile map: after a search, the countries and sources that actually
// returned something, with counts, as filters.
function renderFacets(){
  const box=$("facets");box.innerHTML="";
  const count=(key)=>{const m={};for(const r of LAST.results){const ks=key==="source"?[r.source,...(r.alsoOn||[])]:[r[key]];for(const k of ks)if(k)m[k]=(m[k]||0)+1;}return Object.entries(m).sort((a,b)=>b[1]-a[1]);};
  const group=(title,key,entries,labelOf)=>{
    if(!entries.length) return;
    const f=document.createElement("div");f.className="facet";
    f.innerHTML=`<h2>${title}</h2><div class="opts"></div>`;
    const opts=f.querySelector(".opts");
    for(const [val,n] of entries){
      const b=document.createElement("button");b.type="button";b.className="opt";
      b.setAttribute("aria-pressed",FILTER[key]===val?"true":"false");
      b.innerHTML=`<span>${esc(labelOf(val))}</span><span class="n">${n}</span>`;
      b.addEventListener("click",()=>{FILTER[key]=FILTER[key]===val?"":val;renderFacets();renderList();});
      opts.appendChild(b);
    }
    box.appendChild(f);
  };
  group("Country","country",count("country"),v=>COUNTRY_NAME[v]||v);
  group("Source","source",count("source"),sourceName);
  const within=[["7","Within 7 days"],["30","Within 30 days"]]
    .map(([d,label])=>[d,LAST.results.filter(r=>r.daysLeft!==null&&r.daysLeft!==undefined&&r.daysLeft<=Number(d)).length,label])
    .filter(([,n])=>n>0);
  if(within.length) group("Closing","within",within.map(([d,n])=>[d,n]),v=>within.find(w=>w[0]===v)[2]);
}

// Say plainly which portals answered and which did not. A public tool should never imply it
// searched everywhere when one source was down.
function renderCoverage(sources){
  const el=$("coverage");
  const asked=sources.filter(s=>!s.skipped);
  if(!asked.length){el.textContent="";return;}
  const parts=asked.map(s=>{
    const name=esc(sourceName(s.source));
    // The server reports each source's status; failures are never shown as "0".
    if(s.status==="error") return `<span class="down">${name}</span> unavailable`;
    if(s.status==="timeout") return `<span class="down">${name}</span> did not answer in time`;
    if(s.status==="missing") return `<span class="down">${name}</span> not available yet`;
    const count=s.matched>s.found?`${s.found} of ${s.matched}`:`${s.found}`;
    if(typeof s.ageHours==="number"){
      const stale=s.status==="stale";
      const age=s.ageHours<24?`${s.ageHours}h`:`${Math.round(s.ageHours/24)}d`;
      return `${s.found?"<b>":""}${name}${s.found?"</b>":""} ${count} <span${stale?' class="down"':""}>(data ${age} old${stale?", stale":""})</span>`;
    }
    return `${s.found?"<b>":""}${name}${s.found?"</b>":""} ${count} (live)`;
  });
  el.innerHTML="Searched: "+parts.join(" · ");
}

async function run(){
  const text=$("what").value.trim();
  if(!text){$("what").focus();return;}
  const btn=$("go");btn.disabled=true;btn.textContent="Searching";
  FILTER.country=FILTER.source=FILTER.within="";
  try{
    const map=await loadMap();
    const hits=matchCodes(text,map);
    renderTranslation(text,hits);

    const curated=new Set(hits.flatMap(h=>h.cpv));
    await loadFull();
    renderOfficial(searchFull(text,curated));

    const payload={
      cpvCodes:[...new Set([...curated,...EXTRA])],
      keywords:text.split(/\s+/).slice(0,6),   // national portals search words, not codes
      curatedLabels:hits.map(h=>h.label),
      matchedTerms:hits.map(h=>h.matched),   // cached sources match these as whole phrases
      pscCodes:[...new Set(hits.flatMap(h=>h.psc))],   // SAM.gov rows carry PSC, not CPV
      ptTerms:[...new Set(hits.flatMap(h=>h.pt))].slice(0,40),   // Brazil's titles are Portuguese
      country:$("country").value,
      daysBack:90,limit:40,
      term:text                      // for telemetry only; filtered and truncated server-side
    };
    const res=await fetch("/.netlify/functions/search",{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)
    });
    let data;
    try{ data=await res.json(); }
    catch{
      // A gateway error or timeout returns an HTML page, not JSON.
      const err=new Error("The search service didn’t respond.");
      err.detail=" Try again in a moment.";
      throw err;
    }
    if(!res.ok){
      const err=new Error(data.error||"Search failed.");
      err.detail=data.detail||"";
      err.diagnostics=data.diagnostics||[];
      throw err;
    }
    LAST={results:data.results||[],sources:data.sources||[],term:text,anyAnswered:data.anyAnswered!==false};
    $("resultsArea").classList.remove("empty-state");
    renderFacets();renderList();renderCoverage(LAST.sources);
  }catch(err){
    LAST={results:[],sources:[],term:text,anyAnswered:true};
    $("resultsArea").classList.remove("empty-state");
    $("facets").innerHTML="";$("coverage").textContent="";
    $("status").textContent="Search failed";$("substatus").textContent="";
    const diag=(err.diagnostics&&err.diagnostics.length)
      ? `<details class="diag"><summary>Show what the tenders service returned</summary><pre>${esc(err.diagnostics.join("\n"))}</pre></details>`
      : "";
    $("results").innerHTML=`<li class="empty"><b>${esc(err.message)}</b>${esc(err.detail||"Try again in a moment.")}${diag}</li>`;
  }finally{btn.disabled=false;btn.textContent="Search";}
}

let lastText="";
$("what").addEventListener("input",()=>{ if($("what").value.trim()!==lastText) EXTRA.clear(); });
$("searchform").addEventListener("submit",e=>{e.preventDefault();lastText=$("what").value.trim();run();});
$("country").addEventListener("change",()=>{ if($("what").value.trim()) run(); });
// Fill "Open now" from the ingest manifest, and mark a daily source as stale or failing when the
// data says so. If this call fails the table keeps its static text.
(async()=>{
  try{
    const r=await fetch("/.netlify/functions/coverage");const c=await r.json();if(!c.sources)return;
    for(const row of document.querySelectorAll("#sources tr[data-source]")){
      const s=c.sources[row.dataset.source];const cell=row.lastElementChild,state=row.querySelector(".state");
      if(!s||s.count==null){cell.textContent="—";if(state){state.textContent="Not loaded yet";}continue;}
      cell.textContent=s.count.toLocaleString("en-GB");
      const age=s.updated?(Date.now()-Date.parse(s.updated))/36e5:Infinity;
      if(state&&s.failing)state.textContent="Daily · last update failed";
      else if(state&&age>48)state.textContent=`Daily · ${Math.round(age/24)} days old`;
    }
  }catch{}
})();

document.querySelectorAll(".examples button").forEach(b=>{
  b.addEventListener("click",()=>{$("what").value=b.dataset.ex;lastText=b.dataset.ex;run();});
});

// Suggestion box (Netlify Forms). Sent with fetch so the page stays put; without script the form
// still posts normally and Netlify redirects back here with ?sent=1.
const sform=$("suggestform");
if(sform){
  const sent=$("sg-sent");
  if(new URLSearchParams(location.search).has("sent")) sent.textContent="Thanks. Your suggestion was sent.";
  document.addEventListener("click",e=>{
    const a=e.target.closest("a[data-suggest]");
    if(!a) return;
    $("sg-what").value=a.dataset.suggest;
  });
  sform.addEventListener("submit",async e=>{
    e.preventDefault();
    const btn=sform.querySelector("button");btn.disabled=true;sent.textContent="Sending…";
    try{
      const res=await fetch("/",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
        body:new URLSearchParams(new FormData(sform)).toString()});
      if(!res.ok) throw new Error(res.status);
      sform.reset();sent.textContent="Thanks. Your suggestion was sent.";
    }catch{
      sent.textContent="That didn't go through. Please try again, or email info@whattheybuy.org.";
    }finally{ btn.disabled=false; }
  });
}

// "Added on request": trades added to the dictionary because someone asked. Hidden while empty.
(async()=>{
  try{
    const r=await fetch("data/added-on-request.json");if(!r.ok)return;
    const items=(await r.json()).items||[];if(!items.length)return;
    $("ledger").innerHTML=items.slice(0,12).map(x=>
      `<li><span class="d">${esc(x.date||"")}</span><span>${esc(x.trade||"")}<span class="c">${esc((x.codes||[]).join(" · "))}</span></span></li>`).join("");
    $("requested").hidden=false;
  }catch{}
})();
