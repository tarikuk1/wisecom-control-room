const http=require("http"),https=require("https"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000;
const INO_LOGIN=process.env.INO_LOGIN||"tarik_dashboard";
const INO_PWD=process.env.INO_PWD||"XnF!AuuWJg$cR$S";
const INO_APIKEY=process.env.INO_APIKEY||"dasboard_INO";
let SECURITY_CODE=process.env.SECURITY_CODE||"286828";
const USERS_RAW=process.env.USERS||"tarik:Wisecom2026!,admin:ControlRoom2026!";
const USERS=Object.fromEntries(USERS_RAW.split(",").map(u=>{const[l,...r]=u.trim().split(":");return[l.toLowerCase(),r.join(":")];}));

const sessions={},pending={},loginAttempts={};
const TTL=10*60*1000,PTTL=5*60*1000,RATE_W=15*60*1000,RATE_MAX=5; // TTL=10min d\u0027inactivité (glissant)

const tok=()=>crypto.randomBytes(32).toString("hex");
function createSession(login){const t=tok();sessions[t]={login,expires:Date.now()+TTL,createdAt:new Date().toISOString()};return t;}
function createPending(login){const t=tok();pending[t]={login,expires:Date.now()+PTTL};return t;}
function getSession(t){if(!t||!sessions[t])return null;const s=sessions[t];if(Date.now()>s.expires){delete sessions[t];return null;}s.expires=Date.now()+TTL;return s;}
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

// ── Configuration campagnes — source unique : queues_config.js ──────────
const { CAMPS, QUEUES_MAP, SKILLS } = require("./queues_config.js");
// ────────────────────────────────────────────────────────────────────────────
let bToken=null,bExp=0,sseClients=[],lastPayload=null,statsCache={};

const INO_TIMEOUT_MS = 15000; // 15s max par appel INO

function apiReq(method,p,body,token,timeoutMs){
  return new Promise((resolve,reject)=>{
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
    const req=https.request(opts,r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{done(resolve,JSON.parse(buf));}catch{done(resolve,buf);}});});
    req.on("error",e=>{done(reject,e);});
    if(data)req.write(data);req.end();
  });
}
// Version exposant le status HTTP (utilisée pour les routes nécessitant gestion 401)
function apiReqFull(method,p,body,token){
  return new Promise((resolve,reject)=>{
    const auth=token?("Bearer "+token):"Basic "+Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+p,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const req=https.request(opts,r=>{let buf="";const status=r.statusCode;r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve({status,body:JSON.parse(buf)});}catch{resolve({status,body:buf});}});});
    req.on("error",reject);if(data)req.write(data);req.end();
  });
}

async function getToken(force){
  if(!force&&bToken&&Date.now()<bExp)return bToken;
  try{
    const creds=Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const res=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:"wisecom.unicity.io",path:"/api/auth",method:"GET",headers:{"Authorization":"Basic "+creds}},r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve({});}});});
      req.on("error",reject);req.end();
    });
    if(res.access_token){bToken=res.access_token;bExp=Date.now()+270000;console.log("["+new Date().toLocaleTimeString("fr-FR")+"] Token OK (force="+!!force+")");}
  }catch(e){console.error("Auth:",e.message);}
  return bToken;
}

