const http=require("http"),https=require("https"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const PORT=process.env.PORT||3000;
const INO_LOGIN=process.env.INO_LOGIN||"tarik_dashboard";
const INO_PWD=process.env.INO_PWD||"XnF!AuuWJg\$cR\$S";
const INO_APIKEY=process.env.INO_APIKEY||"dasboard_INO";
const SECURITY_CODE=process.env.SECURITY_CODE||"286828";
const USERS_RAW=process.env.USERS||"tarik:Wisecom2026!,admin:ControlRoom2026!";
const USERS=Object.fromEntries(USERS_RAW.split(",").map(u=>{const[l,...r]=u.trim().split(":");return[l.toLowerCase(),r.join(":")];}));
const sessions={},pending={},loginAttempts={};
const TTL=8*60*60*1000,PTTL=5*60*1000,RATE_WINDOW=15*60*1000,RATE_MAX=5;

const tok=()=>crypto.randomBytes(32).toString("hex");
const csrfTok=()=>crypto.randomBytes(16).toString("hex");
const csrf_tokens={};

function createSession(login,role="user"){const t=tok();sessions[t]={login,role,expires:Date.now()+TTL,createdAt:new Date().toISOString()};return t;}
function createPending(login){const t=tok();const c=csrfTok();pending[t]={login,expires:Date.now()+PTTL,csrf:c};return{pt:t,csrf:c};}
function getSession(t){if(!t||!sessions[t])return null;const s=sessions[t];if(Date.now()>s.expires){delete sessions[t];return null;}s.expires=Date.now()+TTL;return s;}
function getPending(t){if(!t||!pending[t])return null;const s=pending[t];if(Date.now()>s.expires){delete pending[t];return null;}return s;}
function parseCookies(req){return Object.fromEntries((req.headers.cookie||"").split(";").map(c=>{const[k,...v]=c.trim().split("=");return[k,v.join("=")];}));}
function setCookie(res,n,v,age=TTL/1000){res.setHeader("Set-Cookie",`${n}=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}`);}
function isRateLimited(ip){const now=Date.now();if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip]=loginAttempts[ip].filter(t=>now-t<RATE_WINDOW);return loginAttempts[ip].length>=RATE_MAX;}
function recordAttempt(ip){if(!loginAttempts[ip])loginAttempts[ip]=[];loginAttempts[ip].push(Date.now());}
function secHeaders(res){res.setHeader("X-Content-Type-Options","nosniff");res.setHeader("X-Frame-Options","DENY");res.setHeader("X-XSS-Protection","1; mode=block");res.setHeader("Referrer-Policy","strict-origin-when-cross-origin");}

let bearerToken=null,tokenExp=0,sseClients=[],lastPayload=null,statsCache={};

function apiReq(method,apiPath,body,token){
  return new Promise((resolve,reject)=>{
    const auth=token?(`Bearer ${token}`):"Basic "+Buffer.from(`${INO_LOGIN}:${INO_PWD}`).toString("base64");
    const data=body?JSON.stringify(body):null;
    const opts={hostname:"wisecom.unicity.io",path:"/api"+apiPath,method,headers:{"Content-Type":"application/json","Authorization":auth,"X-EKO-Api-Key":INO_APIKEY,...(data?{"Content-Length":Buffer.byteLength(data)}:{})}};
    const req=https.request(opts,r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve(buf);}});});
    req.on("error",reject);if(data)req.write(data);req.end();
  });
}

async function getToken(){
  if(bearerToken&&Date.now()<tokenExp)return bearerToken;
  try{
    const creds=Buffer.from(`${INO_LOGIN}:${INO_PWD}`).toString("base64");
    const res=await new Promise((resolve,reject)=>{
      const req=https.request({hostname:"wisecom.unicity.io",path:"/api/auth",method:"GET",headers:{"Authorization":`Basic ${creds}`}},r=>{let buf="";r.on("data",c=>buf+=c);r.on("end",()=>{try{resolve(JSON.parse(buf));}catch{resolve({});}});});
      req.on("error",reject);req.end();
    });
    if(res.access_token){bearerToken=res.access_token;tokenExp=Date.now()+270000;console.log("["+new Date().toLocaleTimeString()+"] Token OK");}
  }catch(e){console.error("Auth:",e.message);}
  return bearerToken;
}

