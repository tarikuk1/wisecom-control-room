/* ───────────────────────────────────────────────────────────
   Wisecom Control Room — bascule de thème partagée (clair / sombre)
   Inclure sur chaque page :  <script src="/theme.js" defer></script>
   - Mémorise le choix dans localStorage ('wcr-theme')
   - Ajoute/retire la classe body.light
   - Injecte un bouton flottant cohérent sur toutes les pages
   Les styles body.light sont définis dans chaque page.
   ─────────────────────────────────────────────────────────── */
(function(){
  var KEY = 'wcr-theme';
  function current(){ try{ return localStorage.getItem(KEY)||'dark'; }catch(e){ return 'dark'; } }
  function paintBtn(m){
    var b=document.getElementById('wcr-theme-btn');
    if(b) b.innerHTML = (m==='light') ? '☀ Clair' : '◑ Sombre';
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
        '.wcr-theme-btn{position:fixed;right:16px;bottom:16px;z-index:9000;'+
        'display:inline-flex;align-items:center;gap:6px;cursor:pointer;'+
        'font:600 12px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.01em;'+
        'padding:9px 14px;border-radius:22px;border:1px solid #2c2c2c;'+
        'background:#1a1a1a;color:#cfcfcf;box-shadow:0 4px 18px rgba(0,0,0,.45);'+
        'transition:all .18s;user-select:none;}'+
        '.wcr-theme-btn:hover{border-color:#E8006E;color:#fff;'+
        'box-shadow:0 4px 18px rgba(232,0,110,.35);}'+
        'body.light .wcr-theme-btn{background:#fff;color:#444;border-color:#d8d8e0;'+
        'box-shadow:0 4px 18px rgba(0,0,0,.12);}'+
        'body.light .wcr-theme-btn:hover{border-color:#E8006E;color:#E8006E;}';
      document.head.appendChild(st);
      var btn=document.createElement('button');
      btn.id='wcr-theme-btn'; btn.type='button'; btn.className='wcr-theme-btn';
      btn.setAttribute('aria-label','Basculer le thème clair ou sombre');
      btn.addEventListener('click', window.wcrToggleTheme);
      document.body.appendChild(btn);
    }
    apply(current());
  }
  if(document.readyState!=='loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();