// Récupère les compétences actives par agent depuis INO /agent/list
let skillsCache={};let skillsCacheDate='';
async function fetchAgentSkills(){
  const today=new Date().toISOString().slice(0,10);
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
  const d=new Date().toISOString().slice(0,10);
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

async function fetchAgentsDay(date,hDeb,hFin,dateFin){
  hDeb=parseInt((hDeb||'08:00').split(':')[0]);hFin=parseInt((hFin||'20:00').split(':')[0]);
  const token=await getToken();if(!token)throw new Error("Pas de token");
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
  function proc(h,type){
    // [PLAGE HORAIRE] Ne JAMAIS comptabiliser les appels hors de la plage [hDeb,hFin] sélectionnée.
    // L'heure est convertie en heure France (Railway tourne en UTC).
    const _dtP=h.callDate||h.acdDate;
    if(_dtP){
      const _dP=new Date(_dtP);
      if(!isNaN(_dP)){
        const _hFr=parisHour(_dP);
        if(_hFr<hDeb||_hFr>=hFin)return; // hors plage → ignoré partout (flux + slots + agents)
      }
    }
    // Comptage GLOBAL des flux réels (avant filtre agent) — un abandon n'a pas d'agent
    const _st=String(h.status||"").toLowerCase();
    const _isAband=_st.includes("aband");
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
    if(!agents[k])agents[k]={id:k,nom:h.agent.firstname+" "+h.agent.lastname,username:h.agent.username,appelsIn:0,appelsOut:0,duree:0,premiereAction:h.callDate||h.acdDate,derniereAction:h.callDate||h.acdDate,queues:new Set(),ko:0,refus:0,reiterants:0,transferts:0,transfo_yes:0,qualifs_total:0,nonDecroches:0,presentes:0,spark:Array(12).fill(0)};
    if(type==="in"){
      // Présenté = tout entrant routé à l'agent. Décroché = présenté pris (durée>0, non abandonné).
      agents[k].presentes++;
      const agDur=(h.call&&h.call.agentDuration)||0;
      const _ab=(h.status&&String(h.status).toLowerCase().includes('abandon'));
      if(agDur>0&&!_ab){agents[k].appelsIn++;}     // décroché
      else{agents[k].nonDecroches++;}              // présenté non décroché
    }else agents[k].appelsOut++;
    const agDur2=(h.call&&h.call.agentDuration)||0;
    agents[k].duree+=agDur2;
    const dt=h.callDate||h.acdDate;
    if(dt<agents[k].premiereAction)agents[k].premiereAction=dt;
    if(dt>agents[k].derniereAction)agents[k].derniereAction=dt;
    if(h.queue&&h.queue.queueName)agents[k].queues.add(h.queue.queueName);
    tagQualif(agents[k],h.status);
    if(dt){const _d=new Date(dt);const idx=parisHour(_d)-8;if(idx>=0&&idx<12)agents[k].spark[idx]++;}
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
  const now=Date.now();
  const list=Object.values(agents).map(a=>{
    // Statut estimé depuis la dernière activité
    let statutEstime="Inconnu";
    if(a.derniereAction){
      const lastMs=new Date(a.derniereAction).getTime();
      const elapsedMin=(now-lastMs)/60000;
      if(elapsedMin<5)statutEstime="Traitement";
      else if(elapsedMin<15)statutEstime="Post-appel";
      else if(elapsedMin<120)statutEstime="Actif";
      else statutEstime="Déconnecté";
    }
    const sk=agentSkillsMap[a.id]||{};
    return {
      id:a.id,nom:a.nom,username:a.username,statutEstime,lastCallDate:a.derniereAction,
      appelsIn:a.appelsIn,appelsPresentes:a.presentes||(a.appelsIn+(a.nonDecroches||0)),nonDecroches:a.nonDecroches||0,appelsOut:a.appelsOut,total:a.appelsIn+a.appelsOut,
      duree:a.duree,dmt:a.appelsIn>0?Math.round(a.duree/a.appelsIn):0,
      premiereAction:a.premiereAction,derniereAction:a.derniereAction,
      queues:Array.from(a.queues).join(", "),
      ko:a.nonDecroches,koQualif:a.ko,refus:a.refus,reiterants:a.reiterants,transferts:a.transferts,
      transfo:a.qualifs_total>0?Math.round((a.transfo_yes/a.qualifs_total)*100):null,
      spark:a.spark,
      skills:[],  // enrichi ci-dessous via API INO /cc/agent/:id/flow/voice/skills/list
      allSkills:[],  // toutes les compétences (actives + inactives) pour la matrice
      acwMoyen:a.acwMoyen||null
    };
  }).sort((a,b)=>b.total-a.total);

  return {agents:list,slots,total:list.length,date,dateFin:(dateFin||date),nbJours:jours.length,joursActifs,joursEchec,
    flux:{recus:fluxDecroches+fluxAbandons,recusBrut:fluxRecusIn,decroches:fluxDecroches,abandons:fluxAbandons,sortants:fluxSortants}};
}

function makeAdmin(login){
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Administration — Wisecom Control Room</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;min-height:100vh;}
.topbar{background:#111;border-bottom:1px solid #1e1e1e;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;}
.logo{display:flex;align-items:center;gap:10px;font-weight:800;font-size:14px;letter-spacing:.08em;}
.dot{width:9px;height:9px;border-radius:50%;background:#E8006E;box-shadow:0 0 12px #E8006E;}
.nav{display:flex;gap:10px;align-items:center;}
.nav a{color:#888;text-decoration:none;font-size:12px;padding:5px 12px;border-radius:6px;border:1px solid #1e1e1e;transition:all .15s;}
.nav a:hover,.nav a.active{color:#E8006E;border-color:#E8006E55;}
.wrap{max-width:900px;margin:0 auto;padding:28px 20px;}
.section{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:22px;margin-bottom:18px;}
.section-title{font-size:13px;font-weight:700;color:#E8006E;text-transform:uppercase;letter-spacing:.05em;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;gap:8px;}
.field{margin-bottom:14px;}
.field label{display:block;font-size:10px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}
.field input{width:100%;background:#161616;color:#f0f0f0;border:1px solid #2a2a2a;border-radius:7px;padding:9px 12px;font-size:12px;outline:none;transition:border .15s;}
.field input:focus{border-color:#E8006E55;}
.row{display:flex;gap:10px;}
.row .field{flex:1;}
.btn{border:none;border-radius:7px;padding:9px 18px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s;}
.btn-pink{background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;}
.btn-pink:hover{box-shadow:0 4px 12px rgba(232,0,110,.4);}
.btn-danger{background:#2a0808;color:#ff3b30;border:1px solid #3a1010;}
.btn-danger:hover{background:#3a1010;}
.btn-ghost{background:#1a1a1a;color:#888;border:1px solid #2a2a2a;}
.users-table{width:100%;border-collapse:collapse;}
.users-table th{text-align:left;font-size:10px;color:#555;font-weight:600;text-transform:uppercase;padding:7px 10px;border-bottom:1px solid #1e1e1e;}
.users-table td{padding:10px;border-bottom:1px solid #141414;font-size:12px;}
.badge-role{font-size:9px;padding:2px 8px;border-radius:10px;font-weight:700;}
.badge-admin{background:#1a0810;color:#E8006E;border:1px solid #E8006E44;}
.badge-user{background:#161616;color:#666;border:1px solid #2a2a2a;}
.alert{padding:10px 14px;border-radius:7px;font-size:12px;margin-bottom:12px;display:none;}
.alert-ok{background:rgba(48,209,88,.08);border:1px solid rgba(48,209,88,.25);color:#30d158;}
.alert-err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:0;}
.stat-card{background:#161616;border:1px solid #1e1e1e;border-radius:9px;padding:14px;}
.stat-label{font-size:9px;color:#555;text-transform:uppercase;letter-spacing:.05em;font-weight:600;margin-bottom:6px;}
.stat-value{font-size:22px;font-weight:800;color:#E8006E;}
.stat-sub{font-size:10px;color:#555;margin-top:3px;}
</style></head>
<body>
<div class="topbar">
  <div class="logo"><div class="dot"></div>CONTROL ROOM <span style="color:#555;font-weight:400;font-size:11px">/ Administration</span></div>
  <div class="nav">
    <span style="font-size:11px;color:#555">Connecté : <b style="color:#E8006E">${login}</b></span>
    <a href="/">← Dashboard</a>
    <a href="/logout" style="color:#ff3b30;border-color:#3a1010">Déconnexion</a>
  </div>
</div>
<div class="wrap">
  <div id="stats-section" class="section">
    <div class="section-title">📊 Statistiques système</div>
    <div class="stat-grid" id="stat-grid"><div style="color:#555;font-size:11px">Chargement…</div></div>
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
      <tbody id="users-tbody"><tr><td colspan="4" style="color:#555;padding:14px 10px;font-size:11px">Chargement…</td></tr></tbody>
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
      '<div class="stat-card"><div class="stat-label">INO Connecté</div><div class="stat-value" style="color:'+(d.inoOk?'#30d158':'#ff3b30')+'">'+(d.inoOk?'✓ OUI':'✕ NON')+'</div><div class="stat-sub">Token bearer</div></div>'+
      '<div class="stat-card"><div class="stat-label">Appels du jour</div><div class="stat-value">'+(d.stats&&d.stats.totalAppels||0)+'</div><div class="stat-sub">Via API INO</div></div>'+
      '<div class="stat-card"><div class="stat-label">Uptime</div><div class="stat-value" style="font-size:16px">'+Math.floor(d.uptime/3600)+'h'+Math.floor((d.uptime%3600)/60)+'m</div><div class="stat-sub">Depuis le démarrage</div></div>'+
      '<div class="stat-card"><div class="stat-label">Dernière MAJ</div><div class="stat-value" style="font-size:12px">'+(d.lastEvent?new Date(d.lastEvent).toLocaleTimeString('fr-FR'):'–')+'</div><div class="stat-sub">Webhook INO</div></div>';
  }catch(e){document.getElementById('stat-grid').innerHTML='<div style="color:#ff3b30;font-size:11px">Erreur chargement stats</div>';}
}
async function loadUsers(){
  try{
    const r=await fetch('/api/admin/users');const d=await r.json();
    const rows=d.users.map((u,i)=>'<tr>'+
      '<td style="color:#555">'+(i+1)+'</td>'+
      '<td style="font-weight:600">'+u.login+'</td>'+
      '<td><span class="badge-role '+(u.role==='admin'?'badge-admin':'badge-user')+'">'+u.role+'</span></td>'+
      '<td>'+(u.login==='tarik'||u.login==='admin'?'<span style="color:#444;font-size:10px">Compte système</span>':'<button class="btn btn-danger" style="font-size:10px;padding:4px 10px" onclick="deleteUser(\''+u.login+'\')">Supprimer</button>')+'</td>'+
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
        if(!token) return (res.writeHead(502),res.end(JSON.stringify({ok:false,error:"Token INO indisponible"})));
        const now=new Date().toISOString().replace("T"," ").slice(0,19);
        const addResp=await apiReq("POST","/cc/agent/"+agentId+"/flow/voice/skill/add",
          {aas:{id:parseInt(skillId),score:score||100,startDate:now,status:1}},token);
        if(addResp&&addResp.aas){
          console.log("[SKILL] Activée: agent="+agentNom+" skill="+skillNom);
          res.writeHead(200,{"Content-Type":"application/json"});
          res.end(JSON.stringify({ok:true,skill:addResp.aas,message:"Compétence activée"}));
        } else {
          res.writeHead(502);
          res.end(JSON.stringify({ok:false,error:"Réponse INO inattendue. Le compte API INO actuel (dasboard_INO) n'a pas les droits /cc/*. Contactez l'administrateur INO pour activer les droits Centre de Contacts.",raw:JSON.stringify(addResp).slice(0,200)}));
        }
      }catch(e){
        console.error("[SKILL] Erreur:",e.message);
        res.writeHead(500);
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
        if(!token){res.writeHead(502);res.end(JSON.stringify({error:"Token INO indisponible"}));return;}
        const results={};
        // Traiter par batch de 3 avec délai pour respecter le rate-limiting INO
        for(let i=0;i<agentIds.length;i+=3){
          const batch=agentIds.slice(i,i+3);
          await Promise.all(batch.map(async(agentId)=>{
            let _tok=token;
            for(let attempt=0;attempt<3;attempt++){
              try{
                const rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},_tok);
                if(rf.status===401){
                  // Token expiré côté INO : forcer un renouvellement
                  _tok=await getToken(true);
                  if(attempt<2){await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
                  results[agentId]={error:"HTTP 401 — Token invalide après renouvellement"};
                  break;
                }
                const r=rf.body;
                if(r&&(r.flowSkills||r.profileSkills)){
                  const flow=r.flowSkills||[];
                  results[agentId]={
                    skills:flow.filter(s=>s.status===1).map(s=>({id:s.id,name:s.name,score:s.score||100,active:true})),
                    allSkills:flow.map(s=>({id:s.id,name:s.name,score:s.score||100,active:s.status===1}))
                  };
                  return;
                }
                // Réponse inattendue mais pas d'erreur HTTP
                results[agentId]={error:"Réponse INO vide ou inattendue (HTTP "+rf.status+")"};
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
      if(!token){res.writeHead(502);res.end(JSON.stringify({error:"Token indisponible"}));return;}
      let rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},token);
      if(rf.status===401){
        // Token expiré — renouveler et réessayer une fois
        token=await getToken(true);
        rf=await apiReqFull("POST","/cc/agent/"+agentId+"/flow/voice/skills/list",{},token);
      }
      if(rf.status===401){res.writeHead(502);res.end(JSON.stringify({error:"HTTP 401 — Droits insuffisants sur le compte INO dasboard_INO pour /cc/*"}));return;}
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(rf.body||{}));
    }catch(e){
      res.writeHead(500);
      res.end(JSON.stringify({error:e.message}));
    }
    return;
  }
  // === STATUT FILES (agrégation temps réel depuis histories du jour) ===
  if(url==="/api/queues-status"&&session){
    const u2=new URL(req.url,"http://localhost");
    const date=u2.searchParams.get("date")||new Date().toISOString().slice(0,10);
    try{
      const token=await getToken();
      if(!token){res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"Token indisponible"}));return;}
      const[ci,co]=await Promise.all([
        apiReq("POST","/call/in/histories",{startDate:date+" 00:00:00",endDate:date+" 23:59:59",limit:1000},token),
        apiReq("POST","/call/out/histories",{startDate:date+" 00:00:00",endDate:date+" 23:59:59",limit:1000},token)
      ]);
      const inH=(ci&&ci.histories)||[];
      const outH=(co&&co.histories)||[];
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
        qs:q.recus>0?Math.round((q.decroches/q.recus)*100):0,
        tauxAbandon:q.recus>0?Math.round((q.abandons/q.recus)*100):0,
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
  // Config publique — expose CAMPS, QUEUES_MAP, SKILLS au dashboard (source unique : queues_config.js)
  if(url==="/api/config"){
    const cfg={CAMPS,QUEUES_MAP,SKILLS};
    res.writeHead(200,{"Content-Type":"application/json","Cache-Control":"public,max-age=300"});
    return res.end(JSON.stringify(cfg));
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
  if(url==="/api/skills"){
    fetchAgentSkills().then(m=>{
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({ok:true,count:Object.keys(m).length,agents:m}));
    }).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});
    return;
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
  if(url==="/"||url==="/dashboard"){const p=path.join(__dirname,"dashboard.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/agents-jour"){const p=path.join(__dirname,"agents_jour.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
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
