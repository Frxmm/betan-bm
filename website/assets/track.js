/* Medición de interacciones de betanbm.com — SOLO se carga si el visitante aceptó el aviso de cookies.
 * Anónima: sin cookies, sin IP, sin identificador entre visitas. Cada carga de página genera un id
 * aleatorio (`vid`) que solo sirve para agrupar los eventos de esa visita.
 * Nunca se envía lo que el usuario escribe: del formulario solo se registra QUÉ campos se completan
 * (su nombre, no su contenido) y en qué paso se abandona.
 */
(function () {
  if (window.__betanTrack) return;
  window.__betanTrack = true;

  var doc = document, win = window, q = [], sent = 0, stopped = false, MAX_PER_VISIT = 400;
  var vid = (win.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Math.random()).slice(2) + String(Date.now());
  var t0 = Date.now();
  var dev = win.innerWidth < 640 ? 'm' : win.innerWidth < 1024 ? 't' : 'd';
  var ref = ''; try { ref = doc.referrer ? new URL(doc.referrer).hostname : ''; } catch (e) {}
  if (/(^|\.)betanbm\.com$/.test(ref)) ref = '';
  try { var u = new URLSearchParams(location.search).get('utm_source'); if (u) ref = 'utm:' + u.slice(0, 40); } catch (e) {}

  function track(type, target, label, value) {
    if (stopped || sent + q.length >= MAX_PER_VISIT) return;
    var e = { t: type };
    if (target) e.g = String(target).slice(0, 80);
    if (label) e.l = String(label).replace(/\s+/g, ' ').trim().slice(0, 60);
    if (typeof value === 'number' && isFinite(value)) e.v = Math.round(value * 100) / 100;
    q.push(e);
    if (q.length >= 15) flush();
  }

  function flush() {
    if (!q.length) return;
    var batch = q.splice(0, 30); sent += batch.length;
    var body = JSON.stringify({ vid: vid, path: location.pathname, dev: dev, ref: ref, events: batch });
    try {
      if (!(navigator.sendBeacon && navigator.sendBeacon('/api/events', new Blob([body], { type: 'application/json' })))) {
        fetch('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true });
      }
    } catch (e) {}
  }
  var timer = setInterval(flush, 5000);

  function stop() { stopped = true; q.length = 0; clearInterval(timer); }
  win.betanTrackStop = stop;
  win.betanTrack = track;

  // ── Visita ────────────────────────────────────────────────────────────────
  track('view', location.pathname, doc.title, win.innerWidth);

  // ── Clics: enlaces, botones, resúmenes de FAQ (sin tocar inputs ni textos del usuario) ──
  function classify(el) {
    var tag = el.tagName, label = (el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50);
    var dt = el.getAttribute('data-track');
    if (dt) return [dt, label];
    var where = el.closest('nav,header') ? 'nav' : el.closest('footer') ? 'footer' : el.classList.contains('btn') ? 'cta' : 'link';
    if (tag === 'A') {
      var h = el.getAttribute('href') || '';
      if (h.charAt(0) === '#') return [where + ':anchor:' + (h === '#' ? '(prefs)' : h), label];
      if (/^mailto:/i.test(h)) return ['contact:mailto', label];
      if (/^tel:/i.test(h)) return ['contact:tel', label];
      if (/wa\.me|whatsapp/i.test(h)) return ['contact:whatsapp', label];
      try {
        var url = new URL(h, location.href);
        if (url.origin !== location.origin) return [where + ':outbound:' + url.hostname, label];
        return [where + ':link:' + url.pathname + (url.hash || ''), label];
      } catch (e) { return [where + ':link', label]; }
    }
    if (tag === 'SUMMARY') return null;               // se mide con 'toggle'
    return [where + ':button:' + (el.id || 'btn'), label];
  }
  doc.addEventListener('click', function (ev) {
    var el = ev.target && ev.target.closest ? ev.target.closest('a,button,[data-track]') : null;
    if (!el || el.closest('#cc')) return;               // el propio aviso de cookies no se mide
    var c = classify(el);
    if (c) track('click', c[0], c[1]);
    var plan = el.getAttribute && el.getAttribute('data-plan');
    if (plan) track('click', 'plan:' + plan, '');
    if (el.id === 'theme') track('theme', 'toggle', '');
  }, true);

  doc.addEventListener('toggle', function (ev) {
    var d = ev.target;
    if (d && d.tagName === 'DETAILS') {
      var s = d.querySelector('summary');
      track('faq', d.open ? 'open' : 'close', s ? s.textContent : '');
    }
  }, true);

  // ── Secciones vistas (una vez por visita) ─────────────────────────────────
  if ('IntersectionObserver' in win) {
    var seen = {};
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        var id = e.target.id;
        if (e.isIntersecting && !seen[id]) { seen[id] = 1; track('section', id, '', Date.now() - t0); io.unobserve(e.target); }
      });
    }, { threshold: 0.35 });
    var ready = function () { doc.querySelectorAll('main section[id], main h2[id], article h2[id], #contacto').forEach(function (s) { io.observe(s); }); };
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', ready); else ready();
  }

  // ── Profundidad de scroll ─────────────────────────────────────────────────
  var marks = { 25: 0, 50: 0, 75: 0, 100: 0 }, ticking = false;
  function depth() {
    ticking = false;
    var h = doc.documentElement, total = h.scrollHeight - win.innerHeight;
    if (total <= 0) return;
    var pct = Math.min(100, Math.round(((win.scrollY || h.scrollTop) / total) * 100));
    [25, 50, 75, 100].forEach(function (m) { if (pct >= m - (m === 100 ? 2 : 0) && !marks[m]) { marks[m] = 1; track('scroll', String(m), '', Date.now() - t0); } });
  }
  win.addEventListener('scroll', function () { if (!ticking) { ticking = true; requestAnimationFrame(depth); } }, { passive: true });

  // ── Tiempo activo (solo con la pestaña visible) ───────────────────────────
  var active = 0, since = doc.visibilityState === 'visible' ? Date.now() : 0, timeSent = false;
  function pause() { if (since) { active += Date.now() - since; since = 0; } }
  function sendTime() { pause(); if (active > 1000) track('time', 'active_s', '', active / 1000); active = 0; }
  doc.addEventListener('visibilitychange', function () {
    if (doc.visibilityState === 'hidden') { sendTime(); flush(); } else since = Date.now();
  });

  // ── Formulario: embudo sin contenido ──────────────────────────────────────
  var formStarted = false, formDone = false, filled = {};
  var form = doc.getElementById('form') || doc.getElementById('docform');
  if (form) {
    var fname = form.id;
    form.addEventListener('focusin', function (e) {
      if (!formStarted && e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) { formStarted = true; track('form', fname + ':start', e.target.name || e.target.id || ''); }
    });
    form.addEventListener('change', function (e) {
      var n = e.target && (e.target.name || e.target.id); if (!n || n === 'website') return;
      var has = e.target.type === 'checkbox' ? e.target.checked : !!String(e.target.value || '').trim();
      if (has && !filled[n]) { filled[n] = 1; track('form', fname + ':field', n); }
    });
    doc.addEventListener('betan:form', function (e) { var d = String(e.detail || ''); if (d === 'success') formDone = true; track('form', fname + ':' + d.split(':')[0], d.split(':')[1] || ''); });
    form.addEventListener('submit', function () { track('form', fname + ':submit'); });
  }

  // ── Errores de JavaScript (para detectar fallos reales de la web) ─────────
  var errs = 0;
  win.addEventListener('error', function (e) { if (errs++ < 3) track('error', 'js', (e.filename ? e.filename.split('/').pop() : '') + ':' + (e.lineno || 0)); });

  win.addEventListener('pagehide', function () {
    if (formStarted && !formDone) track('form', fname_() + ':abandon', '', Object.keys(filled).length);
    sendTime(); flush();
  });
  function fname_() { return form ? form.id : 'form'; }
})();
