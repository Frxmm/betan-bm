/* Aviso de cookies de betanbm.com.
 * - Sin cookies publicitarias ni de terceros. Solo guardamos en el navegador (localStorage):
 *   `betan-theme` (tema claro/oscuro) y `betan-consent` (tu elección aquí).
 * - La medición de visitas es propia, sin cookies y sin IP, y solo se activa si pulsas «Aceptar».
 * - «Rechazar» tiene el mismo peso que «Aceptar». Se puede cambiar desde «Preferencias de cookies».
 */
(function () {
  var KEY = 'betan-consent', VERSION = 1;
  var doc = document;
  window.betanTrack = window.betanTrack || function () {};   // no-op hasta que haya consentimiento

  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      return v && v.v === VERSION ? v : null;
    } catch (e) { return null; }
  }
  function write(analytics) {
    try { localStorage.setItem(KEY, JSON.stringify({ v: VERSION, analytics: !!analytics, ts: new Date().toISOString() })); } catch (e) {}
  }

  function loadTracker() {
    if (window.__betanTrack || doc.getElementById('bt-js')) return;
    var s = doc.createElement('script'); s.id = 'bt-js'; s.src = '/assets/track.js'; s.defer = true; doc.head.appendChild(s);
  }
  function stopTracker() { try { window.betanTrackStop && window.betanTrackStop(); } catch (e) {} }

  function hit() {
    try {
      var body = JSON.stringify({ path: location.pathname, ref: doc.referrer || '' });
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon('/api/hit', new Blob([body], { type: 'application/json' }))) return;
      }
      fetch('/api/hit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
    } catch (e) {}
  }

  var css =
    '#cc{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:560px;margin:0 auto;padding:18px 20px;border-radius:14px;' +
    'background:var(--surface,#fff);color:var(--ink,#0f2a43);border:1px solid var(--line,#d3dce5);box-shadow:0 10px 40px rgba(0,0,0,.25);' +
    'font:400 .95rem/1.5 var(--body,system-ui,sans-serif)}' +
    '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) #cc{background:#122437;color:#e8eef5;border-color:#24405b}}' +
    ':root[data-theme="dark"] #cc{background:#122437;color:#e8eef5;border-color:#24405b}' +
    '#cc h2{margin:0 0 6px;font:700 1.05rem var(--body,system-ui,sans-serif)}#cc p{margin:0 0 12px;color:inherit;opacity:.85}' +
    '#cc a{color:inherit;text-decoration:underline}#cc .cc-b{display:flex;gap:10px;flex-wrap:wrap}' +
    '#cc button{flex:1 1 140px;min-height:44px;padding:0 18px;border-radius:99px;font:700 .95rem var(--body,system-ui,sans-serif);cursor:pointer;' +
    'border:2px solid currentColor;background:transparent;color:inherit}' +
    '#cc button:hover,#cc button:focus-visible{background:#1f4fd8;border-color:#1f4fd8;color:#fff;outline:none}' +
    '.cc-link{background:none;border:0;padding:0;font:inherit;color:inherit;text-decoration:underline;cursor:pointer}';

  function banner() {
    if (doc.getElementById('cc')) return;
    var st = doc.createElement('style'); st.textContent = css; doc.head.appendChild(st);
    var d = doc.createElement('div');
    d.id = 'cc'; d.setAttribute('role', 'dialog'); d.setAttribute('aria-live', 'polite'); d.setAttribute('aria-label', 'Aviso de cookies');
    d.innerHTML =
      '<h2>Tu privacidad</h2>' +
      '<p>No usamos cookies publicitarias ni de terceros. Si lo permites, medimos cómo se usa la web (páginas, clics, secciones vistas, scroll y tiempo) con una analítica propia, ' +
      'sin cookies, sin guardar tu IP y sin registrar lo que escribes, para mejorarla. Puedes cambiarlo cuando quieras. <a href="/legal#cookies">Más información</a>.</p>' +
      '<div class="cc-b"><button type="button" data-a="no">Rechazar</button><button type="button" data-a="yes">Aceptar</button></div>';
    d.addEventListener('click', function (e) {
      var a = e.target && e.target.getAttribute && e.target.getAttribute('data-a');
      if (!a) return;
      write(a === 'yes');
      d.remove();
      if (a === 'yes') { hit(); loadTracker(); } else stopTracker();
    });
    doc.body.appendChild(d);
  }

  var c = read();
  if (!c) { if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', banner); else banner(); }
  else if (c.analytics) { hit(); loadTracker(); }

  // Enlaces «Preferencias de cookies» (cualquier elemento con data-cookie-prefs).
  doc.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-cookie-prefs]') : null;
    if (!t) return;
    e.preventDefault();
    try { localStorage.removeItem(KEY); } catch (err) {}
    stopTracker();
    banner();
  });
})();
