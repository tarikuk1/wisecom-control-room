const http=require("http"),https=require("https"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000;
const INO_LOGIN=process.env.INO_LOGIN||"tarik_dashboard";
const INO_PWD=process.env.INO_PWD||"XnF!AuuWJg$cR$S";
const INO_APIKEY=process.env.INO_APIKEY||"dasboard_INO";
const SECURITY_CODE=process.env.SECURITY_CODE||"286828";
const USERS_RAW=process.env.USERS||"tarik:Wisecom2026!,admin:ControlRoom2026!";
const USERS=Object.fromEntries(USERS_RAW.split(",").map(u=>{const[l,...r]=u.trim().split(":");return[l.toLowerCase(),r.join(":")];}));

const sessions={},pending={},loginAttempts={};
const TTL=8*60*60*1000,PTTL=5*60*1000,RATE_W=15*60*1000,RATE_MAX=5;

const tok=()=>crypto.randomBytes(32).toString("hex");
function createSession(login){const t=tok();sessions[t]={login,expires:Date.now()+TTL,createdAt:new Date().toISOString()};return t;}
function createPending(login){const t=tok();pending[t]={login,expires:Date.now()+PTTL};return t;}
function getSession(t){if(!t||!sessions[t])return null;const s=sessions[t];if(Date.now()>s.expires){delete sessions[t];return null;}s.expires=Date.now()+TTL;return s;}
function getPending(t){if(!t||!pending[t])return null;const s=pending[t];if(Date.now()>s.expires){delete pending[t];return null;}return s;}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||"").split(";").map(c=>{const[k,...v]=c.trim().split("=");return[k,v.join("=")];}));}
function setCookie(res,n,v,age=TTL/1000){res.setHeader("Set-Cookie",n+"="+v+"; HttpOnly; SameSite=Strict; Path=/; Max-Age="+age);}
function isRL(ip){const now=Date.now();if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip]=loginAttempts[ip].filter(t=>now-t<RATE_W);return loginAttempts[ip].length>=RATE_MAX;}
function recAttempt(ip){if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip].push(Date.now());}
function secH(res){res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");}

let bToken=null,bExp=0,sseClients=[],lastPayload=null,statsCache={};

function apiReq(method,p,body,token){
  return new Promise((resolve,reject)=>{
    const auth=token?("Bearer "+token):"Basic "+Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+p,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const req=https.request(opts,r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve(buf);}});});
    req.on("error",reject);if(data)req.write(data);req.end();
  });
}

async function getToken(){
  if(bToken&&Date.now()<bExp)return bToken;
  try{
    const creds=Buffer.from(INO_LOGIN+":"+INO_PWD).toString("base64");
    const res=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:"wisecom.unicity.io",path:"/api/auth",method:"GET",headers:{"Authorization":"Basic "+creds}},r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve({});}});});
      req.on("error",reject);req.end();
    });
    if(res.access_token){bToken=res.access_token;bExp=Date.now()+270000;console.log("["+new Date().toLocaleTimeString("fr-FR")+"] Token OK");}
  }catch(e){console.error("Auth:",e.message);}
  return bToken;
}