async function fetchDayStats(){
  const token=await getToken();if(!token)return;
  const d=new Date().toISOString().slice(0,10);
  try{
    const[ci,co]=await Promise.all([
      apiReq("POST","/call/in/histories",{startDate:`${d} 00:00:00`,endDate:`${d} 23:59:59`,limit:1000},token),
      apiReq("POST","/call/out/histories",{startDate:`${d} 00:00:00`,endDate:`${d} 23:59:59`,limit:1000},token)
    ]);
    const all=[...(ci?.histories||[]),...(co?.histories||[])];
    const tr=all.filter(c=>(c.call?.agentDuration||0)>0);
    const dur=tr.reduce((s,c)=>s+(c.call?.agentDuration||0),0);
    const dmc=tr.length>0?dur/tr.length:0;
    const lc=[...all].reverse().find(c=>(c.call?.agentDuration||0)>0)||{};
    statsCache={totalAppels:tr.length,totalDuree:dur,dmc,lastCall:lc,date:d,updatedAt:new Date().toISOString()};
    const payload={id_evenement:`poll_${Date.now()}`,horodatage:new Date().toISOString(),agent:{id_ino:"MULTI",nom:"Tous agents",competences_actives:[]},session:{statut_actuel:"disponible"},action_venant_de_se_terminer:{type_acte:lc.call?.type==="OUTCALL"?"sortant":"entrant",campagne:lc.queue?.queueName||"â",qualification:lc.status||"â",duree_acte_secondes:lc.call?.agentDuration||0},cumul_journee_agent:{total_appels_traites:tr.length,total_mails_traites:0,temps_total_communication_secondes:dur,heures_de_prod_secondes:32400}};
    lastPayload=payload;
    const msg=`data: ${JSON.stringify(payload)}\n\n`;
    sseClients.forEach(c=>{try{c.write(msg);}catch{}});
    sseClients=sseClients.filter(c=>!c.destroyed);
    console.log(`[${new Date().toLocaleTimeString("fr-FR")}] ${tr.length} appels | DMC ${Math.floor(dmc/60)}:${String(Math.round(dmc%60)).padStart(2,"0")}`);
  }catch(e){console.error("Stats:",e.message);}
}

