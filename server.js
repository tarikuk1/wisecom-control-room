const http=require("http"),https=require("https"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000;
// SÉCURITÉ : définir ces variables dans les env vars Railway pour ne pas exposer les secrets en clair.
// Les valeurs ci-dessous sont des fallbacks de développement — ne pas conserver en production.
const INO_LOGIN=process.env.INO_LOGIN||"tarik_dashboard";
const INO_PWD=process.env.INO_PWD||"XnF!AuuWJg$cR$S";
const INO_APIKEY=process.env.INO_APIKEY||"dasboard_INO";
let SECURITY_CODE=process.env.SECURITY_CODE||"286828";
const USERS_RAW=process.env.USERS||"tarik:Wisecom2026!,admin:ControlRoom2026!";
const USERS=Object.fromEntries(USERS_RAW.split(",").map(u=>{const[l,...r]=u.trim().split(":");return[l.toLowerCase(),r.join(":")];}));

// ── Module « Evo sortant » : plateforme téléphonique Evolution (Ekiom) ─────────
// API REST Manager (auth Basic, JSON). Source distincte d'INO, dédiée aux appels
// sortants. Définir EVO_LOGIN/EVO_PWD dans les env vars Railway en production.
const EVO_HOST=process.env.EVO_HOST||"evo1.ekiom.net";
const EVO_LOGIN=process.env.EVO_LOGIN||"NCADMIN";
const EVO_PWD=process.env.EVO_PWD||"NCADMIN";
// http ou https : les domaines publics répondent en https ; on tente https puis http en repli.
const EVO_PROTO=(process.env.EVO_PROTO||"https").toLowerCase();
// Secret partagé pour le script local qui POST les données Evolution vers /api/evo/ingest
// (le serveur Evolution est sur le réseau interne, injoignable depuis Railway — voir §ingest
// plus bas : on inverse le sens, c'est un poste du bureau qui pousse les données).
const EVO_PUSH_SECRET=process.env.EVO_PUSH_SECRET||"CHANGE_ME_evo_push";

// Favicon — petit phare stylisé (clin d'œil "tour de contrôle"), sert toutes les pages
const FAVICON_SVG=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#0c0c0c"/>
<path d="M30 21 L5 12 L30 25 Z" fill="#E8006E" opacity=".45"/>
<path d="M34 21 L59 12 L34 25 Z" fill="#E8006E" opacity=".45"/>
<path d="M24 16 L40 16 L32 7 Z" fill="#f5479e"/>
<rect x="25" y="16" width="14" height="9" rx="2" fill="#E8006E"/>
<path d="M26 57 L29.5 25 L34.5 25 L38 57 Z" fill="#fff"/>
<rect x="24" y="57" width="16" height="4" rx="1.5" fill="#cfcfcf"/>
</svg>`;

const sessions={},pending={},loginAttempts={};
const TTL=10*60*1000,PTTL=5*60*1000,RATE_W=15*60*1000,RATE_MAX=5; // TTL=10min d\u0027inactivité (glissant)

const tok=()=>crypto.randomBytes(32).toString("hex");
// ── Sessions AUTOPORTANTES (cookie signé) — survivent aux redéploiements Railway ──
// Le token de session = "<payload>.<hmac>", signé avec SESSION_SECRET (env var stable, sinon dérivé
// de secrets déjà stables). Après un redéploiement, la map mémoire `sessions` est vide MAIS le cookie
// (cookie de session navigateur, age=null) est toujours là : getSession revalide la signature et
// RÉHYDRATE la session → plus de déconnexion à chaque déploiement. Validité absolue 8h.
const SESSION_SECRET=process.env.SESSION_SECRET||crypto.createHash("sha256").update("wcr-sess-v1|"+INO_PWD+"|"+SECURITY_CODE).digest("hex");
const SESSION_MAX_MS=8*60*60*1000;
const _b64u=b=>Buffer.from(b).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const _sigOf=p=>crypto.createHmac("sha256",SESSION_SECRET).update(p).digest("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
function signSession(login){const payload=_b64u(JSON.stringify({l:login,e:Date.now()+SESSION_MAX_MS}));return payload+"."+_sigOf(payload);}
function verifySession(t){
  if(!t||typeof t!=="string"||t.indexOf(".")<1)return null;
  const i=t.lastIndexOf("."),payload=t.slice(0,i),sig=t.slice(i+1),exp=_sigOf(payload);
  if(sig.length!==exp.length)return null;
  try{ if(!crypto.timingSafeEqual(Buffer.from(sig),Buffer.from(exp)))return null; }catch(e){return null;}
  let p; try{p=JSON.parse(Buffer.from(payload.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString());}catch(e){return null;}
  if(!p||!p.l||!p.e||Date.now()>p.e)return null;
  return {login:p.l,absExp:p.e};
}
function createSession(login){const t=signSession(login);const v=verifySession(t);sessions[t]={login,expires:Date.now()+TTL,createdAt:new Date().toISOString(),absExp:v&&v.absExp};return t;}
function createPending(login){const t=tok();pending[t]={login,expires:Date.now()+PTTL};return t;}
function getSession(t){
  if(t&&sessions[t]){const s=sessions[t];if(Date.now()>s.expires||(s.absExp&&Date.now()>s.absExp)){delete sessions[t];return null;}s.expires=Date.now()+TTL;return s;}
  // Absente de la mémoire (ex. après un redéploiement) : revalider le cookie signé et réhydrater.
  const v=verifySession(t); if(!v)return null;
  sessions[t]={login:v.login,expires:Date.now()+TTL,createdAt:new Date().toISOString(),absExp:v.absExp};
  return sessions[t];
}
function getPending(t){if(!t||!pending[t])return null;const s=pending[t];if(Date.now()>s.expires){delete pending[t];return null;}return s;}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||"").split(";").map(c=>{const[k,...v]=c.trim().split("=");return[k,v.join("=")];}));}
function setCookie(res,n,v,age=TTL/1000){
  // age=null → cookie de session navigateur (pas de Max-Age) : l'expiration réelle est gérée
  // côté serveur par le TTL glissant (10 min d'inactivité). age=0 → suppression.
  const base=n+"="+v+"; HttpOnly; SameSite=Strict; Path=/";
  res.setHeader("Set-Cookie", age===0 ? base+"; Max-Age=0" : (age==null ? base : base+"; Max-Age="+age));
}
function isRL(ip){const now=Date.now();if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip]=loginAttempts[ip].filter(t=>now-t<RATE_W);return loginAttempts[ip].length>=RATE_MAX;}
function recAttempt(ip){if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip].push(Date.now());}
function secH(res){res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");}
// Heure locale Europe/Paris (CET/CEST gérés automatiquement par l'environnement ICU de Node,
// quel que soit le fuseau du serveur — Railway tourne en UTC). Les offsets FR sont toujours
// en heures pleines : les minutes UTC restent valables telles quelles.
const _parisHourFmt=new Intl.DateTimeFormat("fr-FR",{timeZone:"Europe/Paris",hour:"2-digit",hour12:false});
function parisHour(d){return parseInt(_parisHourFmt.format(d),10)%24;}
const _parisDayFmt=new Intl.DateTimeFormat("en-US",{timeZone:"Europe/Paris",weekday:"short"});
const _JOUR_KEYS={Sun:"dim",Mon:"lun",Tue:"mar",Wed:"mer",Thu:"jeu",Fri:"ven",Sat:"sam"};
function parisJour(d){return _JOUR_KEYS[_parisDayFmt.format(d)]||"lun";}
// Minute du jour en heure France (les offsets FR sont en heures pleines → minutes UTC inchangées)
function parisMinOfDay(d){return parisHour(d)*60+d.getUTCMinutes();}
// Date du jour en heure France (YYYY-MM-DD) — new Date().toISOString() donne la date UTC :
// entre 00h et 02h Paris elle pointe encore sur la veille (serveur Railway en UTC)
const _parisDateFmt=new Intl.DateTimeFormat("en-CA",{timeZone:"Europe/Paris",year:"numeric",month:"2-digit",day:"2-digit"});
function parisDateStr(d){return _parisDateFmt.format(d||new Date());}

// ── Configuration campagnes — source unique : queues_config.js ──────────
const { CAMPS, QUEUES_MAP, SKILLS } = require("./queues_config.js");
// Cache live enrichi depuis INO routing (enrichit QUEUES_MAP toutes les 30 min)
let _liveQCache=null,_liveQAt=0;
async function fetchLiveQueues(){
  if(_liveQCache&&Date.now()-_liveQAt<1800000)return _liveQCache;
  try{
    const token=await getToken();if(!token)return null;
    const _eps=[
      ["GET","/flow/voice/routing?page=1&limit=500",null],
      ["GET","/flow/voice/routing",null],
      ["GET","/cc/flow/voice/routing?page=1&limit=500",null],
      ["POST","/flow/voice/routing/list",{page:1,limit:500}],
      ["GET","/queue/list",null],["GET","/cc/queue/list",null],
    ];
    const _arr=b=>{
      if(Array.isArray(b))return b;
      if(b&&typeof b==="object"){
        for(const k of ["routings","routing","queues","items","results","data","list","rows","content"])if(Array.isArray(b[k]))return b[k];
        for(const k of ["data","result","payload"])if(b[k]&&typeof b[k]==="object"){const inner=_arr(b[k]);if(inner.length)return inner;}
      }
      return[];
    };
    const _qn=d=>{
      if(typeof d==="string")return d;
      if(!d||typeof d!=="object")return null;
      return d.queueName||d.name||d.label||d.title||d.displayName||
             (d.queue&&(d.queue.queueName||d.queue.name))||
             (d.target&&(d.target.queueName||d.target.name))||null;
    };
    let routings=[];
    for(const[m,p,bd]of _eps){
      try{
        const r=await apiReqFull(m,p,bd,token);
        if(r.status===200){const a=_arr(r.body);if(a.length){routings=a;break;}}
      }catch(e){}
    }
    if(!routings.length)return null;
    // Grouper les files par campagne
    const liveMap={};
    for(const r of routings){
      const qn=_qn(r);if(!qn)continue;
      const camp=detectCampaignSrv(qn);
      if(camp){if(!liveMap[camp])liveMap[camp]=new Set();liveMap[camp].add(qn);}
    }
    // Fusionner avec la config statique
    const mergedMap={};const mergedCamps=[...CAMPS];
    for(const c of CAMPS){
      const st=QUEUES_MAP[c]||[];
      const lv=liveMap[c]?[...liveMap[c]]:[];
      mergedMap[c]=[...new Set([...st,...lv])];
    }
    // Nouvelles campagnes découvertes dans INO mais absentes de queues_config
    for(const[c,qs]of Object.entries(liveMap)){
      if(!CAMPS.includes(c)){mergedCamps.push(c);mergedMap[c]=[...qs];}
    }
    _liveQCache={CAMPS:mergedCamps,QUEUES_MAP:mergedMap,SKILLS,_liveAt:new Date().toISOString(),_routingsCount:routings.length};
    _liveQAt=Date.now();
    console.log("[live-queues] "+routings.length+" routings INO → "+mergedCamps.length+" campagnes");
    return _liveQCache;
  }catch(e){console.error("fetchLiveQueues:",e.message);return null;}
}
// Préchauffer au démarrage (best-effort, non bloquant)
setTimeout(()=>fetchLiveQueues().catch(()=>{}),8000);
// ────────────────────────────────────────────────────────────────────────────

// Horaires d'ouverture de référence par campagne — source : onglet Horaire du fichier
// de calibration INO (10/06/2026). Structure par jour FR : lun/mar/mer/jeu/ven/sam/dim.
// Utilisés comme valeur par défaut dans isCampOpenAt() quand aucun critère n'est
// configuré en production, ET applicables en un clic via /api/admin/apply-hours.
const _defJR = (o,f) => ({on:true,o,f});
const _offJR  = ()    => ({on:false,o:"09:00",f:"18:00"});
const _wkJR   = (o,f,sO,sF,dO,dF) => ({
  lun:_defJR(o,f),mar:_defJR(o,f),mer:_defJR(o,f),jeu:_defJR(o,f),ven:_defJR(o,f),
  sam:sO?_defJR(sO,sF):_offJR(), dim:dO?_defJR(dO,dF):_offJR()
});
const CAMP_HOURS_DEFAULT = {
  // Horaire Lun-Ven / Sam / Dim  (null Sam/Dim = fermé)
  Afnor:                _wkJR("09:00","17:00"),
  Alcéane:              null,  // H24
  Antargaz:             _wkJR("09:00","18:00"),
  Apex:                 _wkJR("09:00","19:00"),
  Delsey:               _wkJR("09:00","19:00","10:00","18:00"),
  ELECTROSUR:           _wkJR("08:00","20:00"),
  Eiffage:              _wkJR("09:00","19:00","10:00","19:00"),
  Elvetis:              _wkJR("09:00","18:00"),
  Equisign:             _wkJR("09:30","18:00"),
  Evoriel:              _wkJR("09:00","17:00"),
  Filippi:              _wkJR("09:00","19:00","08:00","19:00","08:00","19:00"),
  HMF:                  _wkJR("08:30","19:00","09:00","17:00"),
  LBE:                  _wkJR("08:30","18:30"),
  LGR:                  _wkJR("09:00","19:00","10:00","19:00"),
  LMB:                  _wkJR("09:00","17:00"),
  LMDW:                 _wkJR("09:00","19:00","10:00","19:00"),
  M123:                 _wkJR("09:00","18:00","10:00","18:00"),
  "MG Motor":           _wkJR("09:00","18:00"),
  Monetize:             _wkJR("09:00","18:00"),
  "Nature & Découvertes": _wkJR("09:00","17:00","10:00","17:00"),
  Omoda:                _wkJR("08:00","19:00"),
  SOS:                  _wkJR("09:00","18:00"),
  Vivest:               null,  // H24
  Voltalis:             _wkJR("08:00","20:00","10:00","18:00","10:00","18:00"),
  // Campagnes ajoutées 10/06/2026 (source : onglet Horaire Excel)
  CNPA:       _wkJR("09:00","18:00","10:00","17:00"),
  Verspieren: _wkJR("09:00","18:00"),
  Groupama:   _wkJR("10:00","18:00"),
  GS1:        _wkJR("09:00","18:00"),  // 09-13h + 14-18h, simplifié en 09-18h
  MNZ:        _wkJR("09:00","17:00"),
};

// Campagne d'une queue — même cascade que detectCampaign() côté client (dashboard/planning/astreinte)
// pour que l'attribution serveur des flux par campagne coïncide avec celle des agents côté client.
function detectCampaignSrv(queueName){
  if(!queueName)return null;
  for(const c of CAMPS){if((QUEUES_MAP[c]||[]).includes(queueName))return c;}
  const normP=s=>s.toLowerCase().replace(/[éè]/g,"e").replace(/[& ]/g,"");
  for(const c of CAMPS){if(normP(queueName).startsWith(normP(c)))return c;}
  const q0=queueName.toLowerCase().replace(/[éèê]/g,"e").replace(/[àâ]/g,"a").replace(/[-_]/g," ");
  for(const c of CAMPS){
    const cl=c.toLowerCase().replace(/[éèê]/g,"e").replace(/[àâ]/g,"a").replace(/[-_]/g," ");
    if(q0.includes(cl)||cl.includes(q0.split(" ")[0]))return c;
  }
  const tok=queueName.replace(/^sortant /i,"").split(/[_ ]/)[0];
  return CAMPS.find(cp=>cp.toLowerCase().startsWith(tok.toLowerCase()))||null;
}

// Horaires d'ouverture par campagne — mêmes règles et mêmes défauts que isCampOpen() du dashboard
// (critères partagés sharedStore.criteres : h24, jours{lun..dim:{on,o,f}}, repli h_ouv/h_ferm).
// Sert à exclure des statistiques les appels reçus hors horaires d'ouverture du service.
function _toMinSrv(t){const p=String(t||"").split(":");return (parseInt(p[0],10)||0)*60+(parseInt(p[1],10)||0);}
function isCampOpenAt(camp,d){
  // CAMP_HOURS_DEFAULT est la source autoritaire (calibrée le 10/06/2026).
  // null = H24. Le sharedStore peut forcer h24:true pour les campagnes non listées.
  const def=CAMP_HOURS_DEFAULT[camp];
  if(def===null)return true;  // H24 (Alcéane, Vivest)
  const cc=(sharedStore.criteres&&sharedStore.criteres[camp])||{};
  if(cc.h24)return true;
  const min=parisMinOfDay(d);
  const jours=def||(cc.jours&&typeof cc.jours==="object"?cc.jours:null);
  if(jours){
    const jd=jours[parisJour(d)];
    if(jd){
      if(!jd.on)return false;
      return min>=_toMinSrv(jd.o||"09:00")&&min<_toMinSrv(jd.f||"18:00");
    }
  }
  return min>=_toMinSrv(cc.h_ouv||"08:00")&&min<_toMinSrv(cc.h_ferm||"20:00");
}

// ── Persistance partagée des réglages superviseurs (seuils, backlog, ajustements
// manuels mails/heures, colonnes WhatsApp, presets) — un fichier JSON local sert de
// source commune à tous les superviseurs (au lieu du localStorage, propre à chaque
// navigateur, qui causait des incohérences d'un poste à l'autre).
// DATA_DIR est configurable par variable d'environnement : pour survivre aux
// redéploiements Railway (filesystem éphémère par défaut), monter un volume persistant
// et fixer DATA_DIR sur son point de montage. Sans volume, le fichier survit aux
// redémarrages normaux mais est réinitialisé à chaque nouveau déploiement.
const DATA_DIR=process.env.DATA_DIR||path.join(__dirname,"data");
const STORE_FILE=path.join(DATA_DIR,"shared_store.json");
const STORE_KEYS=["criteres","backlog","mailsEdit","waCols","presets","astreintes","planning","poles","mailOverrides","pilotageTpl","radarTpl","planningHist","payroll"];
let sharedStore={};
try{
  fs.mkdirSync(DATA_DIR,{recursive:true});
  if(fs.existsSync(STORE_FILE))sharedStore=JSON.parse(fs.readFileSync(STORE_FILE,"utf8"))||{};
  console.log("[store] "+Object.keys(sharedStore).length+" clé(s) chargée(s) depuis "+STORE_FILE);
}catch(e){console.error("[store] Lecture impossible, démarrage à vide :",e.message);}
let _storeWriteTimer=null;
function persistStore(){
  // Écriture différée + atomique (fichier temporaire puis renommage) : évite de bloquer
  // l'event loop à chaque sauvegarde et de corrompre le fichier en cas d'écritures rapprochées.
  clearTimeout(_storeWriteTimer);
  _storeWriteTimer=setTimeout(()=>{
    try{
      const tmp=STORE_FILE+".tmp";
      fs.writeFileSync(tmp,JSON.stringify(sharedStore));
      fs.renameSync(tmp,STORE_FILE);
    }catch(e){console.error("[store] Écriture impossible :",e.message);}
  },1000);
}
// ────────────────────────────────────────────────────────────────────────────

let bToken=null,bExp=0,sseClients=[],lastPayload=null,statsCache={};
// Cache de l'inventaire des files INO (/api/admin/queues) — l'analyse balaye 7 jours
// d'historiques (14 appels INO), trop coûteuse pour être relancée à chaque clic.
let _queuesCache=null,_queuesCacheAt=0;
// Cache des données Evo sortant — alimenté par /api/evo/ingest (poussé depuis un poste
// du réseau local, voir §evo plus bas), pas par un appel sortant du serveur Railway.
let _evoCache=null,_evoCacheAt=0;
const EVO_STALE_MS=10*60*1000; // au-delà de 10 min sans nouvel envoi, données considérées périmées
// Persistance disque : le cache survit aux redémarrages du conteneur (sinon « EVO INDISPONIBLE »
// tant que le poste local n'a pas re-poussé). Réinitialisé seulement lors d'un redéploiement.
const EVO_CACHE_FILE=path.join(__dirname,"evo_cache.json");
function evoSaveCache(){try{fs.writeFileSync(EVO_CACHE_FILE,JSON.stringify({at:_evoCacheAt,c:_evoCache}));}catch(e){}}
// Historique par journée : un fichier par dataDate (dernier push de la journée = journée
// complète). Permet de consulter les jours antérieurs via /api/evo/sortant?date=YYYY-MM-DD.
// NB : stockage sur le disque du conteneur — un redéploiement le vide ; re-poussable depuis
// le poste local (evo_push_rest.py DD/MM/YYYY).
const EVO_HIST_DIR=path.join(__dirname,"evo_history");
try{fs.mkdirSync(EVO_HIST_DIR,{recursive:true});}catch(e){}
function evoSaveHist(c){try{if(c&&c.dataDate&&/^\d{4}-\d{2}-\d{2}$/.test(c.dataDate))fs.writeFileSync(path.join(EVO_HIST_DIR,c.dataDate+".json"),JSON.stringify({at:Date.now(),c}));}catch(e){}}
function evoLoadHist(d){try{const p=path.join(EVO_HIST_DIR,d+".json");if(fs.existsSync(p)){const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j&&j.c){j.c._at=j.at;return j.c;}}}catch(e){}return null;}
(function evoLoadCache(){try{if(fs.existsSync(EVO_CACHE_FILE)){const j=JSON.parse(fs.readFileSync(EVO_CACHE_FILE,"utf8"));if(j&&j.c){_evoCache=j.c;_evoCacheAt=j.at||Date.now();console.log("[evo] cache rechargé depuis le disque ("+new Date(_evoCacheAt).toISOString()+")");}}}catch(e){}})();

// ── Cache COMPÉTENCES INO par agent (persistant) ─────────────────────────────
// Problème résolu : la Matrice des compétences dépendait d'un bouton manuel « ↺ Compétences »
// qui interrogeait /cc/agent/:id/flow/voice/skills/list pour ~55 agents par lots de 3 (budget 50s,
// sensible à la contention de jetons) → matrice souvent VIDE (« 0 agent » sur des comptes couverts,
// ex. M123 alors que Stéphanie KRAEMER l'a configuré en status 0). Désormais : un job de fond charge
// TOUTES les compétences (configurées + actives) une fois, les persiste sur disque (survit aux
// redéploiements Railway), rafraîchit toutes les 6 h, et les injecte directement dans /agents-day.
// La matrice est ainsi toujours peuplée, sans appel bloquant au chargement.
// DATA_DIR (volume persistant si monté) et non __dirname (effacé à chaque redéploiement).
const CC_SKILLS_FILE=path.join(DATA_DIR,"cc_skills_cache.json");
const _CC_SKILLS_OLD=path.join(__dirname,"cc_skills_cache.json");
let _ccSkills={data:{},at:0,running:false};
function ccSkillsSave(){try{fs.writeFileSync(CC_SKILLS_FILE,JSON.stringify({at:_ccSkills.at,data:_ccSkills.data}));}catch(e){}}
(function ccSkillsLoad(){try{
  const p=fs.existsSync(CC_SKILLS_FILE)?CC_SKILLS_FILE:(fs.existsSync(_CC_SKILLS_OLD)?_CC_SKILLS_OLD:null);
  if(p){const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j&&j.data){_ccSkills.data=j.data;_ccSkills.at=j.at||0;console.log("[cc-skills] cache rechargé ("+Object.keys(j.data).length+" agents, "+new Date(_ccSkills.at).toISOString()+")");}}
}catch(e){}})();

const INO_TIMEOUT_MS = 15000; // 15s max par appel INO

// ── QUOTA API INO — suivi local + ARRÊT à 70 % (demande Tarik) ───────────────
// Limites INO : 1000 requêtes/heure, 10000/jour (écran Quotas du gestionnaire de données).
// Au-delà de 70 % on SUSPEND tout appel sortant INO jusqu'à la remise à zéro (top d'heure /
// minuit Paris) — mieux vaut un dashboard en cache qu'un compte API bloqué par INO.
// Les entêtes X-EKO-Left-Hour/Day, quand INO les renvoie, sont autoritaires (elles comptent
// AUSSI les autres consommateurs du même compte API).
const INO_QUOTA_HOUR=1000, INO_QUOTA_DAY=10000, INO_QUOTA_STOP=0.70;
const _inoQuota={hourKey:"",hourCount:0,dayKey:"",dayCount:0,hdrLeftHour:null,hdrLeftDay:null,hdrAt:0,refused:0};
const _parisHourFmtSrv=new Intl.DateTimeFormat("fr-FR",{timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
function _quotaTick(){
  const now=new Date();
  const hk=parisDateStr(now)+"T"+String(now.getUTCHours()); // clé de fenêtre : l'heure PLEINE (identique quel que soit le fuseau)
  const dk=parisDateStr(now);
  if(_inoQuota.hourKey!==hk){_inoQuota.hourKey=hk;_inoQuota.hourCount=0;}
  if(_inoQuota.dayKey!==dk){_inoQuota.dayKey=dk;_inoQuota.dayCount=0;}
}
function inoQuotaUsedHour(){
  _quotaTick();
  let u=_inoQuota.hourCount;
  if(_inoQuota.hdrLeftHour!=null&&(Date.now()-_inoQuota.hdrAt)<5*60*1000)u=Math.max(u,INO_QUOTA_HOUR-_inoQuota.hdrLeftHour);
  return u;
}
function inoQuotaBlocked(){
  _quotaTick();
  return inoQuotaUsedHour()>=INO_QUOTA_HOUR*INO_QUOTA_STOP||_inoQuota.dayCount>=INO_QUOTA_DAY*INO_QUOTA_STOP;
}
function inoQuotaCount(headers){
  _quotaTick();_inoQuota.hourCount++;_inoQuota.dayCount++;
  try{
    const lh=headers&&headers["x-eko-left-hour"], ld=headers&&headers["x-eko-left-day"];
    if(lh!=null&&lh!==""){_inoQuota.hdrLeftHour=parseInt(lh,10);_inoQuota.hdrAt=Date.now();}
    if(ld!=null&&ld!=="")_inoQuota.hdrLeftDay=parseInt(ld,10);
  }catch(e){}
}
function inoQuotaState(){
  _quotaTick();
  const now=new Date();
  const resetHour=new Date(now); resetHour.setMinutes(60,0,0); // prochain top d'heure (indépendant du fuseau)
  const p=_parisHourFmtSrv.format(now).split(":").map(Number);
  const resetDay=new Date(now.getTime()+(86400000-(p[0]*3600+p[1]*60+p[2])*1000)); // prochain minuit Paris
  const usedHour=inoQuotaUsedHour();
  const dayBlocked=_inoQuota.dayCount>=INO_QUOTA_DAY*INO_QUOTA_STOP;
  const blocked=inoQuotaBlocked();
  return {limitHour:INO_QUOTA_HOUR,usedHour,pctHour:Math.min(100,Math.round(usedHour/INO_QUOTA_HOUR*100)),
    limitDay:INO_QUOTA_DAY,usedDay:_inoQuota.dayCount,pctDay:Math.min(100,Math.round(_inoQuota.dayCount/INO_QUOTA_DAY*100)),
    stopPct:Math.round(INO_QUOTA_STOP*100),blocked,blockedBy:blocked?(dayBlocked?"jour":"heure"):null,
    resetAt:(blocked&&dayBlocked)?resetDay.toISOString():resetHour.toISOString(),
    refused:_inoQuota.refused,hdrLeftHour:_inoQuota.hdrLeftHour};
}
function _quotaRefuseError(){
  _inoQuota.refused++;
  const st=inoQuotaState();
  const hh=new Date(st.resetAt).toLocaleTimeString("fr-FR",{timeZone:"Europe/Paris",hour:"2-digit",minute:"2-digit"});
  return new Error("Quota INO "+st.pctHour+"% (seuil "+st.stopPct+"%) — appels suspendus, reprise à "+hh);
}

function apiReq(method,p,body,token,timeoutMs){
  return new Promise((resolve,reject)=>{
    if(inoQuotaBlocked())return reject(_quotaRefuseError());
    const auth=token?("Bearer "+token):"Basic "+Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+p,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const ms=timeoutMs||INO_TIMEOUT_MS;
    let settled=false;
    const done=(fn,val)=>{if(!settled){settled=true;clearTimeout(timer);fn(val);}};
    // Timeout : résoudre avec objet vide plutôt que rejeter (données partielles acceptées)
    const timer=setTimeout(()=>{
      console.warn("[INO TIMEOUT] "+method+" "+p+" > "+ms+"ms — données partielles retournées");
      done(resolve,{_timeout:true,histories:[]});
    },ms);
    const req=https.request(opts,r=>{inoQuotaCount(r.headers);let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{done(resolve,JSON.parse(buf));}catch{done(resolve,buf);}});});
    req.on("error",e=>{done(reject,e);});
    if(data)req.write(data);req.end();
  });
}
// Version exposant le status HTTP (utilisée pour les routes nécessitant gestion 401)
// Timeout obligatoire (défaut INO_TIMEOUT_MS) : sans lui, une requête INO qui ne répond
// jamais bloque indéfiniment l'appelant (ex: boucle séquentielle /api/refresh-skills,
// qui attend chaque lot avant de passer au suivant — un seul appel bloqué = tout le
// rafraîchissement des compétences gelé jusqu'au timeout de l'infrastructure en amont).
function apiReqFull(method,p,body,token,timeoutMs){
  return new Promise((resolve,reject)=>{
    if(inoQuotaBlocked())return reject(_quotaRefuseError());
    const auth=token?("Bearer "+token):"Basic "+Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+p,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const ms=timeoutMs||INO_TIMEOUT_MS;
    let settled=false;
    const done=(fn,val)=>{if(!settled){settled=true;clearTimeout(timer);fn(val);}};
    const timer=setTimeout(()=>{
      console.warn("[INO TIMEOUT] "+method+" "+p+" > "+ms+"ms");
      done(resolve,{status:0,body:{_timeout:true}});
    },ms);
    const req=https.request(opts,r=>{inoQuotaCount(r.headers);let buf="";const status=r.statusCode;r.on("data",c=>buf+=c);r.on("end",()=>{try{done(resolve,{status,body:JSON.parse(buf)});}catch{done(resolve,{status,body:buf});}});});
    req.on("error",e=>{done(reject,e);});
    if(data)req.write(data);req.end();
  });
}

// ── Client API Evolution (Ekiom) ──────────────────────────────────────────────
const EVO_TIMEOUT_MS=15000;
// GET sur l'API Manager d'Evolution. Auth Basic, réponse JSON. On force le module
// http/https selon `proto`. Rejette en cas de status >=400 ou de réponse non-JSON
// (mode honnête : on ne renvoie jamais des données inventées en cas d'échec).
function evoGet(apiPath,proto,timeoutMs){
  return new Promise((resolve,reject)=>{
    const mod=proto==="http"?http:https;
    const auth="Basic "+Buffer.from(EVO_LOGIN+":"+EVO_PWD).toString("base64");
    const opts={hostname:EVO_HOST,path:apiPath,method:"GET",headers:{"Authorization":auth,"Accept":"application/json"}};
    const ms=timeoutMs||EVO_TIMEOUT_MS;
    let settled=false;
    const done=(fn,val)=>{if(!settled){settled=true;clearTimeout(timer);fn(val);}};
    const timer=setTimeout(()=>{done(reject,new Error("Evo: délai dépassé (>"+ms+"ms)"));},ms);
    const req=mod.request(opts,r=>{
      let buf="";const status=r.statusCode;
      r.on("data",c=>buf+=c);
      r.on("end",()=>{
        if(status>=400){done(reject,new Error("Evo: HTTP "+status+(status===401?" (identifiants Manager refusés)":"")));return;}
        try{done(resolve,JSON.parse(buf));}catch(e){done(reject,new Error("Evo: réponse non-JSON (le serveur a peut-être renvoyé une page HTML)"));}
      });
    });
    req.on("error",e=>{done(reject,e);});
    req.end();
  });
}
// Tente le protocole configuré (https par défaut) puis bascule sur l'autre en cas
// d'échec de connexion — évite de devoir deviner http vs https côté Evolution.
async function evoGetAuto(apiPath){
  try{return await evoGet(apiPath,EVO_PROTO);}
  catch(e){
    const alt=EVO_PROTO==="https"?"http":"https";
    try{return await evoGet(apiPath,alt);}
    catch(e2){throw e;} // on remonte l'erreur du protocole principal (plus parlante)
  }
}
// Convertit le format Evolution {Headers:[{Name}], DataSet:[{EntityName,Row}]} en
// tableau d'objets {_id,_name, <Name>:valeur}. Gère "Row" ET "Ligne" (le champ peut
// être traduit par certains navigateurs/proxys — l'API brute renvoie "Row").
function evoParse(payload){
  const names=((payload&&payload.Headers)||[]).map(h=>h&&h.Name);
  const rows=(payload&&payload.DataSet)||[];
  return rows.map(r=>{
    const o={_id:r.EntityId,_name:r.EntityName};
    const vals=r.Row||r.Ligne||r.Rows||[];
    names.forEach((n,i)=>{if(n)o[n]=vals[i];});
    return o;
  });
}
const _num=v=>{const n=Number(v);return isFinite(n)?n:0;};
// Parse le rapport Evolution « Estado de listas » (100000035), au format
// {ReportData:{Headers:[{Header}],Rows:[{Values:[...]}]}} — DIFFÉRENT du format
// des mesurables. Renvoie [{campaign, id, imported, pending, available, finished, new}].
// La colonne « Campaign » contient le nom suivi de l'id entre crochets : « NOM [100000185] ».
function evoParseEstado(rawEstado){
  const rd=rawEstado&&rawEstado.ReportData; if(!rd||!rd.Rows)return[];
  const heads=(rd.Headers||[]).map(h=>(h&&(h.Header||h.Name)||"").trim());
  const idx=name=>heads.findIndex(h=>h.toLowerCase()===name.toLowerCase());
  const iCamp=idx("Campaign"),iImp=idx("Imported"),iPend=idx("Pending"),
        iAvail=idx("Total_Available"),iFin=idx("Finished"),iNew=idx("New");
  return (rd.Rows||[]).map(r=>{
    const v=r.Values||r.Value||[];
    const campRaw=iCamp>=0?String(v[iCamp]||""):"";
    const m=campRaw.match(/\[(\d+)\]\s*$/);            // extrait l'id entre crochets
    const id=m?m[1]:null;
    const nom=campRaw.replace(/\s*\[\d+\]\s*$/,"").trim();
    return {
      campaign:nom, id,
      imported:iImp>=0?_num(v[iImp]):0,
      pending:iPend>=0?_num(v[iPend]):0,
      available:iAvail>=0?_num(v[iAvail]):0,
      finished:iFin>=0?_num(v[iFin]):0,
      neuf:iNew>=0?_num(v[iNew]):0     // « New » = fiches jamais mises en file (vierges)
    };
  }).filter(x=>x.campaign||x.id);
}
// Une campagne est « sortante » si elle présente une activité de NUMÉROTATION :
//  - des non-joignables (NCDia : on ne « non-contacte » que des numéros qu'on appelle),
//  - un stock de fiches planifiées (NP),
//  - ou des appels en cours de numérotation (Mr).
// On n'utilise PAS PS/PA (fiches planifiées système/agent) : des campagnes de RÉCEPTION
// peuvent en avoir quelques-unes (rappels résiduels) → faux positifs constatés (ex. « EKIOM
// Réception d'Appels » avec PS=1/PA=7). NCDia reste à 0 en réception pure.
function evoIsOutbound(c){
  return _num(c.NCDia_Campanya)>0||_num(c.NP)>0||_num(c.Mr)>0;
}
// Agrège les lignes SQL brutes (une par campagne+code) en un objet par campagne.
// LECTURE SEULE : ces données viennent de la base Evolution, jamais modifiées.
function evoProcessSqlStats(rows){
  if(!rows||!rows.length)return {};
  const byCamp={};
  rows.forEach(r=>{
    const id=String(r.idCampanya||"");
    if(!byCamp[id])byCamp[id]={
      idCampanya:id, campNom:r.campNom||"",
      nbTrans:0, cuTotal:0, cuPos:0, cuNeg:0,
      refus:0, fauxNum:0, repondeur:0, sansRep:0, raNb:0,
      dmc_sum:0, dmc_n:0, dmt_sum:0, dmt_n:0, att_sum:0, att_n:0,
      call_sum:0, wrapup_sum:0
    };
    const c=byCamp[id];
    const nb=_num(r.nb);
    c.nbTrans+=nb;
    if(r.ra)c.raNb+=nb; // appels routés via un service de relance auto (RA) — cf. evo_export_rest.py
    const ctd=_num(r.contactado);
    if(ctd>0){c.cuTotal+=nb;if(ctd>=2)c.cuPos+=nb;else c.cuNeg+=nb;}
    // Codes systeme
    const fid=_num(r.idFinal);
    const nom=(r.finalNom||"").toLowerCase();
    if(nom.includes("refus"))c.refus+=nb;
    if(fid===15||fid===9)c.fauxNum+=nb;
    if(fid===19)c.repondeur+=nb;
    if(fid===1)c.sansRep+=nb;
    // Moyennes pondérées
    if(r.dmc_sec!=null&&ctd>0){c.dmc_sum+=r.dmc_sec*nb;c.dmc_n+=nb;}
    if(r.dmt_sec!=null){c.dmt_sum+=r.dmt_sec*nb;c.dmt_n+=nb;}
    if(r.attente_sec!=null){c.att_sum+=r.attente_sec*nb;c.att_n+=nb;}
    // Temps total appels + wrap-up (base des calculs par heure si session REST non dispo)
    c.call_sum+=_num(r.sum_call_sec);
    c.wrapup_sum+=_num(r.sum_wrapup_sec);
  });
  const out={};
  Object.values(byCamp).forEach(c=>{
    out[c.idCampanya]={
      ...c,
      dmc: c.dmc_n>0?Math.round(c.dmc_sum/c.dmc_n):null,
      dmt: c.dmt_n>0?Math.round(c.dmt_sum/c.dmt_n):null,
      attente: c.att_n>0?Math.round(c.att_sum/c.att_n):null,
      tauxContact: c.nbTrans>0?Math.round(c.cuTotal/c.nbTrans*100):null,
      total_prod_sec: c.call_sum+c.wrapup_sum,   // proxy heures prod (appels+wrapup SQL)
      ra_nb: c.raNb
    };
  });
  return out;
}
function evoProcessSqlFiles(rows){
  if(!rows||!rows.length)return {};
  const out={};
  (rows||[]).forEach(r=>{
    const id=String(r.idCampanya||"");
    out[id]={
      total:_num(r.total),
      disponibles:_num(r.disponibles),
      terminees:_num(r.terminees),
      moyTentatives:r.moy_tentatives!=null?Math.round(_num(r.moy_tentatives)*10)/10:null,
      tauxDescente:_num(r.total)>0?Math.round(_num(r.terminees)/_num(r.total)*100):null
    };
  });
  return out;
}
// Agrège les lignes SQL brutes (agent × campagne) en un tableau par agent.
// session_span_sec = du premier appel au dernier appel terminé (inclus wrap-up)
// → mesure la durée réelle de production, pas seulement le temps des appels.
function evoProcessAgentCamps(rows){
  if(!rows||!rows.length)return[];
  const byAgent={};
  rows.forEach(r=>{
    const aid=String(r.idAgente||"");
    if(!byAgent[aid])byAgent[aid]={idAgente:aid,nom:"",camps:[],nb:0,cuPos:0,cuTotal:0,definitifs:0,tft:0,hc:0,ra_nb:0,prod_sec:0,dmt_sum:0,dmt_n:0};
    const a=byAgent[aid];
    if(!a.nom&&r.agentNom)a.nom=r.agentNom; // nom historique (agents pas connectés maintenant)
    const nb=_num(r.nb);
    const ps=_num(r.session_span_sec);  // durée réelle (premier→dernier appel)
    a.camps.push({
      idCampanya:String(r.idCampanya||""),campNom:r.campNom||"",
      nb,cuPos:_num(r.cuPos),cuTotal:_num(r.cuTotal),definitifs:_num(r.definitifs),
      tft:_num(r.tft),hc:_num(r.hc),ra_nb:_num(r.ra_nb),talk_sec:_num(r.talk_sec),comm_sec:_num(r.comm_sec),comm_n:_num(r.comm_n),
      prod_sec:ps,
      cnx_ms:(r.cnx_ms!=null?r.cnx_ms:null),deco_ms:(r.deco_ms!=null?r.deco_ms:null),online:!!r.online,
      dmt:r.dmc_sec!=null?Math.round(_num(r.dmc_sec)):(r.dmt_sec!=null?Math.round(_num(r.dmt_sec)):null)
    });
    a.nb+=nb; a.cuPos+=_num(r.cuPos); a.cuTotal+=_num(r.cuTotal);
    a.definitifs+=_num(r.definitifs); a.tft+=_num(r.tft); a.hc+=_num(r.hc); a.ra_nb+=_num(r.ra_nb); a.prod_sec+=ps;
    if(r.dmt_sec!=null){a.dmt_sum+=_num(r.dmt_sec)*nb;a.dmt_n+=nb;}
  });
  return Object.values(byAgent).map(a=>({
    ...a,
    dmt:a.dmt_n>0?Math.round(a.dmt_sum/a.dmt_n):null
  })).sort((a,b)=>b.nb-a.nb);
}
// Somme les session_span_sec par campagne (depuis q3) pour obtenir les heures
// de production RÉELLES par campagne (somme des sessions de tous les agents).
function evoAgentCampsToProdByCamp(agentCamps){
  const out={};
  agentCamps.forEach(a=>{
    a.camps.forEach(cc=>{
      const id=cc.idCampanya;
      out[id]=(out[id]||0)+cc.prod_sec;
    });
  });
  return out;
}
// Transforme les deux payloads bruts Evolution (campagnes + agents mesurables) en
// JSON propre {totaux, campagnes, agents}, filtré sur le périmètre sortant.
function evoBuildPayload(rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,campProdBySqlId){
  // État des listes (fichier) par campagne, indexé par id ET par nom pour la jointure.
  const sqlStatsByCamp=evoProcessSqlStats(rawSqlStats||[]);
  const sqlFilesByCamp=evoProcessSqlFiles(rawSqlFiles||[]);
  const prodByCamp=campProdBySqlId||{};
  const estadoArr=evoParseEstado(rawEstado);
  const estadoById={},estadoByName={};
  estadoArr.forEach(e=>{ if(e.id)estadoById[String(e.id)]=e; if(e.campaign)estadoByName[e.campaign.toLowerCase()]=e; });
  // Campagnes ayant de l'activité SQL aujourd'hui : incluses même si les compteurs REST sont à 0
  const sqlActiveCampIds=new Set(Object.keys(sqlStatsByCamp));
  const camps=evoParse(rawCamp).filter(c=>evoIsOutbound(c)||sqlActiveCampIds.has(String(c._id))).map(c=>{
    const est=estadoById[String(c._id)]||estadoByName[String(c._name||"").toLowerCase()]||null;
    return {
    nom:c._name, id:c._id,
    agents:_num(c.T),                 // agents connectés à la campagne
    appels:_num(c.TrDia),             // transactions (appels) du jour
    appelsHeure:_num(c.TrHora),       // appels de la dernière heure
    enCours:_num(c.Mr)+_num(c.CA)+_num(c.CM), // appels EN COURS (numérotation Mr + connectés CA/CM) → vignette live
    positifs:_num(c.CUPosDia_Campanya), // contacts utiles positifs (résultats)
    negatifs:_num(c.CUNegDia_Campanya), // contacts utiles négatifs
    nonUtiles:_num(c.CNUDia_Campanya),  // contacts non utiles
    nonContactes:_num(c.NCDia_Campanya),// non joignables
    abandons:_num(c.AbDia),           // abandons du jour
    finalises:_num(c.F),              // fiches finalisées par un agent
    // Fichier EN PRODUCTION (mesurables) : à appeler = planifiées système + agent + nouvelles.
    // Exclut explicitement les BLOQUÉES (B) et les CLÔTURÉES (F) → base des estimations.
    fichierDispo:  _num(c.NP)+_num(c.PS)+_num(c.PA),
    fichierBloque: _num(c.B),
    fichierClot:   _num(c.F),
    // État du fichier (rapport « Estado de listas ») — null si non disponible
    fichierRecu:   est?est.imported :null,  // fichier reçu (total importé)
    fichierVierge: est?est.neuf     :null,  // fiches jamais appelées (« New »)
    restantATraiter:est?est.available:null, // fiches encore disponibles à appeler
    fichesConclues:est?est.finished :null,  // fiches clôturées
    // Indicateurs SQL — null si SQL indisponible.
    // total_prod_sec = temps de communication (appels + wrap-up), borné. On n'utilise
    // PLUS le « span » d'amplitude (1er→dernier appel) qui gonflait à 2,4 h pour 1 appel
    // (cf. audit cohérence : un span n'est pas du temps de travail).
    sql: sqlStatsByCamp[String(c._id)]||null,
    fichier:sqlFilesByCamp[String(c._id)]||null
    };
  });
  // Campagnes présentes en SQL mais absentes des mesurables REST (ex. sous-fichiers
  // C_143, C_327…). Sans cet ajout, toute l'activité réelle reste hors périmètre et les
  // KPI affichent 0 alors que les données existent. On les reconstruit depuis le SQL.
  const restIds=new Set(camps.map(c=>String(c.id)));
  Object.values(sqlStatsByCamp).forEach(s=>{
    const sid=String(s.idCampanya);
    if(restIds.has(sid))return;
    const est=estadoById[sid]||estadoByName[String(s.campNom||"").toLowerCase()]||null;
    camps.push({
      nom:s.campNom||("Campagne "+sid), id:s.idCampanya,
      agents:0, appels:s.nbTrans||0, appelsHeure:0,
      positifs:s.cuPos||0, negatifs:s.cuNeg||0, nonUtiles:0, nonContactes:0,
      abandons:0, finalises:0,
      fichierRecu:est?est.imported:null, fichierVierge:est?est.neuf:null,
      restantATraiter:est?est.available:null, fichesConclues:est?est.finished:null,
      sql: s,
      fichier:sqlFilesByCamp[sid]||null,
      _sqlOnly:true
    });
  });
  camps.sort((a,b)=>b.appels-a.appels);
  // Agents : on garde ceux ayant une activité de numérotation (sortant) ou des appels.
  const agents=evoParse(rawAg).map(a=>({
    nom:a._name, id:a._id,
    campagne:(typeof a.CmpPau==="string"&&a.CmpPau)||"–", // campagne en cours
    appels:_num(a.TraDia),            // transactions (appels) du jour
    appelsHeure:_num(a.TraHora),
    positifs:_num(a.CUPosDia_Agente), // résultats positifs
    negatifs:_num(a.CUNegDia_Agente),
    nonUtiles:_num(a.CNUDia_Agente),
    nonContactes:_num(a.NCDia_Agente),
    sessionSec:_num(a.Sesiones),      // temps en session du jour (s)
    pauseSec:_num(a.PausasTiempo)     // temps en pause du jour (s)
  })).filter(a=>a.appels>0||a.nonContactes>0).sort((a,b)=>b.appels-a.appels);
  // Totaux du périmètre sortant
  const sum=(arr,k)=>arr.reduce((s,x)=>s+x[k],0);
  const totaux={
    campagnes:camps.length,
    appels:sum(camps,"appels"),
    positifs:sum(camps,"positifs"),
    nonContactes:sum(camps,"nonContactes"),
    abandons:sum(camps,"abandons"),
    agentsActifs:agents.length,
    // Joignabilité = contacts aboutis / total tentés (positifs+négatifs+nonUtiles+nonContactés)
    joignabilite:(function(){
      const ab=sum(camps,"positifs")+sum(camps,"negatifs")+sum(camps,"nonUtiles");
      const tot=ab+sum(camps,"nonContactes");
      return tot>0?Math.round(ab/tot*100):null;
    })()
  };
  return{totaux,campagnes:camps,agents};
}

async function getToken(force){
  if(!force&&bToken&&Date.now()<bExp)return bToken;
  if(inoQuotaBlocked()){console.warn("[quota] getToken refusé (seuil 70%)");return null;} // /auth compte aussi dans le quota
  try{
    const creds=Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const res=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:"wisecom.unicity.io",path:"/api/auth",method:"GET",headers:{"Authorization":"Basic "+creds}},r=>{inoQuotaCount(r.headers);let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve({});}});});
      req.on("error",reject);req.end();
    });
    if(res.access_token){bToken=res.access_token;bExp=Date.now()+270000;console.log("["+new Date().toLocaleTimeString("fr-FR")+"] Token OK (force="+!!force+")");}
  }catch(e){console.error("Auth:",e.message);}
  return bToken;
}

// ── Flux voix par agent (état du canal de réception) ─────────────────────────────
// GET /cc/agent/:id → {agent:{flowVoice:true|false,...}}. flowVoice=false = l'agent ne reçoit
// PAS les appels voix (flux « gris » de la Supervision INO) même connecté. Réactivation via
// PUT /cc/agent/:id/flow/voice/activate/true (route /api/ino/flux/reactivate). Droits /cc/* requis.
// Cache 45 s : ~55 agents = coûteux à recharger à chaque refresh, mais l'état bouge lentement.
let fluxCache={data:{},at:0};
async function fetchAgentFlux(force){
  if(!force && Date.now()-fluxCache.at<45000 && Object.keys(fluxCache.data).length) return fluxCache.data;
  // Token PARTAGÉ (jamais forcé) : l'API INO limite les jetons valides SIMULTANÉS — forcer un
  // nouveau jeton ici invalidait celui des autres appels en cours (401 en cascade, compétences
  // partiellement chargées). _ccCall ne ré-authentifie QUE sur un vrai 401.
  const tokenRef={t:await getToken()}; const token=tokenRef.t; if(!token) return fluxCache.data||{};
  try{
    const groups=await _ccCall("POST","/cc/agentgroups/list",{start:0,limit:100},tokenRef);
    const gl=(groups&&groups.agentGroups)||[];
    let ags=[];
    for(const g of gl){
      const al=await _ccCall("POST","/cc/agents/"+g.id+"/list",{start:0,limit:250},tokenRef);
      ((al&&al.agents)||[]).forEach(a=>ags.push({id:a.id,groupName:g.name}));
    }
    const map={};
    // GET détail par agent, en parallèle par lots de 10, pour lire flowVoice.
    for(let i=0;i<ags.length;i+=10){
      const chunk=ags.slice(i,i+10);
      const dets=await Promise.all(chunk.map(a=>apiReq("GET","/cc/agent/"+a.id,null,tokenRef.t).then(d=>({a,d})).catch(()=>({a,d:null}))));
      dets.forEach(({a,d})=>{
        const fa=d&&d.agent; if(!fa)return;
        const rec={id:fa.id,flowVoice:!!fa.flowVoice,username:fa.username||null,nom:((fa.firstname||"")+" "+(fa.lastname||"")).trim(),group:a.groupName};
        map[String(fa.id)]=rec;
        if(fa.username)map["u:"+String(fa.username).toLowerCase()]=rec;
        if(rec.nom)map["n:"+rec.nom.toLowerCase()]=rec;
      });
    }
    if(Object.keys(map).length) fluxCache={data:map,at:Date.now()};
  }catch(e){ console.error("[flux] "+e.message); }
  return fluxCache.data;
}

// Récupère les compétences actives par agent depuis INO /agent/list
let skillsCache={};let skillsCacheDate='';
async function fetchAgentSkills(){
  const today=parisDateStr();
  if(skillsCacheDate===today&&Object.keys(skillsCache).length>0)return skillsCache;
  const token=await getToken();if(!token)return {};
  try{
    const res=await apiReq('GET','/agent/list',null,token);
    const list=Array.isArray(res)?res:(res.agents||res.data||[]);
    const map={};
    list.forEach(a=>{
      const id=a.id||a.agentId||a.agent_id;
      const name=(a.firstname||a.firstName||'')+' '+(a.lastname||a.lastName||'');
      const skills=[];
      // INO expose les skills dans competences, skills, queues selon version
      const raw=a.competences||a.skills||a.queues||[];
      (Array.isArray(raw)?raw:[]).forEach(s=>{
        const n=s.name||s.queueName||s.skill||s;
        if(n&&typeof n==='string')skills.push(n);
      });
      if(id)map[id]={nom:name.trim(),skills,login:a.username||a.login||''};
    });
    skillsCache=map;skillsCacheDate=today;
    console.log('[SKILLS] '+Object.keys(map).length+' agents chargés');
    return map;
  }catch(e){console.error('[SKILLS] Erreur:',e.message);return {};}
}


async function fetchDayStats(){
  const token=await getToken();if(!token)return;
  const d=parisDateStr();
  try{
    const[ci,co]=await Promise.all([
      apiReq("POST","/call/in/histories",{startDate:d+" 00:00:00",endDate:d+" 23:59:59",limit:2000},token),
      apiReq("POST","/call/out/histories",{startDate:d+" 00:00:00",endDate:d+" 23:59:59",limit:2000},token)
    ]);
    const all=[...(ci&&ci.histories?ci.histories:[]),...(co&&co.histories?co.histories:[])];
    const tr=all.filter(c=>c.call&&c.call.agentDuration>0);
    const dur=tr.reduce((s,c)=>s+(c.call?c.call.agentDuration:0),0);
    const dmc=tr.length>0?dur/tr.length:0;
    const lc=all.slice().reverse().find(c=>c.call&&c.call.agentDuration>0)||{};
    statsCache={totalAppels:tr.length,totalDuree:dur,dmc,date:d,updatedAt:new Date().toISOString()};
    const payload={id_evenement:"poll_"+Date.now(),horodatage:new Date().toISOString(),agent:{id_ino:"MULTI",nom:"Tous agents",competences_actives:[]},session:{statut_actuel:"disponible"},action_venant_de_se_terminer:{type_acte:lc.call&&lc.call.type==="OUTCALL"?"sortant":"entrant",campagne:lc.queue?lc.queue.queueName:"–",qualification:lc.status||"–",duree_acte_secondes:lc.call?lc.call.agentDuration:0},cumul_journee_agent:{total_appels_traites:tr.length,total_mails_traites:0,temps_total_communication_secondes:dur,heures_de_prod_secondes:32400}};
    lastPayload=payload;
    const msg="data: "+JSON.stringify(payload)+"\n\n";
    sseClients.forEach(c=>{try{c.write(msg);}catch(e){}});
    sseClients=sseClients.filter(c=>!c.destroyed);
    console.log("["+new Date().toLocaleTimeString("fr-FR")+"] Stats: "+tr.length+" appels | DMC "+Math.floor(dmc/60)+":"+String(Math.round(dmc%60)).padStart(2,"0"));
  }catch(e){console.error("Stats:",e.message);}
}

// ── Annuaire agents (léger) : 3 listes de groupe → id, nom, username, lastLogin ──
// Sert à afficher les agents CONNECTÉS aujourd'hui même sans activité d'appel (supervision).
// N'utilise PAS le GET détail par agent (coûteux) : la liste de groupe suffit (lastLogin inclus).
let _dirCache={data:{},at:0};
// Appel /cc/* robuste : le token INO expire vite (300s). apiReq renvoie le CORPS même sur 401
// ({error:invalid_token}) → sans détection, on lisait « agents:[] » (annuaire vide → agents
// connectés non injectés, ex. Crystelle absente). Ici on détecte le 401 et on rejoue avec un
// token FORCÉ neuf.
async function _ccCall(method,path,body,tokenRef){
  let r=await apiReq(method,path,body,tokenRef.t);
  const bad=r&&typeof r==='object'&&(r.error==='invalid_token'||/bad credentials|invalid_token|expired/i.test(String(r.error_description||r.message||'')));
  if(bad){ tokenRef.t=await getToken(true); r=await apiReq(method,path,body,tokenRef.t); }
  return r;
}
async function fetchAgentDirectory(force){
  if(!force && Date.now()-_dirCache.at<60000 && Object.keys(_dirCache.data).length) return _dirCache.data;
  const tokenRef={t:await getToken()}; if(!tokenRef.t) return _dirCache.data||{};
  try{
    const groups=await _ccCall("POST","/cc/agentgroups/list",{start:0,limit:100},tokenRef);
    const gl=(groups&&groups.agentGroups)||[];
    const map={};
    const _put=(x,gname,role)=>{ if(!x||x.id==null)return; map[String(x.id)]={id:String(x.id),username:x.username,nom:((x.firstname||"")+" "+(x.lastname||"")).trim(),lastLogin:x.lastLogin||null,group:gname,role:role}; };
    for(const g of gl){
      const al=await _ccCall("POST","/cc/agents/"+g.id+"/list",{start:0,limit:250},tokenRef);
      ((al&&al.agents)||[]).forEach(a=>_put(a,g.name,"agent"));
    }
    // ── SUPERVISEURS : ils apparaissent dans la Surveillance INO (profil Superviseur-RA) et
    // prennent des appels/mails. Sans eux le compte d'agents connectés était sous-évalué
    // (ex. BELAIDI Djaffar, DAHMANI Narimane manquants vs les 22 conseillers de la supervision).
    try{
      const sgs=await _ccCall("POST","/cc/supgroups/list",{start:0,limit:100},tokenRef);
      const sgl=(sgs&&(sgs.supGroups||sgs.supgroups))||[];
      for(const g of sgl){
        const sl=await _ccCall("POST","/cc/supervisors/"+g.id+"/list",{start:0,limit:250},tokenRef);
        ((sl&&(sl.supervisors||sl.agents))||[]).forEach(s=>_put(s,g.name,"superviseur"));
      }
    }catch(e){ console.error("[dir] superviseurs: "+e.message); }
    // Ne remplacer le cache que si non vide (un fetch raté ne doit pas effacer un annuaire valide).
    if(Object.keys(map).length){ _dirCache={data:map,at:Date.now()}; }
    else { console.error("[dir] annuaire VIDE (401/param ?) — cache précédent conservé"); }
  }catch(e){ console.error("[dir] "+e.message); }
  return _dirCache.data;
}

// Charge les compétences /cc/* de TOUS les agents de l'annuaire et remplit le cache persistant.
// Job de fond : jamais dans le chemin de /agents-day (pas de latence ni de contention de jetons
// avec le rafraîchissement principal). Batches de 3, token partagé, ré-auth sur 401.
async function fetchAllCcSkills(force){
  if(_ccSkills.running)return _ccSkills.data;
  if(!force && _ccSkills.at && (Date.now()-_ccSkills.at)<6*3600*1000 && Object.keys(_ccSkills.data).length)return _ccSkills.data;
  _ccSkills.running=true;
  try{
    const dir=await fetchAgentDirectory();
    // Managers/superviseurs exclus des données → inutile de dépenser du quota pour leurs compétences.
    const ids=Object.keys(dir||{}).filter(id=>dir[id]&&dir[id].role!=="superviseur");
    if(!ids.length){ _ccSkills.running=false; return _ccSkills.data; }
    const tokenRef={t:await getToken()};
    if(!tokenRef.t){ _ccSkills.running=false; return _ccSkills.data; }
    const out={};
    const isOn=s=>{ if(s==null)return false; if(typeof s.status!=='undefined')return s.status===1||s.status===true||s.status==='1'; if(typeof s.active!=='undefined')return !!s.active; if(typeof s.enabled!=='undefined')return !!s.enabled; return true; };
    const nameOf=s=>(s&&(s.name||s.skill||s.code||s.label))||'';
    for(let i=0;i<ids.length;i+=3){
      const batch=ids.slice(i,i+3);
      await Promise.all(batch.map(async id=>{
        // try/catch PAR AGENT : apiReq rejette sur erreur socket — sans ceci, une seule coupure
        // réseau faisait rejeter tout le Promise.all et perdait le cycle complet.
        try{
          const r=await _ccCall("POST","/cc/agent/"+id+"/flow/voice/skills/list",{},tokenRef);
          let flow=null;
          if(Array.isArray(r))flow=r;
          else if(r&&typeof r==='object')flow=r.flowSkills||r.profileSkills||r.skills||r.data||r.flow||null;
          if(!Array.isArray(flow))return; // 401/erreur → on garde l'ancienne valeur pour cet agent
          const norm=flow.map(s=>({id:(s&&s.id)||null,name:nameOf(s),score:(s&&s.score)!=null?s.score:100,active:isOn(s)})).filter(s=>s.name);
          out[id]={all:norm, at:Date.now()};
        }catch(e){ /* agent en échec = ignoré ce tour-ci, ancien cache conservé */ }
      }));
      await new Promise(r=>setTimeout(r,250)); // respiration rate-limit
    }
    // Fusion : ne pas effacer un agent déjà connu si son fetch a échoué ce tour-ci.
    const merged=Object.assign({},_ccSkills.data);
    Object.keys(out).forEach(id=>{ merged[id]=out[id]; });
    if(Object.keys(out).length){ _ccSkills.data=merged; _ccSkills.at=Date.now(); ccSkillsSave(); console.log("[cc-skills] "+Object.keys(out).length+"/"+ids.length+" agents rafraîchis"); }
  }catch(e){ console.error("[cc-skills] "+e.message); }
  _ccSkills.running=false;
  return _ccSkills.data;
}
// Préchauffage au démarrage + rafraîchissement toutes les 6 h (best-effort, non bloquant).
setTimeout(()=>fetchAllCcSkills(true).catch(()=>{}),20000);
setInterval(()=>fetchAllCcSkills(false).catch(()=>{}),6*3600*1000);

async function fetchAgentsDay(date,hDeb,hFin,dateFin){
  // Bornes en minutes (précision réelle de la sélection : "08:30" ne doit pas devenir "08:00")
  const _hm=s=>{const p=String(s||'').split(':');return (parseInt(p[0])||0)*60+(parseInt(p[1])||0);};
  const minDeb=_hm(hDeb||'08:00'), minFin=_hm(hFin||'20:00');
  // Bornes heures pleines pour la grille de slots 30 min
  hDeb=Math.floor(minDeb/60);hFin=minFin%60>0?Math.floor(minFin/60)+1:Math.floor(minFin/60);
  const token=await getToken();if(!token)throw new Error("Pas de token");
  // Réchauffer le cache compétences (/agent/list) — mis en cache pour la journée, donc un seul
  // appel réseau par jour. Garantit que chaque agent du payload porte ses compétences déclarées
  // sans dépendre des droits /cc/*. Best-effort : ne bloque jamais le chargement principal.
  try{await fetchAgentSkills();}catch(_e){/* le payload retombe sur skills:[] */}
  // Construire la liste des jours de la plage [date .. dateFin] (incluse)
  const _d0=new Date(date+"T00:00:00"); const _d1=new Date((dateFin||date)+"T00:00:00");
  const jours=[]; for(let d=new Date(_d0); d<=_d1; d.setDate(d.getDate()+1)){jours.push(d.toISOString().slice(0,10)); if(jours.length>62)break;}
  // Pour 1 jour : IN + OUT en parallèle (2× plus rapide)
  // Pour plusieurs jours : séquentiel entre jours (rate-limit INO), mais IN+OUT parallèles
  let riH=[], roH=[];
  let joursActifs=0;
  // Jours pour lesquels la récupération INO a échoué (timeout/5xx/réseau) — à ne JAMAIS confondre
  // avec un jour réellement sans appel : on les remonte explicitement au dashboard (mode honnête).
  const joursEchec=[];
  // Marqueur d'échec distinct de {} pour ne pas traiter une requête en erreur comme "0 historique"
  const ECHEC=Symbol("echec");
  const onEchec=e=>({[ECHEC]:(e&&e.message)||String(e)});
  for(const jr of jours){
    const avant=riH.length+roH.length;
    let echecJour=null;
    try{
      // Appel principal (limit 2000)
      const [ri1,ro1]=await Promise.all([
        apiReq("POST","/call/in/histories",{startDate:jr+" 00:00:00",endDate:jr+" 23:59:59",limit:2000},token).catch(onEchec),
        apiReq("POST","/call/out/histories",{startDate:jr+" 00:00:00",endDate:jr+" 23:59:59",limit:2000},token).catch(onEchec)
      ]);
      if(ri1&&ri1[ECHEC])echecJour=ri1[ECHEC];
      if(ro1&&ro1[ECHEC])echecJour=echecJour||ro1[ECHEC];
      // Timeout INO : apiReq résout avec {_timeout:true,histories:[]} — à traiter comme un échec
      // sinon le jour passe pour "0 appel" (mode honnête : signaler, jamais masquer)
      if(ri1&&ri1._timeout)echecJour=echecJour||"timeout INO (in)";
      if(ro1&&ro1._timeout)echecJour=echecJour||"timeout INO (out)";
      if(ri1&&ri1.histories)riH=riH.concat(ri1.histories);
      if(ro1&&ro1.histories)roH=roH.concat(ro1.histories);
      // Pagination : si on a atteint la limite, découper par demi-journée et compléter
      if((ri1&&ri1.histories&&ri1.histories.length===2000)||(ro1&&ro1.histories&&ro1.histories.length===2000)){
        console.warn("[PAGINATION] "+jr+" — limite 2000 atteinte, découpage demi-journée");
        // Supprimer les données du jour déjà ajoutées et reprendre par tranches de 6h
        riH=riH.slice(0,riH.length-(ri1&&ri1.histories?ri1.histories.length:0));
        roH=roH.slice(0,roH.length-(ro1&&ro1.histories?ro1.histories.length:0));
        const tranches=[
          {s:jr+" 00:00:00",e:jr+" 05:59:59"},
          {s:jr+" 06:00:00",e:jr+" 11:59:59"},
          {s:jr+" 12:00:00",e:jr+" 17:59:59"},
          {s:jr+" 18:00:00",e:jr+" 23:59:59"},
        ];
        for(const t of tranches){
          await new Promise(r=>setTimeout(r,200)); // petit délai entre tranches
          const [rip,rop]=await Promise.all([
            apiReq("POST","/call/in/histories",{startDate:t.s,endDate:t.e,limit:2000},token).catch(onEchec),
            apiReq("POST","/call/out/histories",{startDate:t.s,endDate:t.e,limit:2000},token).catch(onEchec)
          ]);
          if(rip&&rip[ECHEC])echecJour=rip[ECHEC];
          if(rop&&rop[ECHEC])echecJour=echecJour||rop[ECHEC];
          if(rip&&rip._timeout)echecJour=echecJour||"timeout INO (in, tranche)";
          if(rop&&rop._timeout)echecJour=echecJour||"timeout INO (out, tranche)";
          if(rip&&rip.histories)riH=riH.concat(rip.histories);
          if(rop&&rop.histories)roH=roH.concat(rop.histories);
        }
        console.log("[PAGINATION] "+jr+" — total après découpage: "+riH.length+" IN, "+roH.length+" OUT");
      }
    }catch(e){echecJour=e.message;}
    if(echecJour){
      console.error('[fetchAgentsDay] échec récupération INO pour '+jr+' :',echecJour);
      joursEchec.push(jr);
    }
    if((riH.length+roH.length)>avant)joursActifs++;
    if(jours.length>1)await new Promise(r=>setTimeout(r,500));
  }
  if(joursActifs===0)joursActifs=1;
  const ri={histories:riH}, ro={histories:roH};
  const agents={};
  // Slots horaires (créneaux de 30 min de 08h à 20h) pour le graphique flux par tranche
  const slotsMap={};
  function slotKey(dt){
    if(!dt)return null;
    const d=new Date(dt);if(isNaN(d))return null;
    // Heure France (gère CET/CEST automatiquement, quel que soit le fuseau du serveur — Railway est en UTC)
    const hFr=parisHour(d);
    const m=d.getUTCMinutes()<30?"00":"30";
    return String(hFr).padStart(2,"0")+":"+m;
  }
  // Qualifications agrégées par agent (h.status contient le résultat : KO, Refus, Réitérant, etc.)
  function tagQualif(a,status){
    if(!status)return;
    const s=String(status).toLowerCase();
    if(s.includes("ko")||s.includes("hors svi"))a.ko++;
    if(s.includes("refus"))a.refus++;
    if(s.includes("réitéra")||s.includes("reitera"))a.reiterants++;
    if(s.includes("transfert"))a.transferts++;
    if(s.includes("rdv")||s.includes("intéress")||s.includes("interess"))a.transfo_yes++;
    a.qualifs_total++;
  }
  // Stocker les appels bruts par agent pour calcul ACW
  const agentCalls={};
  // Compteurs globaux de flux ENTRANTS réels (présentés/décrochés/abandonnés) — indépendants des agents
  // car un appel abandonné n'a pas d'agent rattaché et serait sinon ignoré.
  let fluxRecusIn=0, fluxDecroches=0, fluxAbandons=0, fluxSortants=0;
  // Flux par CAMPAGNE (présentés/décrochés/abandonnés/sortants), restreints aux horaires
  // d'ouverture configurés dans les critères de chaque campagne — les appels hors horaires
  // sont comptés à part (horsHoraires) et exclus des stats. Indispensable pour une QS par
  // campagne fiable : les abandons en file n'ont pas d'agent et n'apparaissent que dans les queues.
  const fluxCamps={};
  function proc(h,type){
    // [PLAGE HORAIRE] Ne JAMAIS comptabiliser les appels hors de la plage [hDeb,hFin] sélectionnée.
    // L'heure est convertie en heure France (Railway tourne en UTC).
    const _dtP=h.callDate||h.acdDate;
    if(_dtP){
      const _dP=new Date(_dtP);
      if(!isNaN(_dP)){
        const _mFr=parisMinOfDay(_dP);
        if(_mFr<minDeb||_mFr>=minFin)return; // hors plage (à la minute) → ignoré partout (flux + slots + agents)
      }
    }
    // Comptage GLOBAL des flux réels (avant filtre agent) — un abandon n'a pas d'agent
    const _st=String(h.status||"").toLowerCase();
    const _isAband=_st.includes("aband");
    // Attribution par campagne (via la queue de l'appel) avec exclusion des horaires de fermeture
    {
      const _qn=(h.queue&&h.queue.queueName)||"";
      const _camp=detectCampaignSrv(_qn)||"Autre";
      if(!fluxCamps[_camp])fluxCamps[_camp]={presentes:0,decroches:0,abandons:0,sortants:0,sortantsAboutis:0,horsHoraires:0};
      const _fc=fluxCamps[_camp];
      const _dObj=_dtP?new Date(_dtP):null;
      const _open=(_dObj&&!isNaN(_dObj))?isCampOpenAt(_camp,_dObj):true;
      if(!_open){_fc.horsHoraires++;}
      else if(type==="in"){
        _fc.presentes++;
        if(_isAband)_fc.abandons++;
        else if(h.agent&&h.agent.id)_fc.decroches++;
      }else{
        _fc.sortants++;
        if(((h.call&&h.call.agentDuration)||0)>0)_fc.sortantsAboutis++;
      }
    }
    if(type==="in"){
      fluxRecusIn++;                         // tout appel entrant présenté
      if(_isAband)fluxAbandons++;            // présenté mais non décroché
      else if(h.agent&&h.agent.id)fluxDecroches++; // décroché par un agent
      // Abandon SANS agent : alimenter le slot ici car le code ci-dessous (réservé aux appels avec agent) ne le verra pas
      if(_isAband&&(!h.agent||!h.agent.id)){
        const _sk=slotKey(h.callDate||h.acdDate);
        if(_sk){if(!slotsMap[_sk])slotsMap[_sk]={lbl:_sk,vol:0,out:0,aband:0,queues:{}};slotsMap[_sk].aband++;}
      }
    }else{fluxSortants++;}
    if(!h.agent||!h.agent.id||!h.agent.firstname)return;
    const k=h.agent.id;
    if(!agents[k])agents[k]={id:k,nom:h.agent.firstname+" "+h.agent.lastname,username:h.agent.username,appelsIn:0,appelsOut:0,duree:0,dureeIn:0,premiereAction:h.callDate||h.acdDate,derniereAction:h.callDate||h.acdDate,queues:new Set(),ko:0,refus:0,reiterants:0,transferts:0,transfo_yes:0,qualifs_total:0,nonDecroches:0,presentes:0,spark:Array(12).fill(0),sparkH:Array(24).fill(0),daySpan:{}};
    if(type==="in"){
      // Présenté = tout entrant routé à l'agent. Décroché = présenté pris (durée>0, non abandonné).
      agents[k].presentes++;
      const agDur=(h.call&&h.call.agentDuration)||0;
      const _ab=(h.status&&String(h.status).toLowerCase().includes('abandon'));
      if(agDur>0&&!_ab){agents[k].appelsIn++;agents[k].dureeIn+=agDur;}  // décroché — durée IN isolée pour le DMT
      else{agents[k].nonDecroches++;}              // présenté non décroché
    }else agents[k].appelsOut++;
    const agDur2=(h.call&&h.call.agentDuration)||0;
    agents[k].duree+=agDur2;
    const dt=h.callDate||h.acdDate;
    if(dt<agents[k].premiereAction)agents[k].premiereAction=dt;
    if(dt>agents[k].derniereAction)agents[k].derniereAction=dt;
    // Présence par jour : amplitude (1ère→dernière action) calculée JOUR PAR JOUR puis sommée,
    // pour que le taux d'occupation reste correct sur une plage multi-jours (sinon la présence
    // = écart entre le 1er appel du lundi et le dernier du dimanche = ~7 jours, ce qui écrase tout).
    if(dt){const _dd=new Date(dt);const _dk=parisDateStr(_dd);const _ts=_dd.getTime();const _sp=agents[k].daySpan[_dk];if(!_sp)agents[k].daySpan[_dk]={min:_ts,max:_ts};else{if(_ts<_sp.min)_sp.min=_ts;if(_ts>_sp.max)_sp.max=_ts;}}
    if(h.queue&&h.queue.queueName){
      const _qn=h.queue.queueName;
      agents[k].queues.add(_qn);
      // Stats par file pour affichage mutualisation côté dashboard
      if(!agents[k].perQueue)agents[k].perQueue={};
      if(!agents[k].perQueue[_qn])agents[k].perQueue[_qn]={decroches:0,sortants:0,dureeIn:0,dureeOut:0,presentes:0};
      if(type==="in"){
        agents[k].perQueue[_qn].presentes++;
        const _agD=(h.call&&h.call.agentDuration)||0;
        const _abQ=!!(h.status&&String(h.status).toLowerCase().includes('abandon'));
        if(_agD>0&&!_abQ){agents[k].perQueue[_qn].decroches++;agents[k].perQueue[_qn].dureeIn+=_agD;}
      }else{agents[k].perQueue[_qn].sortants++;const _agDOut=(h.call&&h.call.agentDuration)||0;if(_agDOut>0)agents[k].perQueue[_qn].dureeOut+=_agDOut;}
    }
    tagQualif(agents[k],h.status);
    if(dt){const _d=new Date(dt);const _ph=parisHour(_d);const idx=_ph-8;if(idx>=0&&idx<12)agents[k].spark[idx]++;if(_ph>=0&&_ph<24)agents[k].sparkH[_ph]++;}
    const sk=slotKey(dt);
    if(sk){
      if(!slotsMap[sk])slotsMap[sk]={lbl:sk,vol:0,out:0,aband:0,queues:{}};
      // Classification identique aux compteurs flux : entrant décroché → vol, abandon → aband, sortant → out
      if(type==="in"){
        if(_isAband){slotsMap[sk].aband++;}else{slotsMap[sk].vol++;}
      }else{slotsMap[sk].out++;}
      // Stocker le volume par queue pour filtrage côté client
      const qn=h.queue&&h.queue.queueName?h.queue.queueName:"";
      if(qn){slotsMap[sk].queues[qn]=(slotsMap[sk].queues[qn]||0)+1;}
    }
    // Stocker pour calcul ACW
    if(!agentCalls[k])agentCalls[k]=[];
    if(agDur2>0&&dt)agentCalls[k].push({start:new Date(dt).getTime(),dur:agDur2*1000});
  }
  (ri&&ri.histories?ri.histories:[]).forEach(h=>proc(h,"in"));
  (ro&&ro.histories?ro.histories:[]).forEach(h=>proc(h,"out"));
  // Calcul ACW moyen par agent (trou entre fin d'un appel et début du suivant)
  Object.keys(agentCalls).forEach(k=>{
    const calls=agentCalls[k].sort((a,b)=>a.start-b.start);
    const gaps=[];
    for(let i=1;i<calls.length;i++){
      const gap=(calls[i].start-(calls[i-1].start+calls[i-1].dur))/1000;
      if(gap>0&&gap<3600)gaps.push(gap); // exclure les gaps > 1h (pauses)
    }
    if(gaps.length>0)agents[k].acwMoyen=Math.round(gaps.reduce((s,v)=>s+v,0)/gaps.length);
  });
  // Slots ordonnés hDeb → hFin-1 (tranches de 30 min)
  // Sur une plage multi-jours : moyenne PAR JOUR par tranche (profil journalier représentatif),
  // sinon le cumul de N jours écrase l'échelle et ne "colle" pas à la lecture.
  const nbJours=joursActifs;
  const slots=[];
  for(let h=hDeb;h<hFin;h++){
    for(const m of["00","30"]){
      const k=String(h).padStart(2,"0")+":"+m;
      const sm=slotsMap[k];
      if(sm&&nbJours>1){
        slots.push({lbl:k,vol:Math.round(sm.vol/nbJours),out:Math.round(sm.out/nbJours),aband:Math.round(sm.aband/nbJours),queues:sm.queues||{}});
      }else{
        slots.push(sm||{lbl:k,vol:0,out:0,aband:0});
      }
    }
  }
  // Utiliser le cache compétences s'il existe — sans déclencher d'appel réseau bloquant
  // Le rechargement des compétences se fait via le bouton dédié (↺ Compétences)
  const agentSkillsMap=Object.keys(skillsCache).length>0?skillsCache:{};
  // ── Agents CONNECTÉS aujourd'hui mais SANS activité d'appel (invisibles autrement) ──
  // Un agent en poste qui n'a encore passé/reçu aucun appel n'est pas dans les historiques.
  // Pour la supervision (suivre qui est connecté), on l'injecte depuis l'annuaire (lastLogin=today).
  // Uniquement en vue du JOUR courant (le « connecté » n'a pas de sens sur une date passée).
  // Annuaire chargé dans tous les cas : sert aussi à écarter les managers des stats (voir filtre plus bas).
  let _dir=null;
  try{ _dir=await fetchAgentDirectory(); }catch(e){ console.error("[dir] "+e.message); }
  try{
    const _todayStr=parisDateStr();
    if(date===_todayStr && (!dateFin||dateFin===date)){
      const dir=_dir||{};
      // Fenêtre « connecté RÉCEMMENT » : lastLogin dans les 48h. L'API INO ne donne que la dernière
      // connexion (pas la présence temps réel) ; un agent à session persistante garde un lastLogin
      // de la veille → « aujourd'hui » strict le ratait. 48h capte hier soir sans afficher les
      // logins de plusieurs jours (choix Tarik : élargir « connecté récemment »).
      const _RECENT_MS=48*3600*1000;
      const _nowMs=Date.now();
      Object.keys(dir).forEach(function(id){
        const ag=dir[id];
        if(!ag||agents[id]||!ag.lastLogin)return;
        if(ag.role==="superviseur")return; // managers hors données (choix Tarik : stats = agents seuls)
        const _llMs=new Date(ag.lastLogin).getTime();
        if(!(_llMs>0) || (_nowMs-_llMs)>_RECENT_MS)return; // connexion de plus de 48h → ignoré
        const _sameDay=parisDateStr(new Date(ag.lastLogin))===_todayStr;
        agents[id]={id:String(id),nom:ag.nom,username:ag.username,appelsIn:0,appelsOut:0,duree:0,dureeIn:0,
          premiereAction:ag.lastLogin,derniereAction:null,queues:new Set(),ko:0,refus:0,reiterants:0,transferts:0,
          transfo_yes:0,qualifs_total:0,nonDecroches:0,presentes:0,spark:Array(12).fill(0),sparkH:Array(24).fill(0),
          daySpan:{},_connecteSansActivite:true,_loginRecent:!_sameDay};
      });
    }
  }catch(e){ console.error("[connectés] "+e.message); }
  const now=Date.now();
  // MANAGERS EXCLUS des données : la Surveillance INO compte des « conseillers », pas les profils
  // Superviseur-RA (BELAIDI, DAHMANI...). Ils restent dans l'annuaire (résolution des noms) mais
  // ne sont ni injectés comme connectés, ni comptés dans les stats/KPI agents.
  const _isManager=id=>!!(_dir&&_dir[String(id)]&&_dir[String(id)].role==="superviseur");
  const list=Object.values(agents).filter(a=>!_isManager(a.id)).map(a=>{
    // Statut estimé depuis la dernière activité
    let statutEstime="Inconnu";
    if(a._connecteSansActivite){statutEstime="Connecté";} // en poste, pas encore d'appel
    else if(a.derniereAction){
      const lastMs=new Date(a.derniereAction).getTime();
      const elapsedMin=(now-lastMs)/60000;
      if(elapsedMin<5)statutEstime="Traitement";
      else if(elapsedMin<15)statutEstime="Post-appel";
      else if(elapsedMin<120)statutEstime="Actif";
      else statutEstime="Déconnecté";
    }
    const sk=agentSkillsMap[a.id]||{};
    // Compétences /cc/* pré-chargées par le job de fond (cache persistant) → matrice toujours peuplée.
    // On y trouve l'état configuré + actif (status) de chaque compétence. Repli sur les compétences
    // déclarées (/agent/list) si le cache /cc n'a pas encore cet agent.
    const _cc=_ccSkills.data[String(a.id)];
    const _ccAll=(_cc&&Array.isArray(_cc.all))?_cc.all:null;
    return {
      id:a.id,nom:a.nom,username:a.username,statutEstime,lastCallDate:a.derniereAction,
      appelsIn:a.appelsIn,appelsPresentes:a.presentes||(a.appelsIn+(a.nonDecroches||0)),nonDecroches:a.nonDecroches||0,appelsOut:a.appelsOut,total:a.appelsIn+a.appelsOut,
      // DMT = durée moyenne des ENTRANTS décrochés uniquement (a.duree cumule IN+OUT,
      // la diviser par appelsIn gonflait le DMT de tout agent faisant du sortant)
      duree:a.duree,dmt:a.appelsIn>0?Math.round((a.dureeIn||0)/a.appelsIn):0,
      // Présence cumulée = somme des amplitudes journalières (sec). Sur 1 jour = écart 1er→dernier
      // appel ; sur N jours = somme jour par jour (jamais l'écart global lundi→dimanche).
      presenceSec:Math.round(Object.values(a.daySpan||{}).reduce((s,sp)=>s+(sp.max-sp.min)/1000,0)),
      premiereAction:a.premiereAction,derniereAction:a.derniereAction,
      queues:Array.from(a.queues).join(", "),perQueue:a.perQueue||{},
      ko:a.nonDecroches,koQualif:a.ko,refus:a.refus,reiterants:a.reiterants,transferts:a.transferts,
      transfo:a.qualifs_total>0?Math.round((a.transfo_yes/a.qualifs_total)*100):null,
      spark:a.spark,sparkH:a.sparkH,
      // Compétences : cache /cc/* (configuré + actif) en priorité — chargé en fond, matrice jamais
      // vide. Repli sur les compétences déclarées /agent/list (toutes marquées actives faute d'état).
      skills:_ccAll?_ccAll.filter(s=>s.active).map(s=>s.name):(Array.isArray(sk.skills)?sk.skills.slice():[]),
      allSkills:_ccAll?_ccAll.slice():(Array.isArray(sk.skills)?sk.skills.map(n=>({id:null,name:n,score:100,active:true})):[]),
      skillsFromCc:!!_ccAll,
      acwMoyen:a.acwMoyen||null,
      connecteSansActivite:a._connecteSansActivite||false
    };
  }).sort((a,b)=>b.total-a.total);

  return {agents:list,slots,total:list.length,date,dateFin:(dateFin||date),nbJours:jours.length,joursActifs,joursEchec,
    flux:{recus:fluxDecroches+fluxAbandons,recusBrut:fluxRecusIn,decroches:fluxDecroches,abandons:fluxAbandons,sortants:fluxSortants},
    fluxCampagnes:fluxCamps};
}

// ════════════════════════════════════════════════════════════════════════════
//  MODULE CHECK DES HEURES — contrôle des heures réelles (INO + Evo) vs saisie paie
//  Par agent PAR JOUR : 1ère connexion, dernière déco, amplitude (≈ présence),
//  temps de communication (prod), nb d'appels INO + Evo. Écart vs Total H prod paie.
//  ⚠️ INO n'a AUCUN historique de session (19 endpoints sondés → 404) : les heures INO
//  sont APPROCHÉES par l'amplitude 1er→dernier appel. Evo a les vraies sessions (R_SESS).
// ════════════════════════════════════════════════════════════════════════════
// Cache heures dans DATA_DIR (volume persistant si monté) — __dirname est effacé à chaque
// redéploiement Railway. Migration : on relit l'ancien emplacement si le nouveau est vide.
const HOURS_DIR=path.join(DATA_DIR,"hours_history");
const _HOURS_DIR_OLD=path.join(__dirname,"hours_history");
try{
  fs.mkdirSync(HOURS_DIR,{recursive:true});
  if(fs.existsSync(_HOURS_DIR_OLD)){
    for(const f of fs.readdirSync(_HOURS_DIR_OLD)){
      const dst=path.join(HOURS_DIR,f);
      if(!fs.existsSync(dst))fs.copyFileSync(path.join(_HOURS_DIR_OLD,f),dst);
    }
  }
}catch(e){}
function hoursSaveDay(d,rec){try{if(/^\d{4}-\d{2}-\d{2}$/.test(d))fs.writeFileSync(path.join(HOURS_DIR,d+".json"),JSON.stringify(rec));}catch(e){}}
function hoursLoadDay(d){try{const p=path.join(HOURS_DIR,d+".json");if(fs.existsSync(p))return JSON.parse(fs.readFileSync(p,"utf8"));}catch(e){}return null;}
// Plafond dur des heures de présence/session par agent et par jour (règle Tarik : 9 h max).
// Au-delà = artefact (session laissée ouverte, oubli de déconnexion) — jamais crédité en production.
const HOURS_CAP_SEC=9*3600;
// Nom normalisé pour rapprocher paie ↔ INO ↔ Evo (ordre & accents ignorés) : set de tokens triés.
function _normName(s){return String(s||"").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^A-Z0-9 ]/g," ").split(/\s+/).filter(w=>w.length>1).sort().join(" ");}
// Tokens utiles d'un nom : retire le bruit des logins Evo (« Fazna Wisecom_Leadgen » → FAZNA).
function _nameToks(norm){return new Set(String(norm).split(" ").filter(t=>t&&!/^(WISECOM|LEADGEN|AGENT\d*|TT)$/.test(t)));}
// Résolveur paie TOLÉRANT : égalité exacte, sinon INCLUSION de tokens (l'un contient l'autre),
// à condition d'être NON AMBIGU (2 candidats → aucun match, sécurité homonymes).
// Corrige : « Amy Diop » (INO) vs « DIOP Amy Kolle » (paie), « Naelle Dias » vs « DIAS MACHADO Naëlle »,
// « Theo » (login Evo) vs « BOUDET Théo » — l'égalité stricte ratait tout ça (48 fausses orphelines).
function _paieResolver(pDay){
  const entries=Object.keys(pDay).map(k=>({k,set:_nameToks(k)}));
  return function(agNorm){
    if(pDay[agNorm])return {key:agNorm,rec:pDay[agNorm]};
    const ag=_nameToks(agNorm); if(!ag.size)return null;
    const cands=entries.filter(t=>{
      if(!t.set.size)return false;
      let agInT=true; ag.forEach(x=>{if(!t.set.has(x))agInT=false;});
      if(agInT)return true;
      let tInAg=true; t.set.forEach(x=>{if(!ag.has(x))tInAg=false;});
      return tInAg;
    });
    return cands.length===1?{key:cands[0].k,rec:pDay[cands[0].k]}:null;
  };
}
// Heures Evo d'un agent (nomNormalisé→{nom,connSec,cu}) pour une journée, depuis l'historique Evo.
// ⚠️ Structure RÉELLE (vérifiée evo_history/2026-07-08.json) : sessions = {idAgente, firstBegin,
// lastEnd (ms), online} SANS nom — la jointure se fait par idAgente via rawSqlAgentCamps
// (agentNom + cuPos). L'ancienne version cherchait s.agentNom/ini/fin → Evo toujours à 0.
function evoHoursByName(d){
  const out={};
  let src=(_evoCache&&_evoCache.dataDate===d)?_evoCache:evoLoadHist(d);
  if(!src)return out;
  // idAgente → nom + CU (cuPos = mesurable, cf. mémoire "source CU") depuis les stats par campagne
  const nameById={}, cuById={};
  (Array.isArray(src.rawSqlAgentCamps)?src.rawSqlAgentCamps:[]).forEach(r=>{
    const id=String(r.idAgente||""); if(!id)return;
    if(r.agentNom&&!nameById[id])nameById[id]=r.agentNom;
    cuById[id]=(cuById[id]||0)+(Number(r.cuPos)||0);
  });
  // Borne haute d'une session encore OUVERTE (online sans lastEnd). Bug corrigé : elle était
  // bornée à Date.now() → sur un jour passé, +9 jours = « 219h ». Nouveau cap, du plus fiable
  // au plus large : (1) jour courant → maintenant ; (2) jour passé → la dernière DÉCONNEXION
  // réelle des autres sessions du jour (quand l'équipe s'est déloguée) ; (3) repli firstBegin+11h.
  // Garde-fou dur : jamais > 24h.
  const _isToday=(parisDateStr()===d);
  const _sess=Array.isArray(src.sessions)?src.sessions:[];
  let _maxClosedEnd=0;
  _sess.forEach(s=>{ const e=Number(s.lastEnd)||0, b=Number(s.firstBegin)||0; if(e>b && !s.online)_maxClosedEnd=Math.max(_maxClosedEnd,e); });
  _sess.forEach(s=>{
    const id=String(s.idAgente||""); const nom=nameById[id]||"";
    const key=_normName(nom); if(!key)return;
    const b=Number(s.firstBegin)||0;
    let e=Number(s.lastEnd)||0;
    const open=!!s.online&&(!e||e<b);
    if(open)e=_isToday?Date.now():(_maxClosedEnd>b?_maxClosedEnd:b+11*3600*1000);
    if(b&&e>b+24*3600*1000)e=b+24*3600*1000; // garde-fou : une session ne peut dépasser 24h
    if(!out[key])out[key]={nom,connSec:0,cu:0,cnxMs:0,decoMs:0,online:false};
    if(b&&e>b){
      out[key].connSec+=Math.round((e-b)/1000);
      // Cnx/déco RÉELLES : 1ère connexion / dernière déconnexion des sessions Evo du jour.
      out[key].cnxMs=out[key].cnxMs?Math.min(out[key].cnxMs,b):b;
      if(open&&_isToday)out[key].online=true; else out[key].decoMs=Math.max(out[key].decoMs,e);
    }
  });
  // Plafond 9h/jour (règle Tarik : durée de shift max) sur le cumul de session Evo par agent.
  Object.values(out).forEach(o=>{ if(o.connSec>HOURS_CAP_SEC)o.connSec=HOURS_CAP_SEC; });
  Object.entries(cuById).forEach(([id,cu])=>{
    const key=_normName(nameById[id]||""); if(!key||!cu)return;
    if(!out[key])out[key]={nom:nameById[id],connSec:0,cu:0};
    out[key].cu+=cu;
  });
  return out;
}
// Calcule (ou recharge du cache) le relevé d'heures d'une journée : {date, at, agents:{id:{...}}}.
const HOURS_TODAY_TTL_MS=10*60*1000; // le jour courant n'est refetché qu'au-delà de 10 min (quota INO)
const _hoursInflight={}; // date → Promise (verrou anti-double-fetch : 2 requêtes simultanées = 1 seul fetch INO)
async function computeHoursDay(d,force){
  const today=parisDateStr();
  const cached=hoursLoadDay(d);
  if(cached && !force){
    if(d!==today){
      // Jour passé : immuable SEULEMENT si le relevé a été pris APRÈS la fin de la journée
      // (finalized). Un jour consulté à 15h puis plus jamais resterait sinon figé à 15h.
      const _snapDay=cached.at?parisDateStr(new Date(cached.at)):null;
      if(cached.finalized||( _snapDay&&_snapDay>d))return Object.assign({},cached,{finalized:true});
      // sinon : snapshot intrajournalier d'un jour révolu → un recalcul unique le finalise.
    }else if(cached.at && (Date.now()-cached.at)<HOURS_TODAY_TTL_MS)return cached;
  }
  if(_hoursInflight[d])return _hoursInflight[d]; // fetch déjà en cours pour cette date
  const _p=(async()=>{
  const token=await getToken();
  // Pas de token = journée INCONNUE, pas une journée à zéro : echec:true, jamais mise en cache.
  if(!token)return cached||{date:d,at:Date.now(),agents:{},echec:true,noToken:true};
  const tranches=[["00:00:00","07:59:59"],["08:00:00","11:59:59"],["12:00:00","15:59:59"],["16:00:00","23:59:59"]];
  let inH=[],outH=[],echec=false;
  for(const[s,e]of tranches){
    const [ri,ro]=await Promise.all([
      apiReq("POST","/call/in/histories",{startDate:d+" "+s,endDate:d+" "+e,limit:2000},token).catch(()=>null),
      apiReq("POST","/call/out/histories",{startDate:d+" "+s,endDate:d+" "+e,limit:2000},token).catch(()=>null)
    ]);
    // Un timeout ({_timeout:true}), une réponse non-JSON ou une tranche saturée (2000 = il y en a
    // sûrement plus) = journée PARTIELLE → echec, jamais cachée comme un vrai zéro.
    if(ri&&Array.isArray(ri.histories)&&!ri._timeout){ inH=inH.concat(ri.histories); if(ri.histories.length>=2000)echec=true; } else echec=true;
    if(ro&&Array.isArray(ro.histories)&&!ro._timeout){ outH=outH.concat(ro.histories); if(ro.histories.length>=2000)echec=true; } else echec=true;
  }
  const ags={};
  const add=(h,dir)=>{
    const a=h.agent; if(!a||a.id==null)return;
    const id=String(a.id);
    const t=Date.parse(h.acdDate||h.callDate||0)||0;
    const dur=(h.call&&h.call.agentDuration)||0;
    if(!ags[id])ags[id]={id,nom:((a.firstname||"")+" "+(a.lastname||"")).trim(),firstMs:0,lastMs:0,commSec:0,nIn:0,nOut:0};
    const A=ags[id];
    if(t){A.firstMs=A.firstMs?Math.min(A.firstMs,t):t;A.lastMs=Math.max(A.lastMs,t+dur*1000);}
    A.commSec+=dur; if(dir==="in")A.nIn++; else A.nOut++;
  };
  inH.forEach(h=>add(h,"in")); outH.forEach(h=>add(h,"out"));
  // Annuaire : inclure 100% des agents (hors managers), même sans activité INO ce jour-là.
  // Le groupe (Agents RA / B2B / Voltalis) est propagé pour permettre un filtre par pôle.
  let dir={}; try{dir=await fetchAgentDirectory();}catch(e){}
  Object.keys(dir).forEach(id=>{
    const dd=dir[id]; if(!dd||dd.role==="superviseur")return;
    if(!ags[id])ags[id]={id,nom:dd.nom,firstMs:0,lastMs:0,commSec:0,nIn:0,nOut:0,noActivite:true};
    else if(dd.nom)ags[id].nom=dd.nom;
    ags[id].grp=dd.group||null;
    // lastLogin INO = heure de CONNEXION réelle, mais uniquement exploitable pour LE JOUR de ce
    // login (elle est écrasée à chaque reconnexion). On ne la retient que si elle tombe le jour `d`.
    const _ll=dd.lastLogin?Date.parse(dd.lastLogin):0;
    if(_ll&&parisDateStr(new Date(_ll))===d)ags[id].loginMs=_ll;
  });
  Object.values(ags).forEach(A=>{
    A.ampliSec=(A.firstMs&&A.lastMs&&A.lastMs>A.firstMs)?Math.round((A.lastMs-A.firstMs)/1000):0;
    // Connexion INO : login réel s'il existe pour ce jour, sinon 1er appel (approché).
    // Déconnexion INO : dernier appel (approché — INO n'a pas de logout). cnxSrc : L=login, I=appel.
    A.cnxIno=A.loginMs?Math.min(A.loginMs,A.firstMs||A.loginMs):(A.firstMs||0);
    A.cnxInoSrc=A.loginMs?"L":(A.firstMs?"I":null);
    A.decoIno=A.lastMs||0;
  });
  // NB : la partie Evo (connSec/CU) n'est PAS figée ici — elle est ré-attachée à chaque
  // agrégation /api/hours depuis l'historique Evo local (0 quota INO, re-backfillable).
  const _finalized=(d!==today)&&!echec;
  const rec={date:d,at:Date.now(),echec,finalized:_finalized,agents:ags};
  if(!echec)hoursSaveDay(d,rec); // ne jamais cacher une journée partielle/en échec
  return rec;
  })();
  _hoursInflight[d]=_p;
  try{ return await _p; } finally { delete _hoursInflight[d]; }
}
// Liste des jours [d1..d2] inclus (borne 200 j = ~6,5 mois). Reste en composantes LOCALES
// (jamais toISOString, qui décale d'un jour selon le fuseau du serveur : Railway=UTC vs poste=CEST).
function _daysRange(d1,d2){
  const out=[]; const p=s=>String(s).split("-").map(Number);
  const [y1,m1,dd1]=p(d1),[y2,m2,dd2]=p(d2);
  const b=new Date(y2,m2-1,dd2);
  for(let d=new Date(y1,m1-1,dd1); d<=b; d.setDate(d.getDate()+1)){
    out.push(d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0"));
    if(out.length>200)break;
  }
  return out;
}
// ── Parsing export paie ──
function _pnorm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/\s+/g," ").trim();}
function _fmtLocal(d){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function _toISODate(v){
  if(v==null||v==="")return null;
  // Numéro de série Excel (raw:true) — SANS ambiguïté, converti sans fuseau (époque 1899-12-30).
  if(typeof v==="number"&&v>10000&&v<100000){const d=new Date(Math.round((v-25569)*86400000));return d.getUTCFullYear()+"-"+String(d.getUTCMonth()+1).padStart(2,"0")+"-"+String(d.getUTCDate()).padStart(2,"0");}
  if(v instanceof Date&&!isNaN(v))return _fmtLocal(v);
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if(m)return m[1]+"-"+String(m[2]).padStart(2,"0")+"-"+String(m[3]).padStart(2,"0");
  m=s.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/); if(m)return m[3]+"-"+String(m[2]).padStart(2,"0")+"-"+String(m[1]).padStart(2,"0"); // DD/MM/YYYY
  const t=Date.parse(s); if(!isNaN(t))return _fmtLocal(new Date(t));
  return null;
}
function _hnum(v){ if(v==null||v==="")return 0; const n=parseFloat(String(v).replace(",",".").replace(/[^0-9.\-]/g,"")); return isNaN(n)?0:n; }
// Valeur HEURES d'une cellule paie — gère les 3 formats rencontrés :
//   décimal ("7", "7,5"), horaire ("7h30" / "07:30" → 7,5 — _hnum seul donnerait 730 !),
//   fraction de jour Excel (cellule formatée heure lue en raw:true : 7:30 → 0.3125 → ×24).
function _hnumHours(v){
  if(v==null||v==="")return 0;
  if(typeof v==="number"){ if(v>0&&v<1)return Math.round(v*24*100)/100; return v; }
  const s=String(v).trim();
  const m=s.match(/^(\d{1,2})\s*[h:]\s*(\d{1,2})\s*$/i);
  if(m)return (parseInt(m[1],10)||0)+((parseInt(m[2],10)||0)/60);
  const n=_hnum(s);
  return (n>0&&n<1)?Math.round(n*24*100)/100:n;
}
// Depuis des objets {header:valeur} (sheet_to_json). Repère les colonnes par nom (accents/casse ignorés).
function _parsePayrollRows(objs){
  if(!Array.isArray(objs)||!objs.length)return [];
  const keys=Object.keys(objs[0]);
  const find=(...cands)=>{ for(const k of keys){ const kn=_pnorm(k); for(const c of cands){ if(kn===_pnorm(c))return k; } } for(const k of keys){ const kn=_pnorm(k); for(const c of cands){ if(kn.includes(_pnorm(c)))return k; } } return null; };
  const kNom=find("nom prenom","nom","agent"), kDate=find("date"),
        kTot=find("total general prod","total prod","total h prod","total prod h"),
        kPlage=find("duree plage","plage"), kAbs=find("absence"), kMotif=find("motif absence","motif");
  return objs.map(o=>({
    nom:kNom?o[kNom]:null,
    date:_toISODate(kDate?o[kDate]:null),
    // _hnumHours : décimal, "7h30"/"07:30" et fraction-de-jour Excel. Garde-fou >24h/jour → 0
    // (ligne aberrante plutôt qu'un écart délirant).
    totalProd:(v=>v>24?0:v)(_hnumHours(kTot?o[kTot]:0)),
    plage:kPlage?(_hnumHours(o[kPlage])||o[kPlage]||null):null,
    absence:(kAbs&&_hnum(o[kAbs])>0)?true:null,
    motif:kMotif?(o[kMotif]||null):null
  })).filter(r=>r.nom&&r.date);
}
// CSV (séparateur ; ou ,) → mêmes objets.
function _parsePayrollCsv(text){
  const lines=String(text||"").split(/\r?\n/).filter(l=>l.trim().length);
  if(lines.length<2)return [];
  const sep=(lines[0].split(";").length>=lines[0].split(",").length)?";":",";
  const split=l=>{const out=[];let cur="",q=false;for(let i=0;i<l.length;i++){const c=l[i];if(c==='"'){if(q&&l[i+1]==='"'){cur+='"';i++;}else q=!q;}else if(c===sep&&!q){out.push(cur);cur="";}else cur+=c;}out.push(cur);return out;};
  const hdr=split(lines[0]);
  const objs=lines.slice(1).map(l=>{const c=split(l);const o={};hdr.forEach((h,i)=>o[h]=c[i]);return o;});
  return _parsePayrollRows(objs);
}

function makeAdmin(login){
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Administration — Wisecom Control Room</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#f3f3f3;color:#161616;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;min-height:100vh;}
.topbar{background:#fff;border-bottom:1px solid #dedede;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:14px;letter-spacing:.08em;}
.dot{width:9px;height:9px;border-radius:50%;background:#E8006E;box-shadow:0 0 12px #E8006E;}
.nav{display:flex;gap:10px;align-items:center;}
.nav a{color:#777;text-decoration:none;font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid #dedede;transition:all .15s;}
.nav a:hover,.nav a.active{color:#E8006E;border-color:#E8006E55;}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px;}
.section{background:#fff;border:1px solid #dedede;border-radius:12px;padding:22px;margin-bottom:18px;}
.section-title{font-size:13px;font-weight:700;color:#E8006E;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid #dedede;display:flex;align-items:center;gap:8px;}
.field{margin-bottom:14px;}
.field label{display:block;font-size:10px;color:#777;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}
.field input{width:100%;background:#fafafa;color:#161616;border:1px solid #dedede;border-radius:7px;padding:9px 12px;font-size:12px;outline:none;transition:border .15s;}
.field input:focus{border-color:#E8006E55;}
.row{display:flex;gap:10px;}
.row .field{flex:1;}
.btn{border:none;border-radius:7px;padding:9px 18px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;}
.btn-pink{background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;}
.btn-pink:hover{box-shadow:0 4px 12px rgba(232,0,110,.4);}
.btn-danger{background:#fff5f5;color:#dc2626;border:1px solid #ffd0d0;}
.btn-danger:hover{background:#ffe0e0;}
.btn-ghost{background:#fafafa;color:#777;border:1px solid #dedede;}
.users-table{width:100%;border-collapse:collapse;}
.users-table th{text-align:left;font-size:10px;color:#999;font-weight:600;text-transform:uppercase;padding:7px 10px;border-bottom:1px solid #dedede;}
.users-table td{padding:10px;border-bottom:1px solid #efefef;font-size:12px;}
.badge-role{font-size:9px;padding:2px 8px;border-radius:10px;font-weight:700;}
.badge-admin{background:#ffe0ef;color:#E8006E;border:1px solid #E8006E44;}
.badge-user{background:#efefef;color:#777;border:1px solid #dedede;}
.alert{padding:10px 14px;border-radius:7px;font-size:12px;margin-bottom:12px;display:none;}
.alert-ok{background:#f0fff5;border:1px solid #bfead0;color:#1a8f44;}
.alert-err{background:#fff5f5;border:1px solid #ffd0d0;color:#dc2626;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:0;}
.stat-card{background:#fafafa;border:1px solid #dedede;border-radius:9px;padding:14px;}
.stat-label{font-size:9px;color:#999;text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:6px;}
.stat-value{font-size:22px;font-weight:800;color:#E8006E;}
.stat-sub{font-size:10px;color:#999;margin-top:3px;}
</style></head>
<body>
<div class="topbar">
  <div class="logo"><div class="dot"></div>CONTROL ROOM <span style="color:#999;font-weight:400;font-size:11px">/ Administration</span></div>
  <div class="nav">
    <span style="font-size:11px;color:#999">Connecté : <b style="color:#E8006E">${login}</b></span>
    <a href="/notice">📖 Notice d'utilisation</a>
    <a href="/">← Dashboard</a>
    <a href="/logout" style="color:#dc2626;border-color:#ffd0d0">Déconnexion</a>
  </div>
</div>
<div class="wrap">
  <div id="stats-section" class="section">
    <div class="section-title">📊 Statistiques système</div>
    <div class="stat-grid" id="stat-grid"><div style="color:#999;font-size:11px">Chargement…</div></div>
  </div>
  <div class="section">
    <div class="section-title">👥 Gestion des utilisateurs</div>
    <div id="alert-box" class="alert"></div>
    <div class="row">
      <div class="field"><label>Identifiant (login)</label><input type="text" id="new-login" placeholder="ex : sophie.martin" autocomplete="off"></div>
      <div class="field"><label>Mot de passe</label><input type="password" id="new-pwd" placeholder="Min. 6 caractères" autocomplete="off"></div>
    </div>
    <div style="display:flex;gap:8px;margin-bottom:20px;">
      <button class="btn btn-pink" onclick="addUser()">+ Créer l'utilisateur</button>
    </div>
    <table class="users-table" id="users-table">
      <thead><tr><th>#</th><th>Login</th><th>Rôle</th><th>Actions</th></tr></thead>
      <tbody id="users-tbody"><tr><td colspan="4" style="color:#999;padding:14px 10px;font-size:11px">Chargement…</td></tr></tbody>
    </table>
  </div>
  <div class="section">
    <div class="section-title">🔑 Réinitialiser un mot de passe</div>
    <div class="row">
      <div class="field"><label>Login existant</label><input type="text" id="reset-login" placeholder="Login à réinitialiser" autocomplete="off"></div>
      <div class="field"><label>Nouveau mot de passe</label><input type="password" id="reset-pwd" placeholder="Nouveau mot de passe" autocomplete="off"></div>
    </div>
    <button class="btn btn-pink" onclick="resetPwd()">Réinitialiser</button>
  </div>
  <div class="section">
    <div class="section-title">📞 Files INO &amp; mapping campagnes</div>
    <div style="font-size:11px;color:#777;margin-bottom:14px;line-height:1.6">
      Recense toutes les files d'attente vues dans les historiques INO des 7 derniers jours
      et les confronte au mapping campagnes du dashboard (queues_config.js).
      Les files <b style="color:#dc2626">non mappées</b> tombent dans le bucket «&nbsp;Autre&nbsp;» :
      leurs appels ne sont comptés dans aucune campagne et faussent les QS.
    </div>
    <button class="btn btn-pink" onclick="loadQueues()">Analyser les files INO (≈ 30 s)</button>
    <div id="queues-box" style="margin-top:14px"></div>
  </div>
  <div class="section">
    <div class="section-title">⏰ Calibrer les horaires d'ouverture</div>
    <div style="font-size:11px;color:#777;margin-bottom:14px;line-height:1.6">
      Applique les horaires officiels (source : onglet <b>Horaire</b> du fichier INO du 10/06/2026)
      dans la base de données partagée. À relancer après chaque redéploiement Railway si le volume
      persistant n'est pas monté. Les appels <b>hors horaires d'ouverture</b> sont exclus des QS et flux.
    </div>
    <div id="hours-alert" class="alert"></div>
    <button class="btn btn-pink" onclick="applyHours()">Appliquer les horaires calibrés (${Object.keys(CAMP_HOURS_DEFAULT).length} campagnes)</button>
  </div>
  <div class="section">
    <div class="section-title">🔐 Code de sécurité 2FA</div>
    <div id="code-alert-box" class="alert"></div>
    <div style="font-size:11px;color:#777;margin-bottom:14px;line-height:1.6">Le code à 6 chiffres demandé après la connexion. Modification réservée aux administrateurs. Prend effet immédiatement pour toutes les prochaines connexions.</div>
    <div class="row">
      <div class="field"><label>Code actuel</label><input type="password" id="code-current" placeholder="Code actuel (6 chiffres)" inputmode="numeric" maxlength="6" autocomplete="off"></div>
      <div class="field"><label>Nouveau code</label><input type="password" id="code-new" placeholder="Nouveau code (6 chiffres)" inputmode="numeric" maxlength="6" autocomplete="off"></div>
    </div>
    <button class="btn btn-pink" onclick="changeSecurityCode()">Modifier le code 2FA</button>
  </div>
</div>
<script>
async function loadStats(){
  try{
    const r=await fetch('/api/admin/stats');const d=await r.json();
    const g=document.getElementById('stat-grid');
    g.innerHTML='<div class="stat-card"><div class="stat-label">Sessions actives</div><div class="stat-value">'+(d.sessions||0)+'</div><div class="stat-sub">Sessions ouvertes</div></div>'+
      '<div class="stat-card"><div class="stat-label">INO Connecté</div><div class="stat-value" style="color:'+(d.inoOk?'#1a8f44':'#dc2626')+'">'+(d.inoOk?'✓ OUI':'✕ NON')+'</div><div class="stat-sub">Token bearer</div></div>'+
      '<div class="stat-card"><div class="stat-label">Appels du jour</div><div class="stat-value">'+(d.stats&&d.stats.totalAppels||0)+'</div><div class="stat-sub">Via API INO</div></div>'+
      '<div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value" style="font-size:16px">'+Math.floor(d.uptime/3600)+'h'+Math.floor((d.uptime%3600)/60)+'m</div><div class="stat-sub">Depuis le démarrage</div></div>'+
      '<div class="stat-card"><div class="stat-label">Dernière MAJ</div><div class="stat-value" style="font-size:12px">'+(d.lastEvent?new Date(d.lastEvent).toLocaleTimeString('fr-FR'):'–')+'</div><div class="stat-sub">Webhook INO</div></div>';
  }catch(e){document.getElementById('stat-grid').innerHTML='<div style="color:#dc2626;font-size:11px">Erreur chargement stats</div>';}
}
async function loadUsers(){
  try{
    const r=await fetch('/api/admin/users');const d=await r.json();
    const rows=d.users.map((u,i)=>'<tr>'+
      '<td style="color:#555">'+(i+1)+'</td>'+
      '<td style="font-weight:600">'+u.login+'</td>'+
      '<td><span class="badge-role '+(u.role==='admin'?'badge-admin':'badge-user')+'">'+u.role+'</span></td>'+
      '<td>'+(u.login==='tarik'||u.login==='admin'?'<span style="color:#444;font-size:10px">Compte système</span>':'<button class="btn btn-danger" style="font-size:10px;padding:4px 10px" onclick="deleteUser(\\''+u.login+'\\')">Supprimer</button>')+'</td>'+
    '</tr>').join('');
    document.getElementById('users-tbody').innerHTML=rows||'<tr><td colspan="4" style="color:#555;font-size:11px">Aucun utilisateur</td></tr>';
  }catch(e){}
}
function showAlert(msg,ok){const b=document.getElementById('alert-box');b.textContent=msg;b.className='alert '+(ok?'alert-ok':'alert-err');b.style.display='block';setTimeout(()=>b.style.display='none',4000);}
async function addUser(){
  const login=document.getElementById('new-login').value.trim();
  const pwd=document.getElementById('new-pwd').value;
  if(!login||!pwd){showAlert('Remplis les deux champs.',false);return;}
  const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'add',login,password:pwd})});
  const d=await r.json();
  if(d.ok){showAlert(d.message,true);document.getElementById('new-login').value='';document.getElementById('new-pwd').value='';loadUsers();}
  else showAlert(d.error||'Erreur',false);
}
async function deleteUser(login){
  if(!confirm('Supprimer l\\'utilisateur '+login+' ?'))return;
  const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'delete',login})});
  const d=await r.json();
  if(d.ok){showAlert(d.message,true);loadUsers();}else showAlert(d.error||'Erreur',false);
}
async function changeSecurityCode(){
  const current=document.getElementById('code-current').value.trim();
  const newCode=document.getElementById('code-new').value.trim();
  const box=document.getElementById('code-alert-box');
  if(!/^[0-9]{6}$/.test(newCode)){box.textContent='Le nouveau code doit comporter exactement 6 chiffres';box.className='alert alert-err';box.style.display='block';return;}
  try{
    const r=await fetch('/api/admin/security-code',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({current,newCode})});
    const d=await r.json();
    box.style.display='block';
    if(d.ok){box.textContent='✓ '+d.message;box.className='alert alert-ok';document.getElementById('code-current').value='';document.getElementById('code-new').value='';}
    else{box.textContent='✕ '+(d.error||'Erreur');box.className='alert alert-err';}
    setTimeout(()=>box.style.display='none',5000);
  }catch(e){box.textContent='✕ '+e.message;box.className='alert alert-err';box.style.display='block';}
}
async function resetPwd(){
  const login=document.getElementById('reset-login').value.trim();
  const pwd=document.getElementById('reset-pwd').value;
  if(!login||!pwd){showAlert('Remplis les deux champs.',false);return;}
  const r=await fetch('/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'reset',login,password:pwd})});
  const d=await r.json();
  if(d.ok){showAlert(d.message,true);document.getElementById('reset-login').value='';document.getElementById('reset-pwd').value='';}
  else showAlert(d.error||'Erreur',false);
}
async function applyHours(){
  const box=document.getElementById('hours-alert');
  box.textContent='⏳ Application en cours…';box.className='alert';box.style.display='block';
  try{
    const r=await fetch('/api/admin/apply-hours',{method:'POST'});
    const d=await r.json();
    if(d.ok){box.textContent='✓ '+d.applied+' campagne(s) calibrées avec les horaires officiels';box.className='alert alert-ok';}
    else{box.textContent='✕ '+(d.error||'Erreur');box.className='alert alert-err';}
  }catch(e){box.textContent='✕ '+e.message;box.className='alert alert-err';}
  setTimeout(()=>box.style.display='none',6000);
}
async function loadQueues(){
  const box=document.getElementById('queues-box');
  box.innerHTML='<div style="color:#999;font-size:11px">⏳ Analyse en cours — balayage des historiques INO sur 7 jours, jusqu\\'à 30 s…</div>';
  try{
    const r=await fetch('/api/admin/queues');const d=await r.json();
    if(!d.ok){box.innerHTML='<div style="color:#dc2626;font-size:11px">✕ '+(d.error||'Erreur')+'</div>';return;}
    const badge=function(m){
      if(m==='exact')return '<span class="badge-role badge-user" style="background:#f0fff5;color:#1a8f44;border-color:#bfead0">exact</span>';
      if(m==='heuristique')return '<span class="badge-role badge-user" style="background:#fff8e6;color:#b07800;border-color:#f0dca0">heuristique</span>';
      return '<span class="badge-role badge-user" style="background:#fff5f5;color:#dc2626;border-color:#ffd0d0">non mappée</span>';
    };
    const rows=d.queues.map(function(q){
      return '<tr'+(q.mapping==='non mappée'?' style="background:#fff8f8"':'')+'>'+
        '<td style="font-weight:600">'+q.queue+'</td>'+
        '<td>'+(q.campagne||'<span style="color:#dc2626;font-weight:700">→ Autre</span>')+'</td>'+
        '<td>'+badge(q.mapping)+'</td>'+
        '<td style="text-align:right">'+q.volume.toLocaleString('fr-FR')+'</td>'+
        '<td style="color:#777">'+(q.dernierAppel||'–')+(q.declaree?' · déclarée':'')+'</td>'+
      '</tr>';
    }).join('');
    box.innerHTML='<div style="font-size:11px;color:#777;margin-bottom:10px">'+
        'Période analysée : <b>'+d.periode+'</b> · '+d.total+' files détectées · '+
        '<b style="color:'+(d.nonMappees>0?'#dc2626':'#1a8f44')+'">'+d.nonMappees+' non mappée(s)</b>'+
        (d.sourceDeclaree?' · liste déclarée : '+d.sourceDeclaree:' · liste déclarée INO indisponible (historiques seuls)')+
        (d.cache?' · <span style="color:#999">(cache 10 min)</span>':'')+
      '</div>'+
      '<table class="users-table"><thead><tr><th>File INO</th><th>Campagne</th><th>Mapping</th><th style="text-align:right">Appels 7 j</th><th>Dernier appel</th></tr></thead>'+
      '<tbody>'+rows+'</tbody></table>';
  }catch(e){box.innerHTML='<div style="color:#dc2626;font-size:11px">✕ '+e.message+'</div>';}
}
loadStats();loadUsers();setInterval(loadStats,15000);
</script></body></html>`;
}

