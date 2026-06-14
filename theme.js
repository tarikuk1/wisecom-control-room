/* ───────────────────────────────────────────────────────────
   Wisecom Control Room — bascule de thème partagée (clair / sombre)
   Inclure sur chaque page :  <script src="/theme.js" defer></script>
   - Mode CLAIR par défaut
   - Mémorise le choix dans localStorage ('wcr-theme')
   - Ajoute/retire la classe body.light
   - Injecte un bouton dans la zone de navigation (en-tête) ou en fixe haut-droite
   Les styles body.light sont définis dans chaque page.
   ─────────────────────────────────────────────────────────── */
(function(){
  var KEY = 'wcr-theme';
  /* Défaut = clair */
  function current(){ try{ return localStorage.getItem(KEY)||'light'; }catch(e){ return 'light'; } }
  function paintBtn(m){
    var b=document.getElementById('wcr-theme-btn');
    if(b) b.innerHTML = (m==='light')
      ? '<span style="font-size:13px">🌙</span> Sombre'
      : '<span style="font-size:13px">☀️</span> Clair';
  }
  function apply(m){ document.body.classList.toggle('light', m==='light'); paintBtn(m); }
  window.wcrToggleTheme=function(){
    var m = current()==='light' ? 'dark' : 'light';
    try{ localStorage.setItem(KEY,m); }catch(e){}
    apply(m);
  };
  function init(){
    if(!document.getElementById('wcr-theme-btn')){
      var st=document.createElement('style');
      st.textContent =
        '.wcr-theme-btn{display:inline-flex;align-items:center;gap:5px;cursor:pointer;'+
        'font:700 11px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.01em;'+
        'padding:5px 12px;border-radius:20px;border:1.5px solid #E8006E;'+
        'background:#E8006E;color:#fff;box-shadow:0 2px 8px rgba(232,0,110,.35);'+
        'transition:all .18s;user-select:none;white-space:nowrap;flex-shrink:0;}'+
        '.wcr-theme-btn:hover{background:#c2005a;border-color:#c2005a;box-shadow:0 4px 14px rgba(232,0,110,.5);}'+
        '.wcr-theme-btn.wcr-float{position:fixed;top:10px;right:18px;z-index:99999;}'+
        '@media(max-width:600px){.wcr-theme-btn{padding:4px 9px;font-size:10px;}}'+
        '@media(max-width:600px){.wcr-theme-btn.wcr-float{right:10px;top:8px;}}';
      document.head.appendChild(st);
      var btn=document.createElement('button');
      btn.id='wcr-theme-btn'; btn.type='button'; btn.className='wcr-theme-btn';
      btn.setAttribute('aria-label','Basculer le thème clair ou sombre');
      btn.setAttribute('title','Basculer entre le mode clair et le mode sombre');
      btn.addEventListener('click', window.wcrToggleTheme);
      /* Injection dans la zone d'en-tête : topbar-right (dashboard) en premier,
         puis div droite du .header (autres pages), sinon fixe haut-droite */
      var container = document.querySelector('.topbar-right')
                   || document.querySelector('.header > div:last-child');
      if(container){
        container.appendChild(btn);
      } else {
        btn.classList.add('wcr-float');
        document.body.appendChild(btn);
      }
    }
    apply(current());
  }
  if(document.readyState!=='loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