async function fetchAgentsDay(date){
  const token=await getToken();if(!token)throw new Error("Pas de token");
  const[ri,ro]=await Promise.all([
    apiReq("POST","/call/in/histories",{startDate:`${date} 00:01:00`,endDate:`${date} 23:59:59`,limit:1000},token),
    apiReq("POST","/call/out/histories",{startDate:`${date} 00:01:00`,endDate:`${date} 23:59:59`,limit:1000},token)
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

// ââ HTML Pages ââ
const P="#E8006E";
const makeLogin=(err=false,rl=false)=>`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Room â Connexion Â· Wisecom</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#080808;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at 20% 50%,rgba(232,0,110,.07) 0%,transparent 60%),radial-gradient(ellipse at 80% 20%,rgba(232,0,110,.05) 0%,transparent 50%);}
  .wrap{width:420px;padding:20px;}
  .logo{text-align:center;margin-bottom:40px;}
  .logo-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#E8006E;box-shadow:0 0 20px #E8006E,0 0 40px rgba(232,0,110,.4);animation:pulse 2s infinite;margin-right:10px;vertical-align:middle;}
  @keyframes pulse{0%,100%{box-shadow:0 0 20px #E8006E;}50%{box-shadow:0 0 30px #E8006E,0 0 60px rgba(232,0,110,.5);}}
  .logo-title{font-size:22px;font-weight:800;letter-spacing:.1em;color:#fff;vertical-align:middle;}
  .logo-sub{font-size:11px;color:#444;margin-top:6px;letter-spacing:.12em;text-transform:uppercase;}
  .card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px;backdrop-filter:blur(20px);}
  .card-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:6px;}
  .card-sub{font-size:12px;color:#555;margin-bottom:28px;}
  .field{margin-bottom:18px;}
  label{display:block;font-size:11px;color:#666;font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px;}
  input{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;padding:13px 16px;font-size:14px;outline:none;transition:all .2s;}
  input:focus{border-color:#E8006E;background:rgba(232,0,110,.05);box-shadow:0 0 0 3px rgba(232,0,110,.1);}
  .btn{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;letter-spacing:.04em;transition:all .2s;margin-top:8px;}
  .btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(232,0,110,.4);}
  .btn:active{transform:translateY(0);}
  .alert{border-radius:8px;padding:11px 14px;font-size:12px;margin-bottom:20px;display:flex;align-items:center;gap:8px;}
  .alert-err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b;}
  .alert-rl{background:rgba(255,155,0,.1);border:1px solid rgba(255,155,0,.3);color:#ff9b00;}
  .footer{text-align:center;font-size:10px;color:#333;margin-top:20px;}
  .divider{height:1px;background:rgba(255,255,255,.06);margin:20px 0;}
</style></head><body>
<div class="wrap">
  <div class="logo">
    <div><span class="logo-dot"></span><span class="logo-title">CONTROL ROOM</span></div>
    <div class="logo-sub">Wisecom Â· Supervision temps rÃ©el</div>
  </div>
  <div class="card">
    <div class="card-title">Connexion sÃ©curisÃ©e</div>
    <div class="card-sub">AccÃ¨s rÃ©servÃ© aux collaborateurs Wisecom</div>
    ${rl?'<div class="alert alert-rl">â³ Trop de tentatives. RÃ©essayez dans 15 minutes.</div>':''}
    ${err&&!rl?'<div class="alert alert-err">â Identifiants incorrects.</div>':''}
    <form method="POST" action="/login" autocomplete="on">
      <div class="field"><label>Identifiant</label><input type="text" name="login" placeholder="Votre login" autocomplete="username" required></div>
      <div class="field"><label>Mot de passe</label><input type="password" name="password" placeholder="â¢â¢â¢â¢â¢â¢â¢â¢" autocomplete="current-password" required></div>
      <button type="submit" class="btn">Se connecter â</button>
    </form>
    <div class="divider"></div>
    <div style="font-size:11px;color:#444;text-align:center;">ð Connexion chiffrÃ©e Â· Session 8h</div>
  </div>
  <div class="footer">Wisecom Â© ${new Date().getFullYear()} Â· Tous droits rÃ©servÃ©s</div>
</div></body></html>`;

const makeCode=(err=false)=>`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Control Room â Code de sÃ©curitÃ© Â· Wisecom</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:#080808;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background-image:radial-gradient(ellipse at 50% 50%,rgba(232,0,110,.06) 0%,transparent 60%);}
  .wrap{width:420px;padding:20px;}
  .logo{text-align:center;margin-bottom:36px;}
  .logo-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:#E8006E;box-shadow:0 0 20px #E8006E;animation:pulse 2s infinite;margin-right:8px;vertical-align:middle;}
  @keyframes pulse{0%,100%{box-shadow:0 0 20px #E8006E;}50%{box-shadow:0 0 30px #E8006E,0 0 60px rgba(232,0,110,.5);}}
  .logo-title{font-size:20px;font-weight:800;letter-spacing:.1em;color:#fff;vertical-align:middle;}
  .card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:20px;padding:40px;backdrop-filter:blur(20px);}
  .shield{font-size:36px;text-align:center;margin-bottom:16px;}
  .card-title{font-size:15px;font-weight:700;color:#fff;margin-bottom:6px;text-align:center;}
  .card-sub{font-size:12px;color:#555;margin-bottom:24px;text-align:center;line-height:1.6;}
  .success-bar{background:rgba(48,209,88,.08);border:1px solid rgba(48,209,88,.2);border-radius:8px;padding:10px 14px;font-size:12px;color:#30d158;margin-bottom:20px;text-align:center;}
  .code-inputs{display:flex;gap:10px;justify-content:center;margin-bottom:20px;}
  .code-input{width:52px;height:60px;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.1);border-radius:10px;font-size:24px;font-weight:700;text-align:center;outline:none;transition:all .2s;caret-color:#E8006E;}
  .code-input:focus{border-color:#E8006E;background:rgba(232,0,110,.05);box-shadow:0 0 0 3px rgba(232,0,110,.1);}
  .hidden-input{display:none;}
  .btn{width:100%;background:linear-gradient(135deg,#E8006E,#c0005a);color:#fff;border:none;border-radius:10px;padding:14px;font-size:14px;font-weight:700;cursor:pointer;transition:all .2s;}
  .btn:hover{transform:translateY(-1px);box-shadow:0 8px 24px rgba(232,0,110,.4);}
  .alert-err{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b;border-radius:8px;padding:11px 14px;font-size:12px;margin-bottom:16px;text-align:center;}
  .back{text-align:center;margin-top:16px;font-size:11px;color:#444;}
  .back a{color:#E8006E;text-decoration:none;}
  .footer{text-align:center;font-size:10px;color:#333;margin-top:20px;}
</style></head><body>
<div class="wrap">
  <div class="logo"><span class="logo-dot"></span><span class="logo-title">VÃRIFICATION</span></div>
  <div class="card">
    <div class="shield">ð</div>
    <div class="card-title">Code de sÃ©curitÃ© requis</div>
    <div class="card-sub">Saisissez votre code Ã  6 chiffres<br>pour accÃ©der au Control Room.</div>
    <div class="success-bar">â Identifiants validÃ©s avec succÃ¨s</div>
    ${err?'<div class="alert-err">â Code incorrect. Veuillez rÃ©essayer.</div>':''}
    <form method="POST" action="/verify-code" id="codeForm">
      <div class="code-inputs" id="codeBoxes">
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c0" autofocus>
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c1">
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c2">
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c3">
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c4">
        <input class="code-input" maxlength="1" inputmode="numeric" pattern="[0-9]" id="c5">
      </div>
      <input type="hidden" name="code" id="hiddenCode">
      <button type="submit" class="btn" id="submitBtn">AccÃ©der au Control Room â</button>
    </form>
    <div class="back"><a href="/login">â Retour Ã  la connexion</a></div>
  </div>
  <div class="footer">Wisecom Â© ${new Date().getFullYear()} Â· Session sÃ©curisÃ©e</div>
</div>
<script>
  const inputs=[...document.querySelectorAll('.code-input')];
  inputs.forEach((inp,i)=>{
    inp.addEventListener('input',e=>{
      const v=e.target.value.replace(/[^0-9]/g,'');
      e.target.value=v;
      if(v&&i<5)inputs[i+1].focus();
      updateHidden();
    });
    inp.addEventListener('keydown',e=>{
      if(e.key==='Backspace'&&!e.target.value&&i>0)inputs[i-1].focus();
    });
    inp.addEventListener('paste',e=>{
      e.preventDefault();
      const paste=(e.clipboardData||window.clipboardData).getData('text').replace(/[^0-9]/g,'');
      paste.split('').forEach((c,j)=>{if(inputs[i+j])inputs[i+j].value=c;});
      if(inputs[Math.min(i+paste.length,5)])inputs[Math.min(i+paste.length,5)].focus();
      updateHidden();
    });
  });
  function updateHidden(){
    const code=inputs.map(i=>i.value).join('');
    document.getElementById('hiddenCode').value=code;
    if(code.length===6){setTimeout(()=>document.getElementById('codeForm').submit(),150);}
  }
</script>
</body></html>`;

const make404=()=>`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>404 â Wisecom</title>
<style>body{background:#080808;color:#fff;font-family:'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
h1{font-size:80px;font-weight:800;color:#E8006E;margin-bottom:10px;}p{color:#555;margin-bottom:20px;}a{color:#E8006E;}</style>
</head><body><div><h1>404</h1><p>Cette page n'existe pas.</p><a href="/">â Retour</a></div></body></html>`;

const makeAdmin=(session)=>`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin â Control Room Wisecom</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}body{background:#080808;color:#f0f0f0;font-family:'Segoe UI',system-ui,sans-serif;font-size:13px;}
.header{background:#0f0f0f;border-bottom:1px solid #1a1a1a;padding:12px 24px;display:flex;align-items:center;justify-content:space-between;}
.header-left{display:flex;align-items:center;gap:12px;}
.dot{width:8px;height:8px;border-radius:50%;background:#E8006E;box-shadow:0 0 10px #E8006E;}
.title{font-weight:800;font-size:13px;letter-spacing:.06em;}
.nav{display:flex;gap:2px;background:#0a0a0a;border-bottom:1px solid #1a1a1a;padding:0 24px;}
.nav a{color:#555;text-decoration:none;padding:10px 14px;font-size:12px;border-bottom:2px solid transparent;display:inline-block;transition:all .2s;}
.nav a:hover{color:#ccc;}
.nav a.active{color:#E8006E;border-bottom-color:#E8006E;font-weight:700;}
.content{padding:24px;}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px;margin-bottom:24px;}
.card{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:16px;}
.card-label{font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;font-weight:600;}
.card-value{font-size:26px;font-weight:800;color:#fff;}
.card-value.pink{color:#E8006E;}
.card-value.green{color:#30d158;}
.card-sub{font-size:11px;color:#444;margin-top:4px;}
.panel{background:#111;border:1px solid #1e1e1e;border-radius:12px;margin-bottom:16px;overflow:hidden;}
.panel-header{padding:14px 16px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;justify-content:space-between;}
.panel-title{font-size:11px;font-weight:700;color:#777;text-transform:uppercase;letter-spacing:.05em;}
.panel-body{padding:16px;}
table{width:100%;border-collapse:collapse;font-size:12px;}
th{padding:8px 10px;text-align:left;color:#555;font-weight:600;border-bottom:1px solid #1a1a1a;font-size:10px;text-transform:uppercase;letter-spacing:.05em;}
td{padding:8px 10px;border-bottom:1px solid #111;vertical-align:middle;}
tr:hover td{background:#161616;}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:10px;font-weight:600;}
.badge-green{background:rgba(48,209,88,.15);color:#30d158;}
.badge-pink{background:rgba(232,0,110,.15);color:#E8006E;}
.badge-gray{background:#1a1a1a;color:#666;}
.btn{border:none;border-radius:7px;padding:6px 14px;font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;}
.btn-primary{background:#E8006E;color:#fff;}
.btn-dark{background:#1a1a1a;color:#ccc;border:1px solid #2a2a2a;}
.btn:hover{opacity:.85;}
form.inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
input.field{background:#161616;color:#ccc;border:1px solid #2a2a2a;border-radius:6px;padding:7px 11px;font-size:12px;outline:none;}
input.field:focus{border-color:#E8006E;}
select.field{background:#161616;color:#ccc;border:1px solid #2a2a2a;border-radius:6px;padding:7px 11px;font-size:12px;outline:none;}
.alert-success{background:rgba(48,209,88,.1);border:1px solid rgba(48,209,88,.2);color:#30d158;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:16px;}
.alert-error{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);color:#ff6b6b;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:16px;}
.log-line{font-family:monospace;font-size:11px;color:#555;padding:4px 0;border-bottom:1px solid #0a0a0a;display:flex;gap:10px;}
.log-line .ts{color:#333;min-width:90px;}
.log-line .user{color:#E8006E;min-width:80px;}
.log-line .msg{color:#666;}
</style></head>
<body>
<div class="header">
  <div class="header-left"><div class="dot"></div><span class="title">CONTROL ROOM Â· ADMINISTRATION</span></div>
  <div style="display:flex;gap:8px;align-items:center;">
    <span style="font-size:11px;color:#444;">ConnectÃ© : <b style="color:#ccc">${session.login}</b></span>
    <a href="/dashboard" style="color:#E8006E;font-size:11px;text-decoration:none;">â Dashboard</a>
    <a href="/logout" class="btn btn-dark" style="font-size:11px;">DÃ©connexion</a>
  </div>
</div>
<div class="nav">
  <a href="/admin" class="active">Vue d'ensemble</a>
  <a href="/admin/users">Utilisateurs</a>
  <a href="/admin/webhook">Webhook INO</a>
  <a href="/admin/sessions">Sessions actives</a>
  <a href="/admin/logs">Logs d'accÃ¨s</a>
</div>
<div class="content">
  <div class="grid">
    <div class="card"><div class="card-label">Sessions actives</div><div class="card-value green" id="a-sessions">â</div><div class="card-sub">Utilisateurs connectÃ©s</div></div>
    <div class="card"><div class="card-label">Clients SSE</div><div class="card-value" id="a-sse">â</div><div class="card-sub">Dashboards ouverts</div></div>
    <div class="card"><div class="card-label">Utilisateurs configurÃ©s</div><div class="card-value pink" id="a-users">â</div><div class="card-sub">Comptes actifs</div></div>
    <div class="card"><div class="card-label">Dernier appel INO</div><div class="card-value" id="a-last">â</div><div class="card-sub" id="a-last-sub">â</div></div>
  </div>

  <div class="panel">
    <div class="panel-header"><span class="panel-title">Statut des services</span></div>
    <div class="panel-body">
      <table><thead><tr><th>Service</th><th>Statut</th><th>DÃ©tail</th></tr></thead>
      <tbody id="services-table">
        <tr><td>Serveur Node.js</td><td><span class="badge badge-green">â En ligne</span></td><td style="color:#555">PORT ${PORT}</td></tr>
        <tr><td>API INO</td><td id="ino-status"><span class="badge badge-gray">VÃ©rificationâ¦</span></td><td id="ino-detail" style="color:#555">â</td></tr>
        <tr><td>SSE (temps rÃ©el)</td><td><span class="badge badge-green">â Actif</span></td><td id="sse-detail" style="color:#555">â</td></tr>
        <tr><td>Webhook INO</td><td><span class="badge badge-green">â ConfigurÃ©</span></td><td style="color:#555">https://control-room-production-a320.up.railway.app/webhook</td></tr>
      </tbody></table>
    </div>
  </div>

  <div class="panel">
    <div class="panel-header"><span class="panel-title">Statistiques INO du jour</span></div>
    <div class="panel-body">
      <table><thead><tr><th>Indicateur</th><th>Valeur</th></tr></thead>
      <tbody id="stats-table"><tr><td colspan="2" style="color:#444;text-align:center">Chargementâ¦</td></tr></tbody>
    </div>
  </div>
</div>

<script>
async function loadAdmin(){
  try{
    const r=await fetch('/api/admin/stats');
    const d=await r.json();
    document.getElementById('a-sessions').textContent=d.sessions||0;
    document.getElementById('a-sse').textContent=d.sseClients||0;
    document.getElementById('a-users').textContent=d.usersCount||0;
    if(d.lastEvent){
      document.getElementById('a-last').textContent=d.stats?.totalAppels||'â';
      document.getElementById('a-last-sub').textContent='MAJ '+new Date(d.lastEvent).toLocaleTimeString('fr-FR');
    }
    document.getElementById('ino-status').innerHTML=d.inoOk?'<span class="badge badge-green">â ConnectÃ©</span>':'<span class="badge badge-pink">â Erreur</span>';
    document.getElementById('ino-detail').textContent=d.inoToken?'Token actif':'Pas de token';
    document.getElementById('sse-detail').textContent=d.sseClients+' client(s) connectÃ©(s)';
    if(d.stats){
      const mm=s=>{const m=Math.floor(s/60);return String(m).padStart(2,'0')+':'+String(Math.round(s%60)).padStart(2,'0');};
      document.getElementById('stats-table').innerHTML=`
        <tr><td>Appels traitÃ©s</td><td style="font-weight:700;color:#E8006E">${d.stats.totalAppels}</td></tr>
        <tr><td>DurÃ©e totale</td><td>${mm(d.stats.totalDuree)}</td></tr>
        <tr><td>DMC moyenne</td><td>${mm(d.stats.dmc||0)}</td></tr>
        <tr><td>DerniÃ¨re MAJ</td><td style="color:#555">${d.stats.updatedAt?new Date(d.stats.updatedAt).toLocaleString('fr-FR'):'â'}</td></tr>
      `;
    }
  }catch(e){console.error(e);}
}
loadAdmin();
setInterval(loadAdmin,30000);
</script>
</body></html>`;

const server=http.createServer(async(req,res)=>{
  secHeaders(res);
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Credentials","true");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  if(req.method==="OPTIONS"){res.writeHead(204);return res.end();}
  const cookies=parseCookies(req);
  const session=getSession(cookies.session);
  const url=req.url.split("?")[0];
  const ip=req.headers["x-forwarded-for"]||req.socket.remoteAddress||"unknown";

  // ââ Login ââ
  if(url==="/login"&&req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeLogin());}
  if(url==="/login"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      if(isRateLimited(ip)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeLogin(true,true));}
      const p=new URLSearchParams(body);
      const login=(p.get("login")||"").toLowerCase().trim();
      const pwd=p.get("password")||"";
      if(USERS[login]&&USERS[login]===pwd){
        const{pt}=createPending(login);
        setCookie(res,"pending",pt,PTTL/1000);
        res.writeHead(302,{Location:"/verify-code"});
        console.log(`[AUTH] Login OK: ${login} (${ip})`);
      }else{
        recordAttempt(ip);
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeLogin(true));
        console.log(`[AUTH] Ãchec: ${login} (${ip})`);
      }
      res.end();
    });return;
  }
  if(url==="/verify-code"&&req.method==="GET"){const ps=getPending(cookies.pending);if(!ps){res.writeHead(302,{Location:"/login"});return res.end();}res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeCode());}
  if(url==="/verify-code"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{
      const ps=getPending(cookies.pending);
      if(!ps){res.writeHead(302,{Location:"/login"});return res.end();}
      const p=new URLSearchParams(body);
      const code=(p.get("code")||"").trim();
      if(code===SECURITY_CODE){
        delete pending[cookies.pending];
        setCookie(res,"pending","",0);
        const st=createSession(ps.login,ps.login==="admin"?"admin":"user");
        setCookie(res,"session",st);
        res.writeHead(302,{Location:"/"});
        console.log(`[AUTH] AccÃ¨s: ${ps.login} (${ip})`);
      }else{
        res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});
        res.end(makeCode(true));
        console.log(`[AUTH] Code KO: ${ps.login} (${ip})`);
      }
      res.end();
    });return;
  }
  if(url==="/logout"){if(cookies.session)delete sessions[cookies.session];if(cookies.pending)delete pending[cookies.pending];setCookie(res,"session","",0);setCookie(res,"pending","",0);res.writeHead(302,{Location:"/login"});return res.end();}
  if(url==="/webhook"&&req.method==="POST"){
    let body="";req.on("data",c=>body+=c);
    req.on("end",()=>{try{const p=JSON.parse(body);lastPayload=p;const m=`data: ${JSON.stringify(p)}\n\n`;sseClients.forEach(c=>{try{c.write(m);}catch{}});sseClients=sseClients.filter(c=>!c.destroyed);res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));}catch(e){res.writeHead(400);res.end(JSON.stringify({error:"JSON invalide"}));}});return;
  }

  // ââ Session requise ââ
  // Routes publiques qui ne nécessitent pas d'auth
  if(url==="/health"&&req.method==="GET"){
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({status:"ok",sseClients:sseClients.length,inoToken:!!bearerToken,lastEvent:lastPayload?.horodatage||null,uptime:Math.round(process.uptime()),version:"2.1"}));
  }
  if(url==="/api/status"){
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({ok:true,sseClients:sseClients.length,inoConnected:!!bearerToken,lastUpdate:lastPayload?.horodatage||null,stats:{appels:statsCache?.totalAppels||0,dmc:Math.round(statsCache?.dmc||0)}}));
  }
  if(!session){res.writeHead(302,{Location:"/login"});return res.end();}

  // ââ API ââ
  if(url==="/api/admin/stats"){
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({
      sessions:Object.keys(sessions).length,
      sseClients:sseClients.length,
      usersCount:Object.keys(USERS).length,
      lastEvent:lastPayload?.horodatage||null,
      inoOk:!!bearerToken&&Date.now()<tokenExp,
      inoToken:!!bearerToken,
      stats:statsCache,
      uptime:process.uptime(),
      user:session.login
    }));
  }
  if(url==="/api/stats"){res.writeHead(200,{"Content-Type":"application/json"});return res.end(JSON.stringify({...statsCache,sseClients:sseClients.length}));}
  if(url==="/events"){res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache","Connection":"keep-alive"});res.write(": connected\n\n");if(lastPayload)res.write(`data: ${JSON.stringify(lastPayload)}\n\n`);sseClients.push(res);req.on("close",()=>{sseClients=sseClients.filter(c=>c!==res);});return;}
  if(url==="/agents-day"){const u=new URL(req.url,`http://localhost`);const date=u.searchParams.get("date")||new Date().toISOString().slice(0,10);fetchAgentsDay(date).then(agents=>{res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({agents,date,count:agents.length}));}).catch(e=>{res.writeHead(500);res.end(JSON.stringify({error:e.message}));});return;}
  if(url==="/health"){ /* handled above */ return; }
  
  // ââ Admin panel ââ
  if(url==="/admin"||url.startsWith("/admin/")){
    if(session.login!=="admin"&&session.login!=="tarik"){res.writeHead(403,{"Content-Type":"text/html;charset=utf-8"});return res.end('<html><body style="background:#080808;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center"><div><h1 style="color:#E8006E;font-size:60px">403</h1><p style="color:#555">AccÃ¨s refusÃ©.</p><a href="/" style="color:#E8006E">â Retour</a></div></body></html>');}
    res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return res.end(makeAdmin(session));
  }
  
  // ââ Fichiers statiques ââ
  if(url==="/"||url==="/dashboard"){const p=path.join(__dirname,"dashboard.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
  if(url==="/agents-jour"){const p=path.join(__dirname,"agents_jour.html");if(fs.existsSync(p)){res.writeHead(200,{"Content-Type":"text/html;charset=utf-8"});return fs.createReadStream(p).pipe(res);}}
  
  // ââ 404 ââ
  res.writeHead(404,{"Content-Type":"text/html;charset=utf-8"});res.end(make404());
});

fetchDayStats();
setInterval(fetchDayStats,30000);
setInterval(()=>{const now=Date.now();Object.keys(sessions).forEach(k=>{if(now>sessions[k].expires)delete sessions[k];});Object.keys(pending).forEach(k=>{if(now>pending[k].expires)delete pending[k];});},60000);

server.listen(PORT,()=>{
  console.log("ââââââââââââââââââââââââââââââââââââââ");
  console.log(`  Wisecom Control Room v2.0 â SaaS`);
  console.log(`  Port    : ${PORT}`);
  console.log(`  Users   : ${Object.keys(USERS).join(", ")}`);
  console.log(`  Admin   : /admin (tarik, admin)`);
  console.log(`  2FA     : activÃ© (${SECURITY_CODE})`);
  console.log("ââââââââââââââââââââââââââââââââââââââ");
});