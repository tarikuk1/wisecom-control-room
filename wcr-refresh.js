/* Bascule REFONTE UI/UX (design client) — réversible, mémorisée, partagée par toutes les pages.
   Activée par défaut. Ajoute/retire la classe .wcr-refresh sur <body>. */
(function(){
  var K='wcr-refresh-on';
  function apply(){ if(localStorage.getItem(K)!=='0') document.body.classList.add('wcr-refresh'); else document.body.classList.remove('wcr-refresh'); paint(); }
  function paint(){ var b=document.getElementById('wcr-refresh-btn'); if(b) b.style.color=document.body.classList.contains('wcr-refresh')?'#E8006E':''; }
  window.wcrToggleRefresh=function(){ var on=document.body.classList.toggle('wcr-refresh'); try{localStorage.setItem(K,on?'1':'0');}catch(e){} paint(); };
  if(document.body) apply();
  else document.addEventListener('DOMContentLoaded',apply);
})();
