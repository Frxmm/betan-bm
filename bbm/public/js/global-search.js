import { api } from './api.js'

const STATUS_COLOR = {
  confirmed:   { bg: '#1a2e4a', color: '#60a5fa' },
  checked_in:  { bg: '#0d2e1c', color: '#4ade80' },
  checked_out: { bg: '#1a1a1a', color: '#94a3b8' },
  cancelled:   { bg: '#2e0f0f', color: '#f87171' },
  no_show:     { bg: '#2e1f4a', color: '#c084fc' },
  tentative:   { bg: '#2e2200', color: '#fbbf24' },
}
const STATUS_LABEL = {
  confirmed:   'Confirmada',
  checked_in:  'En casa',
  checked_out: 'Salió',
  cancelled:   'Cancelada',
  no_show:     'No-show',
  tentative:   'Tentativa',
}

function fmt(dateStr) {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${String(y).slice(2)}`
}

let debounceTimer = null
let focusedIndex  = -1
let currentItems  = []

const input    = document.getElementById('gsearch-input')
const dropdown = document.getElementById('gsearch-dropdown')

function open()  { dropdown.hidden = false }
function close() { dropdown.hidden = true; focusedIndex = -1 }

function renderItems(items) {
  currentItems = items
  focusedIndex = -1

  if (!items.length) {
    dropdown.innerHTML = '<div class="gsearch-empty">Sin resultados</div>'
    open()
    return
  }

  dropdown.innerHTML = items.map((r, i) => {
    const guest  = r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : '—'
    const room   = r.room?.code ?? '—'
    const dates  = `${fmt(r.checkInDate)} → ${fmt(r.checkOutDate)}`
    const st     = STATUS_COLOR[r.status] ?? { bg: '#222', color: '#aaa' }
    const label  = STATUS_LABEL[r.status] ?? r.status
    const code   = r.externalCode ? `<span style="color:var(--text2);font-size:11px">#${r.externalCode}</span>` : ''

    return `
      <div class="gsearch-item" data-idx="${i}" onclick="window._gsOpen(${r.id})">
        <span class="gsearch-room">${room}</span>
        <span class="gsearch-guest">${escHtml(guest)} ${code}</span>
        <span class="gsearch-meta">${dates} · ${r.nights}n</span>
        <span class="gsearch-status" style="background:${st.bg};color:${st.color}">${label}</span>
      </div>`
  }).join('')

  open()
}

function setFocus(idx) {
  const items = dropdown.querySelectorAll('.gsearch-item')
  items.forEach(el => el.classList.remove('focused'))
  if (idx >= 0 && idx < items.length) {
    items[idx].classList.add('focused')
    items[idx].scrollIntoView({ block: 'nearest' })
  }
  focusedIndex = idx
}

input.addEventListener('input', () => {
  const q = input.value.trim()
  clearTimeout(debounceTimer)

  if (!q) { close(); return }

  dropdown.innerHTML = '<div class="gsearch-loading">Buscando…</div>'
  open()

  debounceTimer = setTimeout(async () => {
    try {
      const { data } = await api.searchReservations(q)
      renderItems(data)
    } catch {
      dropdown.innerHTML = '<div class="gsearch-empty">Error al buscar</div>'
    }
  }, 220)
})

input.addEventListener('keydown', (e) => {
  const items = currentItems
  if (!items.length || dropdown.hidden) return

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setFocus(Math.min(focusedIndex + 1, items.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    setFocus(Math.max(focusedIndex - 1, 0))
  } else if (e.key === 'Enter' && focusedIndex >= 0) {
    e.preventDefault()
    window._gsOpen(items[focusedIndex].id)
  } else if (e.key === 'Escape') {
    close()
    input.blur()
  }
})

input.addEventListener('focus', () => {
  if (input.value.trim() && currentItems.length) open()
})

document.addEventListener('mousedown', (e) => {
  if (!document.getElementById('gsearch-wrap').contains(e.target)) close()
})

window._gsOpen = function(reservationId) {
  close()
  input.value = ''
  currentItems = []
  window.goTo('reservation', reservationId)
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}