async function fetchDayStats(){
  const token=await getToken();if(!token)return;
  const d=new Date().toISOString().slice(0,10);
  try{
    const[ci,co]=await Promise.all([
      apiReq("POST","/call/in/histories",{startDate:d+" 00:00:00",endDate:d+" 23:59:59",limit:1000},token),
      apiReq("POST","/call/out/histories",{startDate:d+" 00:00:00",endDate:d+" 23:59:59",limit:1000},token)
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

async function fetchAgentsDay(date){
  const token=await getToken();if(!token)throw new Error("Pas de token");
  const[ri,ro]=await Promise.all([
    apiReq("POST","/call/in/histories",{startDate:date+" 00:01:00",endDate:date+" 23:59:59",limit:1000},token),
    apiReq("POST","/call/out/histories",{startDate:date+" 00:01:00",endDate:date+" 23:59:59",limit:1000},token)
  ]);
  const agents={};
  function proc(h,type){
    if(!h.agent||!h.agent.id||!h.agent.firstname)return;
    const k=h.agent.id;
    if(!agents[k])agents[k]={id:k,nom:h.agent.firstname+" "+h.agent.lastname,username:h.agent.username,appelsIn:0,appelsOut:0,duree:0,premiereAction:h.callDate||h.acdDate,derniereAction:h.callDate||h.acdDate,queues:new Set()};
    if(type==="in")agents[k].appelsIn++;else agents[k].appelsOut++;
    agents[k].duree+=(h.call&&h.call.agentDuration)||0;
    const dt=h.callDate||h.acdDate;
    if(dt<agents[k].premiereAction)agents[k].premiereAction=dt;
    if(dt>agents[k].derniereAction)agents[k].derniereAction=dt;
    if(h.queue&&h.queue.queueName)agents[k].queues.add(h.queue.queueName);
  }
  (ri&&ri.histories?ri.histories:[]).forEach(h=>proc(h,"in"));
  (ro&&ro.histories?ro.histories:[]).forEach(h=>proc(h,"out"));
  return Object.values(agents).map(a=>({id:a.id,nom:a.nom,username:a.username,appelsIn:a.appelsIn,appelsOut:a.appelsOut,total:a.appelsIn+a.appelsOut,duree:a.duree,dmt:(a.appelsIn+a.appelsOut)>0?Math.round(a.duree/(a.appelsIn+a.appelsOut)):0,premiereAction:a.premiereAction,derniereAction:a.derniereAction,queues:Array.from(a.queues).join(", ")})).sort((a,b)=>b.total-a.total);
}

function makeLogin(err,rl){return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Control Room — Wisecom</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#080808;font-family:Segoe UI,system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at 20% 50%,rgba(232,0,110,.08) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(232,0,110,.05) 0%,transparent 50%)}.wrap{width:420px;padding:20px}.logo{text-align:center;margin-bottom:36px}.logo-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#E8006E;box-shadow:0 0 20px #E8006E;animation:pulse 2s infinite;margin-right:8px;vertical-align:middle}@keyframes pulse{0%,100%{box-shadow:0 0 20px #E8006E}50%{box-shadow:0 0 30px #E8006E,0 0 60px rgba(232,0,110,.5)}}.logo-title{font-size:22px;font-weight:800;letter-spacing:.1em;color:#fff;vertical-align:middle}.logo-sub{font-size:11px;color:#444;margin-top:6px;letter-spacing:.1em;text-transform:uppercase}.card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px;backdrop-filter:blur(20px)}.card-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:6px}.card-sub{font-size:12px;color:#555;margin-bottom:24px}.field{margin-bottom:18px}label{display:block;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}input{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:13px 16px;font-size:14px;outline:0;transition:all .2s}input:focus{border-color:#E8006E;background:rgba(232,0,110,.05);box-shadow:0 0 0 3px rgba(232,0,110,.1)}.btn{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;margin-top:8px}.btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(232,0,110,.4)}.alert{border-radius:8px;padding:11px 14px;font-size:12px;margin-bottom:18px;display:flex;align-items:center;gap:8px}.alert-err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b}.alert-rl{background:rgba(255,155,0,.1);border:1px solid rgba(255,155,0,.3);color:#ff9b00}.divider{height:1px;background:rgba(255,255,255,.06);margin:18px 0}.footer{text-align:center;font-size:10px;color:#333;margin-top:18px}</style></head><body><div class="wrap"><div class="logo"><span class="logo-dot"></span><span class="logo-title">CONTROL ROOM</span><div class="logo-sub">Wisecom · Supervision temps réel</div></div><div class="card"><div class="card-title">Connexion sécurisée</div><div class="card-sub">Accès réservé aux collaborateurs Wisecom</div>'+(rl?'<div class="alert alert-rl">⏳ Trop de tentatives. Réessayez dans 15 min.</div>':err?'<div class="alert alert-err">✕ Identifiants incorrects.</div>':'')+'<form method="POST" action="/login"><div class="field"><label>Identifiant</label><input type="text" name="login" placeholder="Votre login" autocomplete="username" required></div><div class="field"><label>Mot de passe</label><input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required></div><button type="submit" class="btn">Se connecter →</button></form><div class="divider"></div><div style="font-size:11px;color:#444;text-align:center">🔒 Connexion chiffrée · Session 8h</div></div><div class="footer">Wisecom © '+new Date().getFullYear()+' · Tous droits réservés</div></div></body></html>';}

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
        setCookie(res,"session",st);
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
  // Health public
  if(url==="/health"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({status:"ok",version:"2.1",sseClients:sseClients.length,inoConnected:!!bToken,lastEvent:lastPayload?lastPayload.horodatage:null,uptime:Math.round(process.uptime()),stats:statsCache}));}
  // API status public
  if(url==="/api/status"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({ok:true,sseClients:sseClients.length,inoConnected:!!bToken,lastUpdate:lastPayload?lastPayload.horodatage:null,appels:statsCache.totalAppels||0,dmc:Math.round(statsCache.dmc||0)}));}

  // Session requise
  if(!session){res.writeHead(302,{Location:"/login"});return res.end();}

  if(url==="/events"){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive","X-Accel-Buffering":"no"});res.write(": connected\n\n");if(lastPayload)res.write("data: "+JSON.stringify(lastPayload)+"\n\n");sseClients.push(res);req.on("close",()=>{sseClients=sseClients.filter(c=>c!==res);});return;}
  if(url==="/agents-day"){
    const u=new URL(req.url,"http://localhost");
    const date=u.searchParams.get("date")||new Date().toISOString().slice(0,10);
    fetchAgentsDay(date).then(agents=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({agents,date,count:agents.length}));}).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});return;
  }
  if(url==="/api/admin/stats"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({sessions:Object.keys(sessions).length,sseClients:sseClients.length,usersCount:Object.keys(USERS).length,lastEvent:lastPayload?lastPayload.horodatage:null,inoOk:!!bToken&&Date.now()<bExp,stats:statsCache,uptime:process.uptime(),user:session.login}));}
  if(url==="/api/stats"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify(Object.assign({},statsCache,{sseClients:sseClients.length})));}
  if(url==="/admin"||url.startsWith("/admin/")){
    if(session.login!=="admin"&&session.login!=="tarik"){res.writeHead(403,{"Content-Type":"text/html"});return res.end('<html><body style="background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center"><div><h1 style="color:#E8006E;font-size:60px">403</h1><p style="color:#555">Accès refusé.</p><a href="/" style="color:#E8006E">← Retour</a></div></body></html>');}
    const adminHtml=require("fs").existsSync(require("path").join(__dirname,"admin.html"))?require("fs").readFileSync(require("path").join(__dirname,"admin.html"),"utf8"):"<html><body style=\"background:#080808;color:#fff;font-family:sans-serif;padding:40px\"><h1 style=\"color:#E8006E\">Admin Panel</h1><p style=\"color:#555\">Connecté: "+session.login+"</p><a href=\"/\" style=\"color:#E8006E\">← Dashboard</a></body></html>";
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