const http  = require("http");
const https = require("https");
const fs    = require("fs");
const path  = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const INO_LOGIN  = process.env.INO_LOGIN  || "tarik_dashboard";
const INO_PWD    = process.env.INO_PWD    || "XnF!AuuWJg$cR$S";
const INO_APIKEY = process.env.INO_APIKEY || "dasboard_INO";
const USERS_RAW  = process.env.USERS || "tarik:Wisecom2026!,admin:ControlRoom2026!";
const SECURITY_CODE = process.env.SECURITY_CODE || "286828";
const USERS = Object.fromEntries(USERS_RAW.split(",").map(u => { const [l,...r]=u.trim().split(":"); return [l.toLowerCase(),r.join(":")]; }));

const sessions = {};
const pending  = {}; // sessions en attente du code 2FA
const SESSION_TTL = 8*60*60*1000;
const PENDING_TTL = 5*60*1000; // 5 min pour saisir le code

function createSession(login){ const t=crypto.randomBytes(32).toString("hex"); sessions[t]={login,expires:Date.now()+SESSION_TTL}; return t; }
function createPending(login){ const t=crypto.randomBytes(32).toString("hex"); pending[t]={login,expires:Date.now()+PENDING_TTL}; return t; }
function getSession(token){ if(!token||!sessions[token])return null; const s=sessions[token]; if(Date.now()>s.expires){delete sessions[token];return null;} s.expires=Date.now()+SESSION_TTL; return s; }
function getPending(token){ if(!token||!pending[token])return null; const s=pending[token]; if(Date.now()>s.expires){delete pending[token];return null;} return s; }
function parseCookies(req){ const raw=req.headers.cookie||""; return Object.fromEntries(raw.split(";").map(c=>{const[k,...v]=c.trim().split("=");return[k,v.join("=")];})); }
function setCookie(res,name,value,maxAge=SESSION_TTL/1000){ res.setHeader("Set-Cookie",`${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`); }

let bearerToken=null,tokenExpireAt=0,sseClients=[],lastPayload=null;

function apiRequest(method,apiPath,body,token){
  return new Promise((resolve,reject)=>{
    const auth=token?(`Bearer ${token}`):"Basic "+Buffer.from(`${INO_LOGIN}:${INO_PWD}`).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+apiPath,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const req=https.request(opts,r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve(buf);}});});
    req.on("error",reject);if(data)req.write(data);req.end();
  });
}

async function getToken(){
  if(bearerToken&&Date.now()<tokenExpireAt)return bearerToken;
  try{
    const creds=Buffer.from(`${INO_LOGIN}:${INO_PWD}`).toString("base64");
    const res=await new Promise((resolve,reject)=>{
      const opts={hostname:"wisecom.unicity.io",path:"/api/auth",method:"GET",headers:{"Authorization":`Basic ${creds}`,"Content-Type":"application/json"}};
      const req=https.request(opts,r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve(buf);}});});
      req.on("error",reject);req.end();
    });
    if(res&&res.access_token){bearerToken=res.access_token;tokenExpireAt=Date.now()+270000;console.log("Token Bearer obtenu");}
  }catch(e){console.error("Auth:",e.message);}
  return bearerToken;
}

