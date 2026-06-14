/* ───────────────────────────────────────────────────────────
   Wisecom Control Room — bascule de thème partagée (clair / sombre)
   Inclure sur chaque page :  <script src="/theme.js" defer></script>
   - Mode CLAIR par défaut
   - Mémorise le choix dans localStorage ('wcr-theme')
   - Ajoute/retire la classe body.light
   - Injecte un bouton flottant bien visible sur toutes les pages
   Les styles body.light sont définis dans chaque page.
   ─────────────────────────────────────────────────────────── */
(function(){
  var KEY = 'wcr-theme';
  /* Défaut = clair */
  function current(){ try{ return localStorage.getItem(KEY)||'light'; }catch(e){ return 'light'; } }
  function paintBtn(m){
    var b=document.getElementById('wcr-theme-btn');
    if(b) b.innerHTML = (m==='light')
      ? '<span style="font-size:14px">🌙</span> Passer en sombre'
      : '<span style="font-size:14px">☀️</span> Passer en clair';
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
        '.wcr-theme-btn{position:fixed;right:18px;bottom:18px;z-index:99999;'+
        'display:inline-flex;align-items:center;gap:7px;cursor:pointer;'+
        'font:700 12.5px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.01em;'+
        'padding:11px 17px;border-radius:24px;border:1.5px solid #E8006E;'+
        'background:#E8006E;color:#fff;box-shadow:0 6px 22px rgba(232,0,110,.45);'+
        'transition:all .18s;user-select:none;white-space:nowrap;}'+
        '.wcr-theme-btn:hover{background:#c2005a;border-color:#c2005a;'+
        'transform:translateY(-1px);box-shadow:0 8px 26px rgba(232,0,110,.55);}'+
        '@media(max-width:600px){.wcr-theme-btn{right:12px;bottom:12px;padding:10px 14px;font-size:11.5px;}}';
      document.head.appendChild(st);
      var btn=document.createElement('button');
      btn.id='wcr-theme-btn'; btn.type='button'; btn.className='wcr-theme-btn';
      btn.setAttribute('aria-label','Basculer le thème clair ou sombre');
      btn.setAttribute('title','Basculer entre le mode clair et le mode sombre');
      btn.addEventListener('click', window.wcrToggleTheme);
      document.body.appendChild(btn);
    }
    apply(current());
  }
  if(document.readyState!=='loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