function makeLogin(err,rl){return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room — Wisecom</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#080808;font-family:Segoe UI,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at 20% 50%,rgba(232,0,110,.08) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(232,0,110,.05) 0%,transparent 50%)}.wrap{width:420px;padding:20px}.logo{text-align:center;margin-bottom:36px}.logo-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#E8006E;box-shadow:0 0 20px #E8006E;animation:pulse 2s infinite;margin-right:8px;vertical-align:middle}@keyframes pulse{0%,100%{box-shadow:0 0 20px #E8006E}50%{box-shadow:0 0 30px #E8006E,0 0 60px rgba(232,0,110,.5)}}.logo-title{font-size:22px;font-weight:800;letter-spacing:.1em;color:#fff;vertical-align:middle}.logo-sub{font-size:11px;color:#444;margin-top:6px;letter-spacing:.1em;text-transform:uppercase}.card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px;backdrop-filter:blur(20px)}.card-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:6px}.card-sub{font-size:12px;color:#555;margin-bottom:24px}.field{margin-bottom:18px}label{display:block;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}input{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:13px 16px;font-size:14px;outline:0;transition:all .2s}input:focus{border-color:#E8006E;background:rgba(232,0,110,.05);box-shadow:0 0 0 3px rgba(232,0,110,.1)}.btn{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:8px}.btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(232,0,110,.4)}.alert{border-radius:8px;padding:11px 14px;font-size:12px;margin-bottom:18px;display:flex;align-items:center;gap:8px}.alert-err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b}.alert-rl{background:rgba(255,155,0,.1);border:1px solid rgba(255,155,0,.3);color:#ff9b00}.divider{height:1px;background:rgba(255,255,255,.06);margin:18px 0}.footer{text-align:center;font-size:10px;color:#333;margin-top:18px}</style></head><body><div class="wrap"><div class="logo"><span class="logo-dot"></span><span class="logo-title">CONTROL ROOM</span><div class="logo-sub">Perspective Consulting · Supervision temps réel</div></div><div class="card">'+(rl?'<div class="alert alert-rl">⏳ Trop de tentatives. Réessayez dans 15 min.</div>':err?'<div class="alert alert-err">✕ Identifiants incorrects.</div>':'')+'<form method="POST" action="/login"><div class="field"><label>Identifiant</label><input type="text" name="login" placeholder="Votre login" autocomplete="username" required></div><div class="field"><label>Mot de passe</label><input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required></div><button type="submit" class="btn">Se connecter →</button></form><div class="divider"></div><div style="font-size:11px;color:#444;text-align:center">🔒 Connexion chiffrée</div></div><div class="footer">Perspective Consulting © '+new Date().getFullYear()+' · Tous droits réservés</div></div></body></html>';}

function makeCode(err){return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code de sécurité — Wisecom</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#080808;font-family:Segoe UI,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at 50% 50%,rgba(232,0,110,.06) 0%,transparent 60%)}.wrap{width:420px;padding:20px}.logo{text-align:center;margin-bottom:30px}.dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#E8006E;box-shadow:0 0 20px #E8006E;animation:pulse 2s infinite;margin-right:8px;vertical-align:middle}@keyframes pulse{0%,100%{box-shadow:0 0 20px #E8006E}50%{box-shadow:0 0 30px #E8006E}}.title{font-size:18px;font-weight:800;letter-spacing:.1em;color:#fff;vertical-align:middle}.card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px;backdrop-filter:blur(20px);text-align:center}.shield{font-size:40px;margin-bottom:14px}.ct{font-size:15px;font-weight:700;color:#fff;margin-bottom:6px}.cs{font-size:12px;color:#555;margin-bottom:20px;line-height:1.6}.ok{background:rgba(48,209,88,.08);border:1px solid rgba(48,209,88,.2);border-radius:8px;padding:10px;font-size:12px;color:#30d158;margin-bottom:18px}.err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b;border-radius:8px;padding:11px;font-size:12px;margin-bottom:14px}.boxes{display:flex;gap:10px;justify-content:center;margin-bottom:18px}.box{width:52px;height:62px;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;font-size:26px;font-weight:700;text-align:center;outline:0;transition:all .2s}.box:focus{border-color:#E8006E;background:rgba(232,0,110,.05);box-shadow:0 0 0 3px rgba(232,0,110,.1)}.btn{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s}.btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(232,0,110,.4)}.back{margin-top:14px;font-size:11px;color:#444}.back a{color:#E8006E;text-decoration:none}.footer{text-align:center;font-size:10px;color:#333;margin-top:18px}</style></head><body><div class="wrap"><div class="logo"><span class="dot"></span><span class="title">VÉRIFICATION</span></div><div class="card"><div class="shield">🔐</div><div class="ct">Code de sécurité requis</div><div class="cs">Saisissez votre code à 6 chiffres<br>pour accéder au Control Room.</div><div class="ok">✓ Identifiants validés avec succès</div>'+(err?'<div class="err">✕ Code incorrect. Réessayez.</div>':'')+'<form method="POST" action="/verify-code" id="f"><div class="boxes"><input class="box" maxlength="1" inputmode="numeric" id="c0" autofocus><input class="box" maxlength="1" inputmode="numeric" id="c1"><input class="box" maxlength="1" inputmode="numeric" id="c2"><input class="box" maxlength="1" inputmode="numeric" id="c3"><input class="box" maxlength="1" inputmode="numeric" id="c4"><input class="box" maxlength="1" inputmode="numeric" id="c5"></div><input type="hidden" name="code" id="hc"><button type="submit" class="btn">Accéder au Control Room →</button></form><div class="back"><a href="/login">← Retour</a></div></div><div class="footer">Wisecom © '+new Date().getFullYear()+'</div></div><script>const B=[...document.querySelectorAll(".box")];B.forEach((b,i)=>{b.oninput=e=>{b.value=e.target.value.replace(/[^0-9]/g,"");if(b.value&&i<5)B[i+1].focus();upd()};b.onkeydown=e=>{if(e.key==="Backspace"&&!b.value&&i>0)B[i-1].focus()};b.onpaste=e=>{e.preventDefault();const p=(e.clipboardData||window.clipboardData).getData("text").replace(/[^0-9]/g,"");p.split("").forEach((c,j)=>{if(B[i+j])B[i+j].value=c});if(B[Math.min(i+p.length,5)])B[Math.min(i+p.length,5)].focus();upd()}});function upd(){const c=B.map(b=>b.value).join("");document.getElementById("hc").value=c;if(c.length===6)setTimeout(()=>document.getElementById("f").submit(),100)}</script></body></html>';}

function make404(){return'<!DOCTYPE html><html><head><title>404</title><style>body{background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}h1{font-size:80px;color:#E8006E}a{color:#E8006E}</style></head><body><div><h1>404</h1><p style="color:#555;margin:10px 0">Page introuvable.</p><a href="/">← Retour</a></div></body></html>';}

const server=http.createServer(async(req,res)=>{
  secH(res);
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  const cookies=parseCookies(req);
  const session=getSession(cookies.session);
  const url=req.url.split("?")[0];
  const ip=req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown";

  // Routes publiques
  if(url==="/favicon.ico"||url==="/favicon.svg"){res.writeHead(200,{"Content-Type":"image/svg+xml","Cache-Control":"public, max-age=86400"});return res.end(FAVICON_SVG);}
  if(url==="/login"&&req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeLogin(false,false));}
  if(url==="/login"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      if(isRL(ip)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});res.end(makeLogin(true,true));return;}
      const p=new URLSearchParams(body);
      const login=(p.get("login")||"").toLowerCase().trim();
      const pwd=p.get("password")||"";
      if(USERS[login]&&USERS[login]===pwd){
        const pt=createPending(login);
        setCookie(res,"pending",pt,PTTL/1000);
        res.writeHead(302,{Location:"/verify-code"});
        console.log("[AUTH] Login OK: "+login+" ("+ip+")");
      }else{
        recAttempt(ip);
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeLogin(true,false));
        console.log("[AUTH] Echec: "+login+" ("+ip+")");
      }
      res.end();
    });return;
  }
  if(url==="/verify-code"&&req.method==="GET"){const ps=getPending(cookies.pending);if(!ps){res.writeHead(302,{Location:"/login"});return res.end();}res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeCode(false));}
  if(url==="/verify-code"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      const ps=getPending(cookies.pending);
      if(!ps){res.writeHead(302,{Location:"/login"});res.end();return;}
      const p=new URLSearchParams(body);
      const code=(p.get("code")||"").trim();
      if(code===SECURITY_CODE){
        delete pending[cookies.pending];
        setCookie(res,"pending","",0);
        const st=createSession(ps.login);
        setCookie(res,"session",st,null);
        res.writeHead(302,{Location:"/"});
        console.log("[AUTH] OK: "+ps.login+" ("+ip+")");
      }else{
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeCode(true));
        console.log("[AUTH] Code KO: "+ps.login);
      }
      res.end();
    });return;
  }
  if(url==="/logout"){if(cookies.session)delete sessions[cookies.session];if(cookies.pending)delete pending[cookies.pending];setCookie(res,"session","",0);setCookie(res,"pending","",0);res.writeHead(302,{Location:"/login"});return res.end();}
  if(url==="/webhook"&&req.method==="POST"){
    // Authentification : l'expéditeur doit fournir le secret via X-Webhook-Secret ou ?secret=
    const WEBHOOK_SECRET=process.env.WEBHOOK_SECRET||"";
    const providedSecret=req.headers["x-webhook-secret"]||(new URL(req.url,"http://localhost")).searchParams.get("secret")||"";
    if(WEBHOOK_SECRET&&providedSecret!==WEBHOOK_SECRET){res.writeHead(401,{"Content-Type":"application/json"});return res.end(JSON.stringify({error:"Secret webhook invalide"}));}
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const p=JSON.parse(body);lastPayload=p;
        const m="data: "+JSON.stringify(p)+"\n\n";
        sseClients.forEach(c=>{try{c.write(m);}catch(e){}});
        sseClients=sseClients.filter(c=>!c.destroyed);
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:"JSON invalide"}));}
    });return;
  }
  // === ACTIVATION DE COMPÉTENCE VIA INO API ===
  if(url==="/api/activate-skill"&&req.method==="POST"){
    const _s=cookies.session?sessions[cookies.session]:null;
    if(!_s){res.writeHead(401);res.end(JSON.stringify({ok:false,error:"Non authentifié"}));return;}
    let body="";req.on("data",c=>body+=c);
    req.on("end",async()=>{
      try{
        const {agentId,skillId,skillNom,agentNom,score}=JSON.parse(body);
        if(!agentId||!skillId) return (res.writeHead(400),res.end(JSON.stringify({ok:false,error:"agentId et skillId requis"})));
        const token=await getToken();
        if(!token) return (res.writeHead(200),res.end(JSON.stringify({ok:false,error:"Token INO indisponible — connexion INO non établie"})));
        const now=new Date().toISOString().replace("T"," ").slice(0,19);
        const addResp=await apiReq("POST","/cc/agent/"+agentId+"/flow/voice/skill/add",
          {aas:{id:parseInt(skillId),score:score||100,startDate:now,status:1}},token);
        if(addResp&&addResp.aas){
          console.log("[SKILL] Activée: agent="+agentNom+" skill="+skillNom);
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,skill:addResp.aas,message:"Compétence activée"}));
        } else {
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:false,error:"Réponse INO inattendue. Le compte API INO actuel (dasboard_INO) n'a pas les droits /cc/*. Contactez l'administrateur INO pour activer les droits Centre de Contacts.",raw:JSON.stringify(addResp).slice(0,200)}));
        }
      }catch(e){
        console.error("[SKILL] Erreur:",e.message);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false,error:e.message}));
      }
    });return;
  }
  // === ÉTAT DU FLUX VOIX (léger, à la demande) — seulement les agents affichés ===
  // GET /api/ino/flux?ids=258403,257287 → {ok,flux:{258403:true,257287:false}}. ~N appels /cc/agent/:id
  // (N = agents visibles, ~5-15), JAMAIS les 55 → ne concurrence pas /agents-day sur la limite INO.
  // Statut du cache compétences /cc/* (public, léger) — fraîcheur + couverture. Sert au monitoring
  // et à forcer un rafraîchissement (?refresh=1) sans passer par le bouton par-agent.
  // Jauge de quota API INO (public, 0 appel INO) : conso heure/jour, seuil d'arrêt, heure de RAZ.
  if(url==="/api/ino/quota"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify(Object.assign({ok:true},inoQuotaState())));
    return;
  }
  if(url.startsWith("/api/ino/skills-status")){
    const uu=new URL(req.url,"http://localhost");
    if(uu.searchParams.get("refresh")==="1"){ fetchAllCcSkills(true).catch(()=>{}); }
    const data=_ccSkills.data||{};
    const ids=Object.keys(data);
    let totConf=0,totAct=0;
    ids.forEach(id=>{ const all=(data[id]&&data[id].all)||[]; totConf+=all.length; totAct+=all.filter(s=>s.active).length; });
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({ok:true,agents:ids.length,at:_ccSkills.at,ageMin:_ccSkills.at?Math.round((Date.now()-_ccSkills.at)/60000):null,running:_ccSkills.running,totalConfig:totConf,totalActif:totAct}));
    return;
  }
  // ── MODULE CHECK DES HEURES : relevé par agent/jour (INO + Evo) + écart vs saisie paie ──
  if(url.startsWith("/api/hours")&&!url.startsWith("/api/hours/payroll")&&req.method==="GET"){
    const _sh=cookies.session?getSession(cookies.session):null;
    if(!_sh){res.writeHead(401);res.end(JSON.stringify({ok:false,error:"Non authentifié"}));return;}
    const uu=new URL(req.url,"http://localhost");
    let d1=uu.searchParams.get("date")||parisDateStr();
    const d2=uu.searchParams.get("dateFin")||d1;
    (async()=>{
      try{
        // Plafond QUOTA INO : 31 jours max par requête (choix Tarik — ne pas épuiser le quota
        // en remontant sur 5 mois). Si la plage dépasse, on ramène d1 à d2−30 j.
        let jours=_daysRange(d1,d2);
        let capped=false;
        if(jours.length>31){ jours=jours.slice(jours.length-31); d1=jours[0]; capped=true; }
        const payroll=(sharedStore.payroll)||{};
        const byAgent={}; // id → {id,nom,grp,byDay:{},tot:{}}
        const echJours=[];
        const paieOrphelines={}; // date → [noms paie sans agent rapproché]
        for(const d of jours){
          const rec=await computeHoursDay(d);
          const dayEchec=!!(rec&&rec.echec);
          if(dayEchec)echJours.push(d);
          const ags=(rec&&rec.agents)||{};
          const pDay=payroll[d]||{};
          // Evo ré-attaché FRAIS à chaque agrégation (historique local re-backfillable, 0 quota INO)
          // — le cache jour ne fige que la partie INO.
          const evo=evoHoursByName(d);
          const _resolve=_paieResolver(pDay);
          const _paieConsommee=new Set();
          const _evoConsomme=new Set();
          Object.values(ags).forEach(a=>{
            if(!byAgent[a.id])byAgent[a.id]={id:a.id,nom:a.nom,grp:a.grp||null,byDay:{},tot:{ampliSec:0,commSec:0,evoConnSec:0,presSec:0,presPaieSec:0,nIn:0,nOut:0,evoCu:0,paieH:0,joursActifs:0,joursPaie:0,joursEchec:0}};
            const B=byAgent[a.id]; if(a.nom)B.nom=a.nom; if(a.grp)B.grp=a.grp;
            const key=_normName(a.nom);
            const _hit=_resolve(key);
            const pr=_hit?_hit.rec:null; if(_hit)_paieConsommee.add(_hit.key);
            if(evo[key])_evoConsomme.add(key);
            const ev=evo[key]||null;
            const evoConnSec=ev?ev.connSec:0, evoCu=ev?ev.cu:0;
            // Plafond 9h/jour (règle Tarik) sur l'amplitude INO ET la présence retenue.
            const ampliSec=Math.min(HOURS_CAP_SEC,a.ampliSec||0);
            const presSec=Math.min(HOURS_CAP_SEC,Math.max(ampliSec,evoConnSec));
            const actif=(a.nIn||a.nOut||evoCu||a.ampliSec||evoConnSec)?1:0;
            // Fiabilité de la ligne : "echec" (INO partiel), "haute" (2 sources concordantes ou
            // paie ≈ présence), "verif" (anomalie: paie sans présence, gros écart, ampli aberrante),
            // "normale" sinon. Le front l'affiche telle quelle — calculée UNE fois ici.
            let fiab="normale";
            const paieH=pr?(pr.totalProd||0):null;
            // DOUBLE CONTRÔLE (demande Tarik) : actes = appels gérés (in+out) + CU/accords Evo.
            // Payé mais 0 acte (hors absence saisie) = ERREUR forte, pas un simple "à vérifier".
            const actes=(a.nIn||0)+(a.nOut||0)+(evoCu||0);
            const _abs=!!(pr&&pr.absence);
            if(dayEchec)fiab="echec";
            else if(paieH!=null&&paieH>0&&!_abs&&actes===0)fiab="erreur";
            else if(paieH!=null&&paieH>0&&presSec===0)fiab="verif";
            else if(presSec>13*3600)fiab="verif";
            else if(paieH!=null&&Math.abs(paieH-presSec/3600)>2.5)fiab="verif";
            else if((a.ampliSec>0&&evoConnSec>0&&Math.abs(a.ampliSec-evoConnSec)<3600)||(paieH!=null&&Math.abs(paieH-presSec/3600)<=1))fiab="haute";
            // Connexion / déconnexion RETENUES : session Evo réelle prioritaire (src E), sinon login
            // INO du jour (src L, jour courant seulement), sinon 1er/dernier appel INO (src I, approché).
            // Dérivé de a.firstMs/a.lastMs (TOUJOURS dans le cache) → marche aussi pour les jours déjà
            // figés avant l'ajout de cette fonctionnalité.
            const _inoCnx=a.loginMs?Math.min(a.loginMs,a.firstMs||a.loginMs):(a.firstMs||0);
            const _inoCnxSrc=a.loginMs?"L":(a.firstMs?"I":null);
            let cnxMs=0,decoMs=0,cnxSrc=null,online=false;
            if(ev&&ev.cnxMs){ cnxMs=ev.cnxMs; decoMs=ev.online?0:(ev.decoMs||0); cnxSrc="E"; online=!!ev.online;
              if(_inoCnx){ if(_inoCnx<cnxMs)cnxMs=_inoCnx; if((a.lastMs||0)>decoMs&&!online)decoMs=a.lastMs; }
            } else if(_inoCnx){ cnxMs=_inoCnx; decoMs=a.lastMs||0; cnxSrc=_inoCnxSrc; }
            const day={
              firstMs:a.firstMs||0,lastMs:a.lastMs||0,ampliSec,commSec:a.commSec||0,
              cnxMs,decoMs,cnxSrc,online,actes,
              nIn:a.nIn||0,nOut:a.nOut||0,evoConnSec,evoCu,echec:dayEchec,fiab,
              paieH,paiePlage:pr?(pr.plage||null):null,paieAbs:pr?(pr.absence||null):null,paieMotif:pr?(pr.motif||null):null
            };
            B.byDay[d]=day;
            B.tot.ampliSec+=day.ampliSec;B.tot.commSec+=day.commSec;B.tot.evoConnSec+=evoConnSec;
            // Présence totale = Σ des max JOURNALIERS (jamais max des sommes — faux dès qu'un
            // agent alterne jours INO et jours Evo).
            B.tot.presSec+=presSec;
            B.tot.nIn+=day.nIn;B.tot.nOut+=day.nOut;B.tot.evoCu+=evoCu;
            if(day.paieH!=null){
              B.tot.paieH+=day.paieH;B.tot.joursPaie++;
              // Présence sommée UNIQUEMENT sur les jours saisis → écart total à périmètre égal.
              B.tot.presPaieSec+=presSec;
            }
            if(actif)B.tot.joursActifs++;
            if(dayEchec)B.tot.joursEchec++;
          });
          // ── Agents EVO-SEULS (équipe sortante/leadgen, absents de l'annuaire INO) ──
          // Objectif « 100 % des agents » : sans cette boucle, leurs heures Evo existaient mais
          // n'apparaissaient jamais, et leurs lignes paie devenaient de fausses orphelines.
          Object.entries(evo).forEach(([key,ev])=>{
            if(_evoConsomme.has(key))return;
            if(!(ev.connSec||ev.cu))return;
            const pid="evo:"+key;
            if(!byAgent[pid])byAgent[pid]={id:pid,nom:ev.nom,grp:"Evo (sortant)",byDay:{},tot:{ampliSec:0,commSec:0,evoConnSec:0,presSec:0,presPaieSec:0,nIn:0,nOut:0,evoCu:0,paieH:0,joursActifs:0,joursPaie:0,joursEchec:0}};
            const B=byAgent[pid];
            const _hit=_resolve(key);
            const pr=_hit?_hit.rec:null; if(_hit)_paieConsommee.add(_hit.key);
            const paieH=pr?(pr.totalProd||0):null;
            const presSec=ev.connSec||0;
            const actes=ev.cu||0; // agent Evo-seul : actes = CU/accords
            const _abs=!!(pr&&pr.absence);
            let fiab="haute"; // session Evo = mesure réelle
            if(paieH!=null&&paieH>0&&!_abs&&actes===0)fiab="erreur"; // payé, session mais 0 CU/accord
            else if(paieH!=null&&paieH>0&&presSec===0)fiab="verif";
            else if(paieH!=null&&Math.abs(paieH-presSec/3600)>2.5)fiab="verif";
            const day={firstMs:0,lastMs:0,ampliSec:0,commSec:0,cnxMs:ev.cnxMs||0,decoMs:ev.online?0:(ev.decoMs||0),cnxSrc:"E",online:!!ev.online,actes,nIn:0,nOut:0,evoConnSec:presSec,evoCu:ev.cu||0,echec:false,fiab,
              paieH,paiePlage:pr?(pr.plage||null):null,paieAbs:pr?(pr.absence||null):null,paieMotif:pr?(pr.motif||null):null};
            B.byDay[d]=day;
            B.tot.evoConnSec+=presSec;B.tot.presSec+=presSec;B.tot.evoCu+=(ev.cu||0);
            if(paieH!=null){B.tot.paieH+=paieH;B.tot.joursPaie++;B.tot.presPaieSec+=presSec;}
            if(presSec||ev.cu)B.tot.joursActifs++;
          });
          // Lignes paie de ce jour qui n'ont matché AUCUN agent (INO ou Evo) → visibles, pas avalées.
          Object.keys(pDay).forEach(k=>{ if(!_paieConsommee.has(k)){ (paieOrphelines[d]=paieOrphelines[d]||[]).push(pDay[k].nom||k); } });
        }
        const agents=Object.values(byAgent).sort((a,b)=>a.nom.localeCompare(b.nom,'fr'));
        const nbOrph=Object.values(paieOrphelines).reduce((s,l)=>s+l.length,0);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,d1,d2,jours,agents,joursEchec:echJours,capped,paieOrphelines,nbPaieOrphelines:nbOrph,hasPayroll:Object.keys(payroll).length>0,updatedAt:new Date().toISOString()}));
      }catch(e){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:e.message}));}
    })();
    return;
  }
  // Upload d'un export paie (xlsx via SheetJS lazy, ou CSV natif) → écarts. {filename, dataB64}
  if(url==="/api/hours/payroll"&&req.method==="POST"){
    const _sh=cookies.session?getSession(cookies.session):null;
    if(!_sh){res.writeHead(401);res.end(JSON.stringify({ok:false,error:"Non authentifié"}));return;}
    let body="";req.on("data",c=>{body+=c;if(body.length>25e6)req.destroy();});
    req.on("end",()=>{
      try{
        const {filename,dataB64,csv}=JSON.parse(body||"{}");
        let rows=null;
        if(csv&&typeof csv==="string"){ rows=_parsePayrollCsv(csv); }
        else if(dataB64){
          const buf=Buffer.from(dataB64,"base64");
          if(/\.csv$/i.test(filename||"")){ rows=_parsePayrollCsv(buf.toString("utf8")); }
          else{
            let XLSX=null; try{XLSX=require("xlsx");}catch(e){}
            if(!XLSX){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Lecture .xlsx indisponible (module xlsx non installé). Ré-enregistrez l'export en CSV et réessayez."}));}
            const wb=XLSX.read(buf,{type:"buffer"});
            const ws=wb.Sheets[wb.SheetNames[0]];
            // raw:true → les dates sortent en numéro de série Excel (non ambigu), converti par _toISODate.
            rows=_parsePayrollRows(XLSX.utils.sheet_to_json(ws,{defval:null,raw:true}));
          }
        }
        if(!rows){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Aucune donnée exploitable dans le fichier."}));}
        // Agréger d'abord AU SEIN de l'import : deux lignes même agent/même date (plages matin +
        // après-midi, fréquent en paie) se CUMULENT — l'ancien code écrasait, seule la dernière survivait.
        const agg={}; let n=0,dates={};
        rows.forEach(r=>{
          if(!r.date||!r.nom)return; n++; dates[r.date]=1;
          const k=r.date+"|"+_normName(r.nom);
          if(!agg[k])agg[k]={date:r.date,norm:_normName(r.nom),nom:r.nom,totalProd:0,plage:null,absence:null,motif:null};
          agg[k].totalProd+=(r.totalProd||0);
          if(r.plage!=null)agg[k].plage=(Number(agg[k].plage)||0)+(Number(r.plage)||0)||r.plage;
          if(r.absence)agg[k].absence=true;
          if(r.motif)agg[k].motif=agg[k].motif?(agg[k].motif+", "+r.motif):r.motif;
        });
        // Fusion dans le store : payroll[date][normNom] — un ré-import de la même date remplace (anti-doublon).
        const pr=sharedStore.payroll||(sharedStore.payroll={});
        Object.values(agg).forEach(r=>{ if(!pr[r.date])pr[r.date]={}; pr[r.date][r.norm]={nom:r.nom,totalProd:Math.round(r.totalProd*100)/100,plage:r.plage,absence:r.absence,motif:r.motif}; });
        persistStore();
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,lignes:n,agents:Object.keys(agg).length,dates:Object.keys(dates).sort()}));
      }catch(e){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:e.message}));}
    });
    return;
  }
  if(url==="/api/ino/flux"&&req.method==="GET"){
    const _sfg=cookies.session?sessions[cookies.session]:null;
    if(!_sfg){res.writeHead(401);res.end(JSON.stringify({ok:false,error:"Non authentifié"}));return;}
    const uu=new URL(req.url,"http://localhost");
    const ids=(uu.searchParams.get("ids")||"").split(",").map(s=>s.trim()).filter(Boolean).slice(0,60);
    (async()=>{
      try{
        const token=await getToken();
        if(!token){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Token INO indisponible"}));}
        const out={};
        for(let i=0;i<ids.length;i+=8){
          const chunk=ids.slice(i,i+8);
          const dets=await Promise.all(chunk.map(id=>apiReq("GET","/cc/agent/"+id,null,token).then(d=>({id,d})).catch(()=>({id,d:null}))));
          dets.forEach(({id,d})=>{ const fa=d&&d.agent; out[id]=(fa&&(fa.flowVoice===true||fa.flowVoice===false))?fa.flowVoice:null; });
        }
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,flux:out}));
      }catch(e){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:e.message}));}
    })();
    return;
  }
  // === RÉACTIVATION DU FLUX VOIX D'UN AGENT (action réelle INO) ===
  // PUT /cc/agent/:id/flow/voice/activate/true → l'agent redevient joignable en réception voix.
  if(url==="/api/ino/flux/reactivate"&&req.method==="POST"){
    const _sf=cookies.session?sessions[cookies.session]:null;
    if(!_sf){res.writeHead(401);res.end(JSON.stringify({ok:false,error:"Non authentifié"}));return;}
    let body="";req.on("data",c=>body+=c);
    req.on("end",async()=>{
      try{
        const {agentId,flowKind,active}=JSON.parse(body||"{}");
        if(!agentId) return (res.writeHead(400),res.end(JSON.stringify({ok:false,error:"agentId requis"})));
        const fk=flowKind||"voice"; const act=(active===false)?"0":"1"; // INO attend 1/0, PAS true/false
        const token=await getToken();
        if(!token) return (res.writeHead(200),res.end(JSON.stringify({ok:false,error:"Token INO indisponible"})));
        const r=await apiReq("PUT","/cc/agent/"+agentId+"/flow/"+fk+"/activate/"+act,null,token);
        fluxCache.at=0; // invalider le cache pour refléter le nouvel état au prochain refresh
        console.log("[FLUX] agent="+agentId+" "+fk+" activate="+act);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,agentId,flowKind:fk,active:act==="true",resp:r||null}));
      }catch(e){
        console.error("[FLUX] Erreur:",e.message);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false,error:e.message}));
      }
    });return;
  }
  // === LISTE DES SKILLS DISPONIBLES PAR AGENT ===
  // === RAFRAÎCHISSEMENT COMPÉTENCES (route dédiée, déclenchée manuellement) ===
  if(url==="/api/refresh-skills"&&req.method==="POST"){
    const _s3=cookies.session?sessions[cookies.session]:null;
    if(!_s3){res.writeHead(401);res.end(JSON.stringify({error:"Non authentifié"}));return;}
    let body="";req.on("data",c=>body+=c);
    req.on("end",async()=>{
      try{
        const {agentIds}=JSON.parse(body||"{}");
        if(!Array.isArray(agentIds)||agentIds.length===0){
          res.writeHead(400);res.end(JSON.stringify({error:"agentIds[] requis"}));return;
        }
        const token=await getToken();
        if(!token){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"Token INO indisponible"}));return;}
        const results={};
        // Budget global : au-delà, on arrête d'ouvrir de nouveaux lots et on renvoie ce qui
        // a pu être collecté plutôt que de laisser la requête HTTP s'éterniser (un proxy/
        // gateway en amont la tuerait de toute façon, sans réponse exploitable côté client).
        const _t0=Date.now(),_budgetMs=50000;
        // Traiter par batch de 3 avec délai pour respecter le rate-limiting INO
        for(let i=0;i<agentIds.length;i+=3){
          if(Date.now()-_t0>_budgetMs){
            agentIds.slice(i).forEach(id=>{if(!results[id])results[id]={error:"Budget temps dépassé — relancez pour les agents restants"};});
            break;
          }
          const batch=agentIds.slice(i,i+3);
          await Promise.all(batch.map(async(agentId)=>{
            let _tok=token;
            for(let attempt=0;attempt<3;attempt++){
              try{
                const rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},_tok);
                if(rf.status===401){
                  if(attempt===0){
                    // Première tentative : renouveler le token au cas où il serait expiré
                    _tok=await getToken(true);
                    await new Promise(r=>setTimeout(r,500));
                    continue;
                  }
                  // Toujours 401 après renouvellement → problème de droits, pas de token
                  results[agentId]={error:"HTTP 401 — Droits insuffisants pour /cc/* sur ce compte INO"};
                  break;
                }
                // Timeout (status 0, voir apiReqFull) ou erreur serveur/rate-limit transitoire :
                // retenter avec backoff plutôt que d'abandonner immédiatement — INO peut être
                // momentanément surchargé sans que ce soit un problème de droits.
                if(rf.status===0||rf.status===429||rf.status>=500){
                  if(attempt<2){await new Promise(r=>setTimeout(r,1500*(attempt+1)));continue;}
                  results[agentId]={error:(rf.status===0?"Timeout INO (>15s)":"HTTP "+rf.status+" — INO temporairement indisponible")};
                  break;
                }
                const r=rf.body;
                // Log diagnostic (premier agent uniquement) pour repérer la forme de réponse INO
                if(i===0&&batch[0]===agentId){
                  console.log('[SKILLS-DBG] agent='+agentId+' HTTP='+rf.status+' type='+(Array.isArray(r)?'array':typeof r)+' keys='+(r&&typeof r==='object'?Object.keys(r).join(','):'n/a')+' sample='+JSON.stringify(r).slice(0,200));
                }
                // La forme de la réponse varie selon la version/endpoint INO :
                // {flowSkills:[…]} / {profileSkills:[…]} / {skills:[…]} / {data:[…]} ou un tableau direct.
                // On extrait le premier tableau de compétences trouvé.
                let flow=null;
                if(Array.isArray(r))flow=r;
                else if(r&&typeof r==='object'){
                  flow=Array.isArray(r.flowSkills)?r.flowSkills
                      :Array.isArray(r.profileSkills)?r.profileSkills
                      :Array.isArray(r.skills)?r.skills
                      :Array.isArray(r.data)?r.data
                      :Array.isArray(r.flow)?r.flow:null;
                }
                if(Array.isArray(flow)){
                  // Statut actif : selon la version → status===1 / active / enabled. Si aucun indicateur
                  // n'est présent, la compétence est considérée active (principe métier :
                  // 1 agent = N compétences possibles, ne jamais masquer une couverture).
                  const isOn=s=>{
                    if(s==null)return false;
                    if(typeof s.status!=='undefined')return s.status===1||s.status===true||s.status==='1';
                    if(typeof s.active!=='undefined')return !!s.active;
                    if(typeof s.enabled!=='undefined')return !!s.enabled;
                    return true;
                  };
                  const nameOf=s=>(s&&(s.name||s.skill||s.code||s.label))||'';
                  const norm=flow.map(s=>({id:(s&&s.id)||null,name:nameOf(s),score:(s&&s.score)||100,active:isOn(s)})).filter(s=>s.name);
                  results[agentId]={skills:norm.filter(s=>s.active),allSkills:norm};
                  return;
                }
                // Réponse inattendue mais pas d'erreur HTTP — joindre les clés pour diagnostic
                results[agentId]={error:("Réponse INO inattendue (HTTP "+rf.status+") clés="+(r&&typeof r==='object'?Object.keys(r).join(','):String(typeof r))).slice(0,80)};
                return;
              }catch(e){
                if(attempt<2){await new Promise(r=>setTimeout(r,3000*(attempt+1)));continue;}
                results[agentId]={error:String(e.message||e).slice(0,80)};
              }
              break;
            }
          }));
          if(i+3<agentIds.length)await new Promise(r=>setTimeout(r,3000));
        }
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,results,count:Object.keys(results).length}));
      }catch(e){
        res.writeHead(500);res.end(JSON.stringify({error:e.message}));
      }
    });return;
  }
  if(url.startsWith("/api/skill-list/")){
    const _s2=cookies.session?sessions[cookies.session]:null;
    if(!_s2){res.writeHead(401);res.end(JSON.stringify({error:"Non authentifié"}));return;}
    const agentId=url.replace("/api/skill-list/","").split("?")[0];
    try{
      let token=await getToken();
      if(!token){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"Token INO indisponible — vérifiez les credentials INO"}));return;}
      let rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},token);
      if(rf.status===401){
        // Token expiré — renouveler et réessayer une fois
        token=await getToken(true);
        rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},token);
      }
      if(rf.status===401){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"HTTP 401 — Droits insuffisants sur le compte INO dasboard_INO pour /cc/*"}));return;}
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(rf.body||{}));
    }catch(e){
      res.writeHead(500);
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }
  // === MODULE EVO SORTANT (plateforme Evolution/Ekiom, temps réel du jour) ===
  // Le serveur Evolution est sur le réseau interne du client : Railway ne peut pas
  // l'appeler directement. Architecture en push : un script local (planifié sur un
  // poste qui voit Evolution) appelle l'API et POST le résultat brut vers
  // /api/evo/ingest ; cette route sert simplement le dernier envoi reçu, transformé.
  // En dev local (poste ayant un accès direct au réseau Evolution), un appel direct
  // de secours est tenté si aucun envoi récent n'est en cache.
  if(url==="/api/evo/sortant"&&session){
    try{
      let rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,rawSqlAgentCamps,rawSqlDiag,generatedAt;
      // ?date=YYYY-MM-DD → servir l'archive de cette journée si elle existe (jours antérieurs)
      const _qm=(req.url.split("?")[1]||"").match(/(?:^|&)date=(\d{4}-\d{2}-\d{2})/);
      const wantDate=_qm?_qm[1]:null;
      let histSrc=null;
      if(wantDate&&!(_evoCache&&_evoCache.dataDate===wantDate)){
        histSrc=evoLoadHist(wantDate);
      }
      // Cache live CREUX (sans sessions) alors qu'une archive du jour les contient : servir l'archive.
      // Cas vécu : un backfill/envoi ancien avait écrasé le cache → Cnx/Déco/H.conn vides côté agent
      // alors que la donnée poussée du jour était complète. On repart de la source la plus riche.
      if(!histSrc){
        const _cacheSess=_evoCache&&Array.isArray(_evoCache.sessions)&&_evoCache.sessions.length>0;
        if(!_cacheSess){
          const _d=(_evoCache&&_evoCache.dataDate)||parisDateStr();
          const _a=evoLoadHist(_d);
          if(_a&&Array.isArray(_a.sessions)&&_a.sessions.length>0)histSrc=_a;
        }
      }
      const cacheFresh=_evoCache&&(Date.now()-_evoCacheAt)<EVO_STALE_MS;
      // Cache "riche" = contient du SQL (stats/agent×campagne). Un fetch direct des mesurables ne
      // ramène PAS le SQL → dashboard vide (0 CU, 0 session). Mieux vaut servir un cache complet
      // même périmé (staleSec le signale) que des données fraîches mais creuses lors d'une
      // coupure réseau PC↔Evolution. On ne fetch en direct que si aucun cache exploitable.
      const cacheRich=_evoCache&&((Array.isArray(_evoCache.rawSqlStats)&&_evoCache.rawSqlStats.length>0)||(Array.isArray(_evoCache.rawSqlAgentCamps)&&_evoCache.rawSqlAgentCamps.length>0));
      if(histSrc){
        ({rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,rawSqlAgentCamps,rawSqlDiag}=histSrc);generatedAt=new Date(histSrc._at||Date.now()).toISOString();
      }else if(cacheFresh||cacheRich){
        ({rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,rawSqlAgentCamps,rawSqlDiag}=_evoCache);generatedAt=new Date(_evoCacheAt).toISOString();
      }else{
        try{
          [rawCamp,rawAg]=await Promise.all([
            evoGetAuto("/manager/api/v1/measurable/campaigns?format=json"),
            evoGetAuto("/manager/api/v1/measurable/agents?format=json")
          ]);
          generatedAt=new Date().toISOString();
        }catch(directErr){
          if(_evoCache){ // repli sur un cache périmé plutôt que rien — on le signale clairement
            ({rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,rawSqlAgentCamps,rawSqlDiag}=_evoCache);generatedAt=new Date(_evoCacheAt).toISOString();
          }else{
            res.writeHead(200,{"Content-Type":"application/json"});
            return res.end(JSON.stringify({ok:false,error:"En attente du premier envoi depuis le poste local (voir script evo_push). "+directErr.message}));
          }
        }
      }
      const agentCamps=evoProcessAgentCamps(rawSqlAgentCamps||[]);
      // Heures de prod réelles par campagne (somme sessions agents depuis q3)
      const campProdBySqlId=evoAgentCampsToProdByCamp(agentCamps);
      const payload=evoBuildPayload(rawCamp,rawAg,rawEstado,rawSqlStats,rawSqlFiles,campProdBySqlId);
      const staleSec=Math.round((Date.now()-new Date(generatedAt).getTime())/1000);
      const metaSrc=histSrc||_evoCache; // champs annexes cohérents avec la journée servie
      res.writeHead(200,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({ok:true,generatedAt,staleSec,agentCamps,sqlDiag:rawSqlDiag||null,inbound:(metaSrc&&metaSrc.inbound)||null,sessions:(metaSrc&&metaSrc.sessions)||null,dataDate:(metaSrc&&metaSrc.dataDate)||null,...payload}));
    }catch(e){
      console.error("[evo/sortant] Erreur:",e&&e.message||e);
      res.writeHead(200,{"Content-Type":"application/json"});
      // ok:false → le client affiche un message clair (« Evo injoignable ») sans inventer de données
      return res.end(JSON.stringify({ok:false,error:e&&e.message?e.message:String(e)}));
    }
  }
  // Liste des journées archivées côté serveur — le poste local compare à son archive
  // locale et re-pousse ce qui manque (rattrapage après redéploiement Railway).
  if(url==="/api/evo/history-dates"){
    if((req.headers["x-evo-push-secret"]||"")!==EVO_PUSH_SECRET){
      res.writeHead(401,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Secret invalide"}));
    }
    let dates=[];
    try{dates=fs.readdirSync(EVO_HIST_DIR).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f=>f.slice(0,10));}catch(e){}
    res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,dates}));
  }
  // Renvoie le body brut d'une journée archivée (format ingest) → permet au poste local de
  // MIROITER en local toute journée présente serveur mais absente en local (anti-perte au redéploy).
  if(url==="/api/evo/history-raw"){
    if((req.headers["x-evo-push-secret"]||"")!==EVO_PUSH_SECRET){
      res.writeHead(401,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Secret invalide"}));
    }
    const _m=(req.url.split("?")[1]||"").match(/(?:^|&)date=(\d{4}-\d{2}-\d{2})/);
    if(!_m){res.writeHead(400,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"date requise"}));}
    const c=evoLoadHist(_m[1]);
    if(!c){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"absent"}));}
    const body={campaigns:c.rawCamp,agents:c.rawAg,estado:c.rawEstado,sqlStats:c.rawSqlStats,sqlFiles:c.rawSqlFiles,sqlAgentCamps:c.rawSqlAgentCamps,sqlDiag:c.rawSqlDiag,inbound:c.inbound,sessions:c.sessions,dataDate:c.dataDate};
    res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,body}));
  }
  // Réception des données poussées par le script local (Planificateur de tâches).
  // Protégé par un secret partagé (pas par session : appel machine-à-machine).
  if(url==="/api/evo/ingest"&&req.method==="POST"){
    if((req.headers["x-evo-push-secret"]||"")!==EVO_PUSH_SECRET){
      res.writeHead(401,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Secret invalide"}));
    }
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const{campaigns,agents,estado,sqlStats,sqlFiles,sqlAgentCamps,sqlDiag,inbound,sessions,dataDate}=JSON.parse(body);
        if(!campaigns||!agents)throw new Error("Champs 'campaigns'/'agents' manquants");
        // Tous les champs sauf campaigns/agents sont optionnels — compat avec l'ancien script.
        const newCache={rawCamp:campaigns,rawAg:agents,rawEstado:estado||null,rawSqlStats:sqlStats||null,rawSqlFiles:sqlFiles||null,rawSqlAgentCamps:sqlAgentCamps||null,rawSqlDiag:sqlDiag||null,inbound:inbound||null,sessions:sessions||null,dataDate:dataDate||null};
        // ── Garde anti-dégradation ─────────────────────────────────────────────────
        // Un ré-export d'un jour qu'Evolution ne fournit plus (week-end, jour passé) renvoie
        // un payload CREUX (sqlStats/sqlAgentCamps vides). Il ne doit JAMAIS écraser une
        // archive/cache plus riche pour la même journée (sinon « aucune donnée » après coup).
        const _rich=x=>!!x&&((Array.isArray(x.rawSqlStats)&&x.rawSqlStats.length>0)||(Array.isArray(x.rawSqlAgentCamps)&&x.rawSqlAgentCamps.length>0));
        const _incomingRich=(Array.isArray(sqlStats)&&sqlStats.length>0)||(Array.isArray(sqlAgentCamps)&&sqlAgentCamps.length>0);
        const _existing=newCache.dataDate?evoLoadHist(newCache.dataDate):null;
        const _liveSameDate=_evoCache&&_evoCache.dataDate&&newCache.dataDate&&_evoCache.dataDate===newCache.dataDate;
        if(!_incomingRich && (_rich(_existing) || (_liveSameDate && _rich(_evoCache)))){
          console.log("["+new Date().toLocaleTimeString("fr-FR")+"] [evo/ingest] envoi creux ignoré pour "+newCache.dataDate+" (données plus riches conservées)");
          res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,skipped:"hollow",dataDate:newCache.dataDate}));
        }
        evoSaveHist(newCache); // archive de la journée (consultable via ?date=)
        // Ne remplacer le cache LIVE que si l'envoi est du jour courant ou plus récent.
        // ⚠ L'ancienne condition (`!newCache.dataDate||!_evoCache.dataDate`) laissait un envoi SANS
        // dataDate — ou un backfill arrivant sur un cache sans date — ÉCRASER le cache live avec des
        // données anciennes/creuses (sessions & cnx_ms perdus → colonnes Cnx/Déco/H.conn vides).
        // Désormais : un envoi non daté ne remplit QUE si le cache est vide ; sinon il faut une date
        // >= à celle du cache.
        const _canReplace = !_evoCache
          || (!!newCache.dataDate && (!_evoCache.dataDate || newCache.dataDate>=_evoCache.dataDate));
        if(_canReplace){
          _evoCache=newCache;_evoCacheAt=Date.now();evoSaveCache();
        }
        console.log("["+new Date().toLocaleTimeString("fr-FR")+"] [evo/ingest] Données reçues du poste local");
        res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true,receivedAt:new Date(_evoCacheAt).toISOString()}));
      }catch(e){
        res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:e.message}));
      }
    });
    return;
  }
  // === STATUT FILES (agrégation temps réel depuis histories du jour) ===
  if(url==="/api/queues-status"&&session){
    const u2=new URL(req.url,"http://localhost");
    const date=u2.searchParams.get("date")||new Date().toISOString().slice(0,10);
    try{
      const token=await getToken();
      if(!token){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"Token INO indisponible"}));return;}
      const[ci,co]=await Promise.all([
        apiReq("POST","/call/in/histories",{startDate:date+" 00:00:00",endDate:date+" 23:59:59",limit:2000},token),
        apiReq("POST","/call/out/histories",{startDate:date+" 00:00:00",endDate:date+" 23:59:59",limit:2000},token)
      ]);
      let inH=(ci&&ci.histories)||[];
      let outH=(co&&co.histories)||[];
      // Pagination : si la limite est atteinte, redécouper par demi-journée (sinon les stats
      // du jour seraient tronquées et les compteurs par file faux — même garde-fou que fetchAgentsDay)
      if(inH.length===2000||outH.length===2000){
        inH=[];outH=[];
        const tranches=[["00:00:00","05:59:59"],["06:00:00","11:59:59"],["12:00:00","17:59:59"],["18:00:00","23:59:59"]];
        for(const[s,e]of tranches){
          const[rip,rop]=await Promise.all([
            apiReq("POST","/call/in/histories",{startDate:date+" "+s,endDate:date+" "+e,limit:2000},token).catch(()=>null),
            apiReq("POST","/call/out/histories",{startDate:date+" "+s,endDate:date+" "+e,limit:2000},token).catch(()=>null)
          ]);
          if(rip&&rip.histories)inH=inH.concat(rip.histories);
          if(rop&&rop.histories)outH=outH.concat(rop.histories);
        }
      }
      // Agréger par file d'attente
      const qMap={};
      inH.forEach(h=>{
        const qn=(h.queue&&h.queue.queueName)||"–";
        if(!qMap[qn])qMap[qn]={name:qn,recus:0,decroches:0,abandons:0,sortants:0,dureeTotal:0,calls:0};
        const isAband=String(h.status||"").toLowerCase().includes("aband");
        qMap[qn].recus++;
        if(!isAband&&h.agent&&h.agent.id){
          qMap[qn].decroches++;
          const dur=(h.call&&h.call.agentDuration)||0;
          if(dur>0){qMap[qn].dureeTotal+=dur;qMap[qn].calls++;}
        }else{qMap[qn].abandons++;}
      });
      outH.forEach(h=>{
        const qn=(h.queue&&h.queue.queueName)||"–";
        if(!qMap[qn])qMap[qn]={name:qn,recus:0,decroches:0,abandons:0,sortants:0,dureeTotal:0,calls:0};
        qMap[qn].sortants++;
      });
      const queues=Object.values(qMap).map(q=>({
        name:q.name,
        recus:q.recus,
        decroches:q.decroches,
        abandons:q.abandons,
        sortants:q.sortants,
        qs:q.recus>0?Math.round(q.decroches/q.recus*10000)/100:0,
        tauxAbandon:q.recus>0?Math.round(q.abandons/q.recus*10000)/100:0,
        dmc:q.calls>0?Math.round(q.dureeTotal/q.calls):0
      })).sort((a,b)=>b.recus-a.recus);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,queues,updatedAt:new Date().toISOString()}));
    }catch(e){
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:false,queues:[],error:e.message}));
    }
    return;
  }
  // Config publique — CAMPS/QUEUES_MAP enrichis en live depuis INO routing (cache 30 min)
  if(url==="/api/config"){
    fetchLiveQueues().catch(()=>null).then(live=>{
      const cfg=live||{CAMPS,QUEUES_MAP,SKILLS};
      res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"public,max-age=60"});
      res.end(JSON.stringify(cfg));
    });
    return;
  }
  // Health public
  if(url==="/health"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({status:"ok",version:"2.1",sseClients:sseClients.length,inoConnected:!!bToken,lastEvent:lastPayload?lastPayload.horodatage:null,uptime:Math.round(process.uptime()),stats:statsCache}));}
  // API status public
  if(url==="/api/status"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,sseClients:sseClients.length,inoConnected:!!bToken,lastUpdate:lastPayload?lastPayload.horodatage:null,appels:statsCache.totalAppels||0,dmc:Math.round(statsCache.dmc||0)}));}

  // Session requise
  if(!session){res.writeHead(302,{Location:"/login"});return res.end();}

  if(url==="/events"){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"});res.write(": connected\n\n");if(lastPayload)res.write("data: "+JSON.stringify(lastPayload)+"\n\n");sseClients.push(res);req.on("close",()=>{sseClients=sseClients.filter(c=>c!==res);});return;}
  if(url==="/debug/raw-call"){try{const tk=await getToken();const rr=await apiReq("POST","/call/in/histories",{startDate:"2026-05-30 00:00:00",endDate:"2026-05-30 23:59:59",limit:5},tk);const arr=(rr&&rr.histories)||(Array.isArray(rr)?rr:[]);const first=arr[0]||{};const callObj=first.call||{};res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({topKeys:Object.keys(first),callKeys:Object.keys(callObj),sampleCall:callObj,sampleFull:first}));}catch(e){res.writeHead(500,{"Content-Type":"application/json"});return res.end(JSON.stringify({error:String(e&&e.message||e)}));}}
  if(url==="/agents-day"){
    const u=new URL(req.url,"http://localhost");
    const date=u.searchParams.get("date")||new Date().toISOString().slice(0,10);
    const dateFin=u.searchParams.get("dateFin")||date;
    const hDeb=u.searchParams.get("hDeb")||"08:00";
    const hFin=u.searchParams.get("hFin")||"20:00";
    // Renouveler le token avant toute requête sur date passée (le token peut avoir expiré entre refreshes)
    // IMPORTANT : le flux voix N'EST PLUS récupéré ici. Il l'était via fetchAgentFlux (~58 appels
    // INO/refresh) en parallèle → épuisait la limite horaire INO et faisait échouer les historiques
    // (0 agent, transitoire). Le flux est désormais chargé à part, à la demande, seulement pour les
    // agents affichés (route GET /api/ino/flux?ids=...). /agents-day redevient rapide et fiable.
    getToken().then(()=>fetchAgentsDay(date,hDeb,hFin,dateFin)).then(d=>{
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({...d,count:d.agents.length}));
    }).catch(e=>{
      // Retourner un JSON d'erreur exploitable (pas juste 500 vide)
      // Le client peut afficher le message d'erreur à l'utilisateur
      const msg=e&&e.message?e.message:String(e);
      console.error("[agents-day] Erreur ("+date+"):",msg);
      res.writeHead(200,{"Content-Type":"application/json"});
      // Code 200 avec agents:[] pour que le client distingue "aucune donnée" de "échec réseau"
      // On inclut error:true pour que le dashboard puisse afficher une alerte
      res.end(JSON.stringify({agents:[],slots:[],flux:{recus:0,decroches:0,abandons:0,sortants:0},error:msg,date,dateFin}));
    });return;
  }
  // Réglages superviseurs partagés (seuils QS/backlog, ajustements mails/heures, presets...) :
  // un superviseur authentifié peut lire l'état courant et y écrire — ce ne sont pas des
  // réglages sensibles (pas d'admin requis), seulement une persistance commune à fiabiliser.
  if(url==="/api/store"&&req.method==="GET"){
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify(sharedStore));
  }
  if(url==="/api/store"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const{key,value}=JSON.parse(body);
        if(!STORE_KEYS.includes(key)){res.writeHead(400,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Clé inconnue : "+key}));}
        sharedStore[key]=value;
        persistStore();
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true}));
      }catch(e){res.writeHead(400,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"JSON invalide"}));}
    });
    return;
  }
  // Endpoint diagnostic : fluxCampagnes du dernier payload calculé
  if(url==="/api/debug/flux-camps"){
    // Recalcule sur la date du jour pour retourner les données fraîches
    try{
      const _d=_parisDateFmt.format(new Date());
      const tk=await getToken();
      const fresh=await fetchAgentsDay(_d,"08:00","20:00",_d);
      const fc=fresh.fluxCampagnes||{};
      const summary=Object.entries(fc).map(([c,v])=>({camp:c,decroches:v.decroches||0,abandons:v.abandons||0,sortants:v.sortants||0,presentes:v.presentes||0,horsHoraires:v.horsHoraires||0,qs:((v.decroches||0)+(v.abandons||0))>0?Math.round((v.decroches||0)/((v.decroches||0)+(v.abandons||0))*100):null})).sort((a,b)=>(b.decroches+b.abandons)-(a.decroches+a.abandons));
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,date:_d,camps:summary,total:{decroches:fresh.flux.decroches,abandons:fresh.flux.abandons,sortants:fresh.flux.sortants}}));
    }catch(e){res.writeHead(500,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:e.message}));}
    return;
  }
  // Endpoint diagnostic : réponse INO brute pour un agent (accessible à toute session valide)
  if(url.startsWith("/api/skills-debug/")){
    const _agId=url.replace("/api/skills-debug/","").split("?")[0];
    if(!_agId){res.writeHead(400);res.end(JSON.stringify({error:"agentId manquant"}));return;}
    try{
      const token=await getToken();
      if(!token){res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:false,error:"Token indisponible"}));return;}
      const _ep="/cc/agent/"+_agId+"/flow/voice/skills/list";
      const rf=await apiReqFull("POST",_ep,{},token);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,agentId:_agId,endpoint:_ep,httpStatus:rf.status,raw:rf.body}));
    }catch(e){res.writeHead(500);res.end(JSON.stringify({error:e.message}));}
    return;
  }
  // [SÉCURITÉ] Routes admin : exiger le rôle admin (pas seulement une session valide)
  if(url.startsWith("/api/admin/")){
    if(session.login!=="admin"&&session.login!=="tarik"){
      res.writeHead(403,{"Content-Type":"application/json"});
      return res.end(JSON.stringify({error:"Accès réservé aux administrateurs"}));
    }
  }
  if(url==="/api/admin/security-code"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const{current,newCode}=JSON.parse(body);
        if(current!==SECURITY_CODE){res.writeHead(403);return res.end(JSON.stringify({ok:false,error:"Code actuel incorrect"}));}
        if(!newCode||!/^[0-9]{6}$/.test(newCode)){res.writeHead(400);return res.end(JSON.stringify({ok:false,error:"Le nouveau code doit comporter exactement 6 chiffres"}));}
        SECURITY_CODE=newCode;
        console.log("[ADMIN] Code de sécurité 2FA modifié par "+session.login);
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,message:"Code de sécurité mis à jour"}));
      }catch(e){res.writeHead(500);res.end(JSON.stringify({ok:false,error:e.message}));}
    });return;
  }
  if(url==="/api/admin/stats"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({sessions:Object.keys(sessions).length,sseClients:sseClients.length,usersCount:Object.keys(USERS).length,lastEvent:lastPayload?lastPayload.horodatage:null,inoOk:!!bToken&&Date.now()<bExp,stats:statsCache,uptime:process.uptime(),user:session.login}));}
  if(url==="/api/stats"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify(Object.assign({},statsCache,{sseClients:sseClients.length})));}
  // Qualifications réelles par campagne — agrège h.status brut des historiques INO
  if(url.startsWith("/api/qualif-list")){
    (async()=>{
      try{
        const _qs=new URLSearchParams(url.split("?")[1]||"");
        const camp=_qs.get("camp")||"";
        const d1=_qs.get("date")||parisDateStr();
        const d2=_qs.get("dateFin")||d1;
        const token=await getToken();
        if(!token)return res.writeHead(503).end(JSON.stringify({error:"Token INO indisponible"}));
        // Construire la liste des jours
        const _d0=new Date(d1+"T00:00:00"),_d1b=new Date(d2+"T00:00:00");
        const jours=[];for(let d=new Date(_d0);d<=_d1b;d.setDate(d.getDate()+1)){jours.push(d.toISOString().slice(0,10));if(jours.length>31)break;}
        // Files de la campagne (pour filtrer les appels)
        const campQueues=camp?(QUEUES_MAP[camp]||[]).map(q=>q.toLowerCase()):[];
        const counts={};
        let total=0;
        for(const jr of jours){
          let ri;
          try{ri=await apiReq("POST","/call/in/histories",{startDate:jr+" 00:00:00",endDate:jr+" 23:59:59",limit:2000},token);}catch(e){continue;}
          const hist=(ri&&ri.histories)||[];
          for(const h of hist){
            if(!h.status)continue;
            // Filtrer par campagne si spécifiée
            if(camp){
              const qn=String((h.queue&&h.queue.queueName)||"").toLowerCase();
              const matched=campQueues.includes(qn)||detectCampaignSrv(qn)===camp;
              if(!matched)continue;
            }
            const code=String(h.status).trim();
            if(!code)continue;
            counts[code]=(counts[code]||0)+1;
            total++;
          }
        }
        // Trier par volume décroissant
        const qualifs=Object.entries(counts)
          .sort((a,b)=>b[1]-a[1])
          .map(([code,count])=>({code,count}));
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:true,camp:camp||"Toutes",d1,d2,total,qualifs}));
      }catch(e){
        res.writeHead(500,{"Content-Type":"application/json"});
        res.end(JSON.stringify({error:e.message}));
      }
    })();return;
  }
  if(url==="/api/skills"){
    fetchAgentSkills().then(m=>{
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,count:Object.keys(m).length,agents:m}));
    }).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});
    return;
  }
  // Inventaire des files INO : tente les endpoints de liste déclarée, puis balaye les
  // historiques d'appels des 7 derniers jours pour recenser toutes les files actives.
  // Chaque file est confrontée à QUEUES_MAP pour repérer celles qui tombent dans "Autre"
  // (mapping manquant → stats de campagne faussées). Réservé admin, cache 10 min.
  if(url==="/api/admin/queues"){
    (async()=>{
      try{
        if(_queuesCache&&Date.now()-_queuesCacheAt<600000){
          res.writeHead(200,{"Content-Type":"application/json"});
          return res.end(JSON.stringify(Object.assign({cache:true},_queuesCache)));
        }
        const token=await getToken();
        if(!token){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:false,error:"Token INO indisponible"}));}
        // Sources de files "déclarées" dans la config INO. On tente plusieurs endpoints :
        // d'abord le routing voix (= page /maker/app#/flow/voice/routing : la config
        // officielle des files/routages), puis les listes de files classiques en repli.
        // Chaque endpoint peut renvoyer un tableau brut ou un objet paginé {items|data|...}.
        let declared=null,declaredSrc=null;
        const _srcEndpoints=[
          ["GET","/flow/voice/routing?page=1&limit=500",null],
          ["GET","/flow/voice/routing",null],
          ["GET","/cc/flow/voice/routing?page=1&limit=500",null],
          ["POST","/flow/voice/routing/list",{page:1,limit:500}],
          ["GET","/queue/list",null],
          ["GET","/cc/queue/list",null],
          ["GET","/call/queue/list",null],
        ];
        const _extractArr=b=>{
          if(Array.isArray(b))return b;
          if(b&&typeof b==="object"){
            for(const k of ["routings","routing","queues","items","results","data","list","rows","content"]){
              if(Array.isArray(b[k]))return b[k];
            }
            // Wrapper paginé du type {data:{items:[...]}}
            for(const k of ["data","result","payload"]){
              if(b[k]&&typeof b[k]==="object"){const inner=_extractArr(b[k]);if(inner.length)return inner;}
            }
          }
          return [];
        };
        for(const[m,p,bd]of _srcEndpoints){
          try{
            const r=await apiReqFull(m,p,bd,token);
            if(r.status===200){
              const arr=_extractArr(r.body);
              if(arr.length){declared=arr;declaredSrc=m+" "+p;break;}
            }
          }catch(e){}
        }
        const seen={};
        const days=[];for(let i=0;i<7;i++)days.push(new Date(Date.now()-i*86400000).toISOString().slice(0,10));
        for(const jr of days){
          const[ci,co]=await Promise.all([
            apiReq("POST","/call/in/histories",{startDate:jr+" 00:00:00",endDate:jr+" 23:59:59",limit:2000},token).catch(()=>({})),
            apiReq("POST","/call/out/histories",{startDate:jr+" 00:00:00",endDate:jr+" 23:59:59",limit:2000},token).catch(()=>({}))
          ]);
          [...(ci&&ci.histories||[]),...(co&&co.histories||[])].forEach(h=>{
            const q=h.queue&&h.queue.queueName;if(!q)return;
            if(!seen[q])seen[q]={queue:q,volume:0,dernierAppel:null};
            seen[q].volume++;
            if(!seen[q].dernierAppel||jr>seen[q].dernierAppel)seen[q].dernierAppel=jr;
          });
        }
        // Extrait le nom de file d'un objet de config routing (formes variables selon
        // l'endpoint : chaîne brute, {queueName}, {name}, {label}, ou {queue:{queueName}}).
        const _qName=d=>{
          if(typeof d==="string")return d;
          if(!d||typeof d!=="object")return null;
          return d.queueName||d.name||d.label||d.title||d.displayName||
                 (d.queue&&(d.queue.queueName||d.queue.name))||
                 (d.target&&(d.target.queueName||d.target.name))||null;
        };
        (declared||[]).forEach(d=>{
          const q=_qName(d);if(!q)return;
          if(!seen[q])seen[q]={queue:q,volume:0,dernierAppel:null,declaree:true};
          else seen[q].declaree=true;
        });
        const rows=Object.values(seen).map(r=>{
          const exact=CAMPS.find(c=>(QUEUES_MAP[c]||[]).includes(r.queue))||null;
          const camp=exact||detectCampaignSrv(r.queue);
          return Object.assign({},r,{campagne:camp,mapping:exact?"exact":(camp?"heuristique":"non mappée")});
        }).sort((a,b)=>(a.campagne||"zzz").localeCompare(b.campagne||"zzz")||b.volume-a.volume);
        _queuesCache={ok:true,periode:days[6]+" → "+days[0],sourceDeclaree:declaredSrc,total:rows.length,nonMappees:rows.filter(r=>r.mapping==="non mappée").length,queues:rows};
        _queuesCacheAt=Date.now();
        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify(_queuesCache));
      }catch(e){
        res.writeHead(500,{"Content-Type":"application/json"});
        res.end(JSON.stringify({ok:false,error:e.message}));
      }
    })();
    return;
  }
  if(url==="/api/admin/apply-hours"&&req.method==="POST"){
    // Applique CAMP_HOURS_DEFAULT dans sharedStore.criteres pour chaque campagne.
    // Idempotent : peut être relancé après un redéploiement Railway sans risque.
    if(!sharedStore.criteres)sharedStore.criteres={};
    const DEFAULTS={qs_min:80,qs_max:95,backlog_val:0,backlog_min:10,backlog_max:90,alert_no_agent:true,astreinte_display:false,obj_appels:50};
    const changed=[];
    for(const[camp,hrs]of Object.entries(CAMP_HOURS_DEFAULT)){
      if(!sharedStore.criteres[camp])sharedStore.criteres[camp]=Object.assign({},DEFAULTS);
      const cc=sharedStore.criteres[camp];
      if(hrs===null){if(!cc.h24){cc.h24=true;cc.jours={lun:{on:true,o:"00:00",f:"23:59"},mar:{on:true,o:"00:00",f:"23:59"},mer:{on:true,o:"00:00",f:"23:59"},jeu:{on:true,o:"00:00",f:"23:59"},ven:{on:true,o:"00:00",f:"23:59"},sam:{on:true,o:"00:00",f:"23:59"},dim:{on:true,o:"00:00",f:"23:59"}};changed.push(camp+" → H24");}}
      else{cc.h24=false;cc.jours=hrs;changed.push(camp);}
    }
    persistStore();
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,applied:changed.length,campaigns:changed}));
  }
  if(url==="/api/admin/users"&&req.method==="GET"){
    const list=Object.keys(USERS).map(u=>({login:u,role:u==="tarik"||u==="admin"?"admin":"user"}));
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({users:list,count:list.length}));
  }
  if(url==="/api/admin/users"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      try{
        const{login,password,action}=JSON.parse(body);
        if(action==="add"){
          if(!login||!password||login.length<3||password.length<6){
            res.writeHead(400);return res.end(JSON.stringify({error:"Login min 3 chars, mot de passe min 6 chars"}));
          }
          const l=login.toLowerCase().trim();
          if(USERS[l]){res.writeHead(409);return res.end(JSON.stringify({error:"Utilisateur déjà existant"}));}
          USERS[l]=password;
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,message:"Utilisateur "+l+" créé (session courante uniquement — persiste via variable env USERS)"}));
          console.log("[ADMIN] Nouvel utilisateur: "+l);
        } else if(action==="delete"){
          const l=(login||"").toLowerCase().trim();
          if(l==="tarik"||l==="admin"){res.writeHead(403);return res.end(JSON.stringify({error:"Impossible de supprimer les comptes systèmes"}));}
          if(!USERS[l]){res.writeHead(404);return res.end(JSON.stringify({error:"Utilisateur introuvable"}));}
          delete USERS[l];
          // Invalider les sessions de cet utilisateur
          Object.keys(sessions).forEach(t=>{if(sessions[t].login===l)delete sessions[t];});
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,message:"Utilisateur "+l+" supprimé"}));
          console.log("[ADMIN] Suppression: "+l);
        } else if(action==="reset"){
          const l=(login||"").toLowerCase().trim();
          if(!USERS[l]){res.writeHead(404);return res.end(JSON.stringify({error:"Utilisateur introuvable"}));}
          USERS[l]=password;
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,message:"Mot de passe réinitialisé pour "+l}));
        } else {
          res.writeHead(400);res.end(JSON.stringify({error:"Action inconnue"}));
        }
      }catch(e){res.writeHead(400);res.end(JSON.stringify({error:"JSON invalide"}));}
    });return;
  }
  if(url==="/admin"||url.startsWith("/admin/")){
    if(session.login!=="admin"&&session.login!=="tarik"){res.writeHead(403,{"Content-Type":"text/html"});return res.end('<html><body style="background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center"><div><h1 style="color:#E8006E;font-size:60px">403</h1><p style="color:#555">Accès refusé.</p><a href="/" style="color:#E8006E">← Retour</a></div></body></html>');}
    const adminHtml=makeAdmin(session.login);
    res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(adminHtml);
  }
  const _HTML_HDRS={"Content-Type":"text/html;charset=utf-8","Cache-Control":"no-cache, no-store, must-revalidate","Pragma":"no-cache","Expires":"0"};
  if(url==="/theme.js"){const p=path.join(__dirname,"theme.js");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"application/javascript;charset=utf-8","Cache-Control":"no-cache"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/wcr-refresh.js"){const p=path.join(__dirname,"wcr-refresh.js");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"application/javascript;charset=utf-8","Cache-Control":"no-cache"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/control-room-refresh.css"){const p=path.join(__dirname,"control-room-refresh.css");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/css;charset=utf-8","Cache-Control":"no-cache"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/"||url==="/dashboard"){const p=path.join(__dirname,"dashboard.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/agents-jour"){const p=path.join(__dirname,"agents_jour.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/executif"){const p=path.join(__dirname,"executif.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/couverture"){const p=path.join(__dirname,"couverture.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/astreinte"){const p=path.join(__dirname,"astreinte.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/notice"){const p=path.join(__dirname,"notice.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/planning"){const p=path.join(__dirname,"planning.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/pilotage"){const p=path.join(__dirname,"pilotage.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/heures"){const p=path.join(__dirname,"heures.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  if(url==="/design-test"){const p=path.join(__dirname,"design-test.html");if(fs.existsSync(p)){res.writeHead(200,_HTML_HDRS);return fs.createReadStream(p).pipe(res);}}
  res.writeHead(404,{"Content-Type":"text/html"});res.end(make404());
});

fetchDayStats();
setInterval(fetchDayStats,30000);
setInterval(()=>{const now=Date.now();Object.keys(sessions).forEach(k=>{if(now>sessions[k].expires)delete sessions[k];});Object.keys(pending).forEach(k=>{if(now>pending[k].expires)delete pending[k];});},60000);

server.listen(PORT,()=>{
  console.log("==========================================");
  console.log("  Wisecom Control Room v2.1");
  console.log("  Port: "+PORT+" | Users: "+Object.keys(USERS).join(", "));
  console.log("  2FA: actif | Admin: /admin");
  console.log("==========================================");
});