async function fetchDayStats(){
  const token=await getToken();if(!token)return;
  const d=new Date().toISOString().slice(0,10);
  try{
    const[ci,co]=await Promise.all([
      apiRequest("POST","/call/in/histories",{startDate:`${d} 00:00:00`,endDate:`${d} 23:59:59`,limit:1000},token),
      apiRequest("POST","/call/out/histories",{startDate:`${d} 00:00:00`,endDate:`${d} 23:59:59`,limit:1000},token)
    ]);
    const all=[...(ci?.histories||[]),...(co?.histories||[])];
    const tr=all.filter(c=>(c.call?.agentDuration||0)>0);
    const dur=tr.reduce((s,c)=>s+(c.call?.agentDuration||0),0);
    const dmc=tr.length>0?dur/tr.length:0;
    const lc=[...all].reverse().find(c=>(c.call?.agentDuration||0)>0)||{};
    const payload={id_evenement:`poll_${Date.now()}`,horodatage:new Date().toISOString(),agent:{id_ino:"MULTI",nom:"Tous agents",competences_actives:[]},session:{statut_actuel:"disponible"},action_venant_de_se_terminer:{type_acte:lc.call?.type==="OUTCALL"?"sortant":"entrant",campagne:lc.queue?.queueName||"–",qualification:lc.status||"–",duree_acte_secondes:lc.call?.agentDuration||0},cumul_journee_agent:{total_appels_traites:tr.length,total_mails_traites:0,temps_total_communication_secondes:dur,heures_de_prod_secondes:32400}};
    lastPayload=payload;
    const msg=`data: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach(c=>{try{c.write(msg);}catch{}});
    sseClients=sseClients.filter(c=>!c.destroyed);
    console.log(`[${new Date().toLocaleTimeString("fr-FR")}] Stats INO — ${tr.length} appels | DMC ${Math.floor(dmc/60)}:${String(Math.round(dmc%60)).padStart(2,"0")}`);
  }catch(e){console.error("fetchDayStats:",e.message);}
}

async function fetchAgentsDay(date){
  const token=await getToken();if(!token)throw new Error("Pas de token");
  const[ri,ro]=await Promise.all([
    apiRequest("POST","/call/in/histories",{startDate:`${date} 00:01:00`,endDate:`${date} 23:59:59`,limit:1000},token),
    apiRequest("POST","/call/out/histories",{startDate:`${date} 00:01:00`,endDate:`${date} 23:59:59`,limit:1000},token)
  ]);
  const agents={};
  const proc=(h,type)=>{
    if(!h.agent?.id||!h.agent?.firstname)return;
    const k=h.agent.id;
    if(!agents[k])agents[k]={id:k,nom:`${h.agent.firstname} ${h.agent.lastname}`,username:h.agent.username,appelsIn:0,appelsOut:0,duree:0,premiereAction:h.callDate||h.acdDate,derniereAction:h.callDate||h.acdDate,queues:new Set()};
    if(type==="in")agents[k].appelsIn++;else agents[k].appelsOut++;
    agents[k].duree+=h.call?.agentDuration||0;
    const dt=h.callDate||h.acdDate;
    if(dt<agents[k].premiereAction)agents[k].premiereAction=dt;
    if(dt>agents[k].derniereAction)agents[k].derniereAction=dt;
    if(h.queue?.queueName)agents[k].queues.add(h.queue.queueName);
  };
  (ri.histories||[]).forEach(h=>proc(h,"in"));
  (ro.histories||[]).forEach(h=>proc(h,"out"));
  return Object.values(agents).map(a=>({id:a.id,nom:a.nom,username:a.username,appelsIn:a.appelsIn,appelsOut:a.appelsOut,total:a.appelsIn+a.appelsOut,duree:a.duree,dmt:(a.appelsIn+a.appelsOut)>0?Math.round(a.duree/(a.appelsIn+a.appelsOut)):0,premiereAction:a.premiereAction,derniereAction:a.derniereAction,queues:[...a.queues].join(", ")})).sort((a,b)=>b.total-a.total);
}

// ── Pages HTML ──
const makeLoginPage = (error=false) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Room — Connexion</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#0c0c0c;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}.card{background:#111;border:1px solid #1e1e1e;border-radius:14px;padding:40px;width:380px;box-shadow:0 24px 60px rgba(0,0,0,.6);}.logo{display:flex;align-items:center;gap:10px;margin-bottom:32px;}.dot{width:10px;height:10px;border-radius:50%;background:#E8006E;box-shadow:0 0 12px #E8006E;animation:pulse 2s infinite;}@keyframes pulse{0%,100%{box-shadow:0 0 12px #E8006E;}50%{box-shadow:0 0 20px #E8006E,0 0 40px rgba(232,0,110,.4);}}.brand{font-weight:800;font-size:15px;letter-spacing:.07em;color:#fff;}.brand-sub{font-size:10px;color:#555;margin-top:1px;}label{display:block;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}input{width:100%;background:#161616;color:#fff;border:1px solid #2a2a2a;border-radius:8px;padding:11px 14px;font-size:14px;outline:none;margin-bottom:16px;transition:border .15s;}input:focus{border-color:#E8006E;}button{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.03em;transition:opacity .15s;}button:hover{opacity:.88;}.error{background:#1a0808;border:1px solid #5a1010;color:#ff6b6b;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:16px;}.footer{text-align:center;font-size:10px;color:#333;margin-top:24px;}</style>
</head><body><div class="card">
<div class="logo"><div class="dot"></div><div><div class="brand">CONTROL ROOM</div><div class="brand-sub">WISECOM · ACCÈS SÉCURISÉ</div></div></div>
${error?'<div class="error">Identifiants incorrects. Veuillez réessayer.</div>':''}
<form method="POST" action="/login">
<label>Identifiant</label><input type="text" name="login" placeholder="Votre login" autocomplete="username" required>
<label>Mot de passe</label><input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required>
<button type="submit">Se connecter →</button>
</form>
<div class="footer">Wisecom © ${new Date().getFullYear()} · Accès réservé</div>
</div></body></html>`;

const makeCodePage = (error=false) => `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Room — Vérification</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{background:#0c0c0c;font-family:'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}.card{background:#111;border:1px solid #1e1e1e;border-radius:14px;padding:40px;width:380px;box-shadow:0 24px 60px rgba(0,0,0,.6);}.logo{display:flex;align-items:center;gap:10px;margin-bottom:28px;}.dot{width:10px;height:10px;border-radius:50%;background:#E8006E;box-shadow:0 0 12px #E8006E;}.brand{font-weight:800;font-size:15px;letter-spacing:.07em;color:#fff;}.brand-sub{font-size:10px;color:#555;margin-top:1px;}.info{background:#0a1a0f;border:1px solid #1a4a2a;color:#4caf7d;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:20px;line-height:1.5;}label{display:block;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;}input{width:100%;background:#161616;color:#fff;border:1px solid #2a2a2a;border-radius:8px;padding:14px;font-size:22px;font-weight:700;outline:none;margin-bottom:16px;transition:border .15s;letter-spacing:.3em;text-align:center;}input:focus{border-color:#E8006E;}button{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:8px;padding:13px;font-size:14px;font-weight:700;cursor:pointer;transition:opacity .15s;}button:hover{opacity:.88;}.error{background:#1a0808;border:1px solid #5a1010;color:#ff6b6b;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:16px;}.back{text-align:center;margin-top:16px;font-size:11px;color:#444;}.back a{color:#E8006E;text-decoration:none;}.footer{text-align:center;font-size:10px;color:#333;margin-top:20px;}</style>
</head><body><div class="card">
<div class="logo"><div class="dot"></div><div><div class="brand">VÉRIFICATION</div><div class="brand-sub">WISECOM · CODE DE SÉCURITÉ</div></div></div>
<div class="info">🔒 Identifiants validés. Saisissez le code de sécurité pour accéder au Control Room.</div>
${error?'<div class="error">Code incorrect. Veuillez réessayer.</div>':''}
<form method="POST" action="/verify-code">
<label>Code de sécurité (6 chiffres)</label>
<input type="text" name="code" placeholder="••••••" maxlength="6" inputmode="numeric" pattern="[0-9]{6}" autocomplete="off" required autofocus>
<button type="submit">Accéder au Control Room →</button>
</form>
<div class="back"><a href="/login">← Retour à la connexion</a></div>
<div class="footer">Wisecom © ${new Date().getFullYear()} · Accès réservé</div>
</div></body></html>`;

const server=http.createServer(async(req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  const cookies=parseCookies(req);
  const session=getSession(cookies.session);
  const url=req.url.split("?")[0];

  // ── Routes publiques ──
  if(url==="/login"&&req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeLoginPage());}
  
  if(url==="/login"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      const p=new URLSearchParams(body);
      const login=(p.get("login")||"").toLowerCase().trim();
      const pwd=p.get("password")||"";
      if(USERS[login]&&USERS[login]===pwd){
        // Étape 1 OK → crée session pending et redirige vers code
        const pt=createPending(login);
        setCookie(res,"pending",pt,PENDING_TTL/1000);
        res.writeHead(302,{Location:"/verify-code"});
        console.log(`[AUTH] Login OK: ${login} → en attente du code`);
      } else {
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeLoginPage(true));
      }
      res.end();
    });return;
  }

  if(url==="/verify-code"&&req.method==="GET"){
    const ps=getPending(cookies.pending);
    if(!ps){res.writeHead(302,{Location:"/login"});return res.end();}
    res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
    return res.end(makeCodePage());
  }

  if(url==="/verify-code"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      const ps=getPending(cookies.pending);
      if(!ps){res.writeHead(302,{Location:"/login"});return res.end();}
      const p=new URLSearchParams(body);
      const code=(p.get("code")||"").trim();
      if(code===SECURITY_CODE){
        // Code OK → session complète
        delete pending[cookies.pending];
        setCookie(res,"pending","",0);
        const st=createSession(ps.login);
        setCookie(res,"session",st);
        res.writeHead(302,{Location:"/"});
        console.log(`[AUTH] Accès complet: ${ps.login}`);
      } else {
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeCodePage(true));
        console.log(`[AUTH] Code incorrect: ${ps.login}`);
      }
      res.end();
    });return;
  }

  if(url==="/logout"){
    if(cookies.session)delete sessions[cookies.session];
    if(cookies.pending)delete pending[cookies.pending];
    setCookie(res,"session","",0);setCookie(res,"pending","",0);
    res.writeHead(302,{Location:"/login"});return res.end();
  }

  if(url==="/webhook"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{try{const p=JSON.parse(body);lastPayload=p;const m=`data: ${JSON.stringify(p)}\n\n`;sseClients.forEach(c=>{try{c.write(m);}catch{}});sseClients=sseClients.filter(c=>!c.destroyed);res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:"JSON invalide"}));}});return;
  }

  // ── Session requise ──
  if(!session){res.writeHead(302,{Location:"/login"});return res.end();}

  if(url==="/events"){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});res.write(": connected\n\n");if(lastPayload)res.write(`data: ${JSON.stringify(lastPayload)}\n\n`);sseClients.push(res);req.on("close",()=>{sseClients=sseClients.filter(c=>c!==res);});return;}
  
  if(url==="/agents-day"){
    const u=new URL(req.url,`http://localhost`);const date=u.searchParams.get("date")||new Date().toISOString().slice(0,10);
    fetchAgentsDay(date).then(agents=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({agents,date,count:agents.length}));}).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});return;
  }
  
  if(url==="/"||url==="/dashboard"){const p=path.join(__dirname,"dashboard.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/agents-jour"){const p=path.join(__dirname,"agents_jour.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/health"){res.writeHead(200);return res.end(JSON.stringify({status:"ok",user:session.login,clients_sse:sseClients.length}));}
  res.writeHead(404);res.end("Not found");
});

fetchDayStats();
setInterval(fetchDayStats,30000);
server.listen(PORT,()=>{
  console.log("─────────────────────────────────");
  console.log(`  Wisecom Control Room SaaS`);
  console.log(`  Port: ${PORT} | Users: ${Object.keys(USERS).join(", ")}`);
  console.log(`  2FA: activé (code requis)`);
  console.log("─────────────────────────────────");
});