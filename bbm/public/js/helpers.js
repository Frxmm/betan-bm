// Utilidades de UI reutilizables

export function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function fmtMoney(n, currency = 'EUR') {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-ES', { style: 'currency', currency })
}

export const STATUS_LABEL = {
  tentative:   'Tentativa',
  confirmed:   'Confirmada',
  checked_in:  'En casa',
  checked_out: 'Saliendo',
  cancelled:   'Cancelada',
  no_show:     'No show',
}

export function badge(status) {
  return `<span class="badge badge-${status}">${STATUS_LABEL[status] ?? status}</span>`
}

export function loading() {
  return `<div class="loading">Cargando…</div>`
}

export function empty(msg = 'Sin resultados') {
  return `<div class="empty"><div class="icon">📭</div><p>${msg}</p></div>`
}

export function showToast(msg, type = 'ok') {
  const t = document.createElement('div')
  t.textContent = msg
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    background: type === 'ok' ? '#22c55e' : '#ef4444',
    color: '#fff', padding: '10px 18px', borderRadius: '8px',
    fontSize: '13px', fontWeight: '500', zIndex: '9999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
    transition: 'opacity 0.3s',
  })
  document.body.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300) }, 2500)
}

export function modal(title, bodyHtml, footerHtml = '', opts = {}) {
  const el = document.createElement('div')
  el.className = 'modal-backdrop'
  el.innerHTML = `
    <div class="modal${opts.wide ? ' modal-wide' : ''}">
      <div class="modal-header">
        <h2>${title}</h2>
        <button class="modal-close" data-close>✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      ${footerHtml ? `<div class="modal-footer">${footerHtml}</div>` : ''}
    </div>`
  el.querySelectorAll('[data-close]').forEach(b => b.onclick = () => el.remove())
  el.onclick = (e) => { if (e.target === el) el.remove() }
  document.body.appendChild(el)
  return el
}
