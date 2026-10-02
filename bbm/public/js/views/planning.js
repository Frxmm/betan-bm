import { api } from '../api.js'
import { loading, empty, showToast, modal } from '../helpers.js'

const CELL_W = 46  // px por día

function toISO(d) { return d.toISOString().slice(0, 10) }

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return toISO(d)
}

function getDays(from, to) {
  const days = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to   + 'T12:00:00')
  while (cur <= end) { days.push(toISO(cur)); cur.setDate(cur.getDate() + 1) }
  return days
}

const STATUS_COLOR = {
  confirmed:   '#4f7cff',
  checked_in:  '#22c55e',
  checked_out: '#6b7280',
  cancelled:   '#ef4444',
  no_show:     '#a855f7',  // morado — distinguible del resto
  tentative:   '#f59e0b',
}

const STATUS_LABEL = {
  confirmed:   'Confirmada',
  checked_in:  'En casa',
  checked_out: 'Saliendo',
  cancelled:   'Cancelada',
  no_show:     'No show',
  tentative:   'Tentativa',
}

let _from, _to, _numDays

// Calcula cuántos días caben en el ancho visible del gantt
function autoFitDays() {
  const SIDEBAR  = 220   // --sidebar-w
  const LABELCOL = 140   // gantt-corner width
  const PADDING  = 32    // márgenes del content area
  const avail = window.innerWidth - SIDEBAR - LABELCOL - PADDING
  return Math.max(7, Math.floor(avail / CELL_W))
}

export async function renderPlanning(container) {
  _numDays = autoFitDays()
  _from    = toISO(new Date())
  _to      = addDays(_from, _numDays - 1)

  container.innerHTML = `
    <div class="planning-toolbar">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-ghost btn-sm" id="btn-prev">‹</button>
        <button class="btn btn-ghost btn-sm" id="btn-today">Hoy</button>
        <button class="btn btn-ghost btn-sm" id="btn-next">›</button>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="color:var(--text2);font-size:12px">Desde</span>
        <input type="date" id="plan-from" value="${_from}" class="plan-date-input">
        <span style="color:var(--text2);font-size:12px">Días</span>
        <input type="number" id="plan-days" value="${_numDays}" min="3" max="90" class="plan-date-input" style="width:60px">
        <button class="btn btn-ghost btn-sm" id="btn-apply">Aplicar</button>
      </div>
    </div>
    <div id="gantt-wrap">${loading()}</div>`

  document.getElementById('btn-prev').onclick  = () => shift(-_numDays)
  document.getElementById('btn-next').onclick  = () => shift(+_numDays)
  document.getElementById('btn-today').onclick = () => {
    _numDays = autoFitDays()
    _from = toISO(new Date())
    _to   = addDays(_from, _numDays - 1)
    sync(); loadGantt()
  }
  document.getElementById('btn-apply').onclick = () => {
    const d = parseInt(document.getElementById('plan-days').value)
    if (d >= 3 && d <= 90) _numDays = d
    _from = document.getElementById('plan-from').value
    _to   = addDays(_from, _numDays - 1)
    loadGantt()
  }

  await loadGantt()
}

function shift(n) { _from = addDays(_from, n); _to = addDays(_to, n); sync(); loadGantt() }

function sync() {
  const f = document.getElementById('plan-from')
  const d = document.getElementById('plan-days')
  if (f) f.value = _from
  if (d) d.value = _numDays
}

async function loadGantt() {
  const wrap = document.getElementById('gantt-wrap')
  if (!wrap) return
  wrap.innerHTML = loading()

  try {
    const [{ data: rooms }, { data: reservations }, { data: ratesList }] = await Promise.all([
      api.listRooms(),
      api.planningReservations({ dateFrom: _from, dateTo: _to }),
      api.listRates(),
    ])

    if (!rooms.length) { wrap.innerHTML = empty('Sin habitaciones'); return }

    // Ordenar por código numérico, luego alfanumérico
    rooms.sort((a, b) => {
      const na = parseInt(a.code), nb = parseInt(b.code)
      if (!isNaN(na) && !isNaN(nb)) return na - nb
      if (!isNaN(na)) return -1
      if (!isNaN(nb)) return  1
      return a.code.localeCompare(b.code)
    })

    const days   = getDays(_from, _to)
    const today  = toISO(new Date())
    const totalW = days.length * CELL_W

    // ── Ocupación ─────────────────────────────────────────────────────────────
    const realRooms    = rooms.filter(r => r.code !== 'VIRTUAL')
    const totalSlots   = realRooms.length * days.length   // room-nights disponibles
    const activeRes    = reservations.filter(r => !['cancelled','no_show'].includes(r.status))
    // contar room-nights ocupados (interesección con el rango visible)
    let occupiedSlots  = 0
    for (const res of activeRes) {
      const start = res.checkInDate  < _from ? _from : res.checkInDate
      const end   = res.checkOutDate > _to   ? _to   : res.checkOutDate
      const si = days.indexOf(start)
      const ei = days.indexOf(end)
      const s  = si >= 0 ? si : 0
      const e  = ei >= 0 ? ei : days.length
      if (e > s) occupiedSlots += (e - s)
    }
    const occPct = totalSlots > 0 ? Math.round(occupiedSlots / totalSlots * 100) : 0

    let occLevel, occMsg, occBg, occColor
    if (occPct >= 80) {
      occLevel = 'alta';  occBg = 'rgba(34,197,94,0.12)';  occColor = '#22c55e'
      occMsg = 'Alta demanda — considera subir precios'
    } else if (occPct >= 50) {
      occBg = 'rgba(79,124,255,0.1)';  occColor = '#6b93ff'
      occMsg = 'Ocupación media'
    } else {
      occBg = 'rgba(245,158,11,0.12)'; occColor = '#f59e0b'
      occMsg = 'Baja ocupación — considera bajar precios o promocionar'
    }

    const rateAL = ratesList.find(r => r.code === 'DIR-AL')
    const rateHD = ratesList.find(r => r.code === 'DIR-HD')

    const bannerHtml = `
      <div class="occ-banner" style="background:${occBg};border-color:${occColor}">
        <div class="occ-left">
          <span class="occ-pct" style="color:${occColor}">${occPct}%</span>
          <span class="occ-label">${days.length} días · ${occMsg}</span>
        </div>
        <div class="occ-rates">
          ${rateAL ? `
          <div class="occ-rate-item">
            <label>Dir AL / noche</label>
            <div class="occ-rate-input-wrap">
              <input type="number" id="price-al" value="${rateAL.adjustValue ?? 0}" min="0" step="0.50" class="occ-price-input">
              <span class="occ-currency">€</span>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="window._saveRate(${rateAL.id},'price-al')">Guardar</button>
          </div>` : ''}
          ${rateHD ? `
          <div class="occ-rate-item">
            <label>Dir HD / noche</label>
            <div class="occ-rate-input-wrap">
              <input type="number" id="price-hd" value="${rateHD.adjustValue ?? 0}" min="0" step="0.50" class="occ-price-input">
              <span class="occ-currency">€</span>
            </div>
            <button class="btn btn-ghost btn-sm" onclick="window._saveRate(${rateHD.id},'price-hd')">Guardar</button>
          </div>` : ''}
        </div>
      </div>`

    // Agrupar reservas por habitación — excluir canceladas y no-shows del gantt
    const byRoom = {}
    for (const r of reservations) {
      if (r.roomId && !['cancelled', 'no_show'].includes(r.status))
        (byRoom[r.roomId] ??= []).push(r)
    }

    const headerDates = days.map(d => {
      const dt = new Date(d + 'T12:00:00')
      const dow = dt.toLocaleDateString('es-ES', { weekday: 'short' })
      const isWeekend = dt.getDay() === 0 || dt.getDay() === 6
      return `<div class="gantt-day-head${d === today ? ' today' : ''}${isWeekend ? ' weekend' : ''}">
        <span class="gantt-dow">${dow}</span>
        <span class="gantt-daynum">${dt.getDate()}</span>
      </div>`
    }).join('')

    const bodyRows = rooms.map(room => {
      const resList = byRoom[room.id] ?? []

      const bars = resList.map(res => {
        const clipStart = res.checkInDate >= _from ? res.checkInDate : _from
        const si = days.indexOf(clipStart)
        if (si < 0) return ''

        let ei
        if (res.checkOutDate > _to) {
          ei = days.length
        } else {
          ei = days.indexOf(res.checkOutDate)
          if (ei < 0 || ei <= si) return ''
        }

        const left  = si * CELL_W + 2
        const width = (ei - si) * CELL_W - 4

        // Confirmed cuyo check-in ya pasó → no-show visual (sin cambiar DB)
        const isLateNoShow = res.status === 'confirmed' && res.checkInDate < today
        const displayStatus = isLateNoShow ? 'no_show' : res.status
        const color = STATUS_COLOR[displayStatus] ?? '#8b90a8'
        const guest = res.guest ? `${res.guest.firstName} ${res.guest.lastName}` : '—'
        const code  = res.externalCode ?? '#' + res.id
        const label = isLateNoShow ? 'Posible no-show' : (STATUS_LABEL[res.status] ?? res.status)

        return `<div class="gantt-bar${isLateNoShow ? ' gantt-bar-noshow' : ''}"
          style="left:${left}px;width:${width}px;background:${color}22;border-left:3px solid ${color};color:${color}"
          onclick="event.stopPropagation();window.goTo('reservation',${res.id})"
          title="${guest} · ${code} · ${label} · ${res.checkInDate} → ${res.checkOutDate}">
          <span class="gantt-bar-name">${guest}</span>
        </div>`
      }).join('')

      // Cada celda lleva data-date y dispara el modal de nueva reserva al hacer click
      const cells = days.map(d => {
        const dt = new Date(d + 'T12:00:00')
        const isWeekend = dt.getDay() === 0 || dt.getDay() === 6
        return `<div class="gantt-cell${isWeekend ? ' weekend' : ''}${d === today ? ' today' : ''}"
          data-room-id="${room.id}" data-room-code="${room.code}" data-date="${d}"
          onclick="window._ganttCellClick(event,${room.id},'${room.code}','${d}')"></div>`
      }).join('')

      const hasRes = resList.length > 0
      return `<div class="gantt-row${hasRes ? '' : ' gantt-row-empty'}">
        <div class="gantt-label-col">
          <span class="gantt-room-code">${room.code}</span>
          <span class="gantt-room-type">${room.roomType?.name ?? ''}</span>
        </div>
        <div class="gantt-cells-col" style="width:${totalW}px">${cells}${bars}</div>
      </div>`
    }).join('')

    const legend = Object.entries(STATUS_COLOR).map(([s, c]) =>
      `<span class="gantt-legend-item">
        <span class="gantt-legend-dot" style="background:${c}22;border:2px solid ${c}"></span>
        ${STATUS_LABEL[s]}
      </span>`
    ).join('')

    wrap.innerHTML = `
      ${bannerHtml}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:12px;color:var(--text2)">${rooms.length} habitaciones · haz clic en una celda para crear reserva</span>
      </div>
      <div class="gantt-scroll">
        <div class="gantt-header">
          <div class="gantt-corner">Habitación</div>
          <div class="gantt-header-dates" style="width:${totalW}px">${headerDates}</div>
        </div>
        <div class="gantt-body">${bodyRows}</div>
      </div>
      <div class="gantt-legend">${legend}</div>`

  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

// ── Guardar precio de tarifa desde el banner ─────────────────────────────────
window._saveRate = async (rateId, inputId) => {
  const input = document.getElementById(inputId)
  if (!input) return
  const value = parseFloat(input.value)
  if (isNaN(value) || value < 0) { showToast('Precio inválido', 'err'); return }
  try {
    await api.updateRate(rateId, value)
    showToast('Precio guardado')
  } catch (err) {
    showToast(err.message, 'err')
  }
}

// ── Clic en celda → modal nueva reserva ──────────────────────────────────────
window._ganttCellClick = async (event, roomId, roomCode, date) => {
  if (event.target.closest('.gantt-bar')) return

  // Rates y channels son listas pequeñas — se cargan de golpe
  let rates = [], channels = []
  try {
    ;[rates, channels] = await Promise.all([
      api.listRates().then(r => r.data),
      api.listChannels().then(r => r.data),
    ])
  } catch (e) { showToast('Error cargando datos del formulario', 'err'); return }

  const checkoutDefault = addDays(date, 1)

  // selectedGuestId se actualiza desde el type-ahead
  let selectedGuestId = null

  const m = modal(`Nueva reserva — Hab. ${roomCode}`, `
    <div class="form-grid">

      <div class="form-group full">
        <label>Huésped *</label>
        <div class="guest-search-wrap">
          <input type="text" id="pg-guest-q" placeholder="Buscar por nombre, email o DNI…" autocomplete="off" class="guest-search-input">
          <div id="pg-guest-results" class="guest-results"></div>
          <div id="pg-guest-selected" class="guest-selected" style="display:none"></div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" id="pg-new-guest-toggle" style="margin-top:6px">+ Nuevo huésped</button>
        <div id="pg-new-guest-form" style="display:none;margin-top:8px">
          <div class="form-grid" style="gap:8px">
            <div class="form-group"><label>Nombre *</label><input type="text" id="pg-fn" placeholder="Nombre"></div>
            <div class="form-group"><label>Apellidos *</label><input type="text" id="pg-ln" placeholder="Apellidos"></div>
            <div class="form-group"><label>Teléfono</label><input type="text" id="pg-phone" placeholder="Opcional"></div>
            <div class="form-group"><label>Email</label><input type="email" id="pg-email" placeholder="Opcional"></div>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" id="pg-create-guest" style="margin-top:6px">Crear y seleccionar</button>
        </div>
      </div>

      <div class="form-group">
        <label>Fecha entrada</label>
        <input type="date" id="pg-checkin" value="${date}" required>
      </div>
      <div class="form-group">
        <label>Fecha salida *</label>
        <input type="date" id="pg-checkout" value="${checkoutDefault}" required>
      </div>
      <div class="form-group">
        <label>Personas</label>
        <input type="number" id="pg-people" value="1" min="1" max="20">
      </div>
      <div class="form-group">
        <label>Canal</label>
        <select id="pg-channel">
          <option value="">Sin canal</option>
          ${channels.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Tarifa</label>
        <select id="pg-rate">
          <option value="">Sin tarifa</option>
          ${rates.map(r => `<option value="${r.id}">${r.title}</option>`).join('')}
        </select>
      </div>
      <div class="form-group full">
        <label>Código externo (Booking, etc.)</label>
        <input type="text" id="pg-code" placeholder="Opcional">
      </div>
    </div>`,
    `<button class="btn btn-ghost" data-close>Cancelar</button>
     <button class="btn btn-primary" id="pg-save">Crear reserva</button>`
  )

  // ── Type-ahead de huésped ───────────────────────────────────────────────────
  function setGuest(id, label) {
    selectedGuestId = id
    m.querySelector('#pg-guest-q').style.display = 'none'
    m.querySelector('#pg-guest-results').innerHTML = ''
    const sel = m.querySelector('#pg-guest-selected')
    sel.style.display = 'flex'
    sel.innerHTML = `<span>${label}</span><button type="button" class="btn btn-ghost btn-sm" id="pg-clear-guest">✕</button>`
    m.querySelector('#pg-clear-guest').onclick = () => {
      selectedGuestId = null
      sel.style.display = 'none'
      m.querySelector('#pg-guest-q').style.display = ''
      m.querySelector('#pg-guest-q').value = ''
      m.querySelector('#pg-guest-q').focus()
    }
  }

  let searchTimer = null
  m.querySelector('#pg-guest-q').oninput = (e) => {
    clearTimeout(searchTimer)
    const q = e.target.value.trim()
    const results = m.querySelector('#pg-guest-results')
    if (q.length < 2) { results.innerHTML = ''; return }
    results.innerHTML = '<div class="guest-result-item" style="color:var(--text2)">Buscando…</div>'
    searchTimer = setTimeout(async () => {
      try {
        const { data } = await api.listGuests({ q, limit: 10 })
        if (!data.length) {
          results.innerHTML = '<div class="guest-result-item" style="color:var(--text2)">Sin resultados</div>'
          return
        }
        results.innerHTML = data.map(g => {
          const label = `${g.firstName} ${g.lastName}${g.email ? ' — ' + g.email : ''}`
          return `<div class="guest-result-item" data-id="${g.id}" data-label="${label.replace(/"/g,'&quot;')}">${label}</div>`
        }).join('')
        results.querySelectorAll('.guest-result-item[data-id]').forEach(el => {
          el.onclick = () => setGuest(Number(el.dataset.id), el.dataset.label)
        })
      } catch { results.innerHTML = '' }
    }, 280)
  }

  // ── Toggle nuevo huésped ────────────────────────────────────────────────────
  m.querySelector('#pg-new-guest-toggle').onclick = () => {
    const form = m.querySelector('#pg-new-guest-form')
    form.style.display = form.style.display === 'none' ? '' : 'none'
  }

  m.querySelector('#pg-create-guest').onclick = async () => {
    const fn = m.querySelector('#pg-fn').value.trim()
    const ln = m.querySelector('#pg-ln').value.trim()
    if (!fn || !ln) { showToast('Nombre y apellidos obligatorios', 'err'); return }
    try {
      const { data: g } = await api.createGuest({
        firstName: fn, lastName: ln,
        phone: m.querySelector('#pg-phone').value.trim() || undefined,
        email: m.querySelector('#pg-email').value.trim() || undefined,
      })
      setGuest(g.id, `${g.firstName} ${g.lastName}`)
      m.querySelector('#pg-new-guest-form').style.display = 'none'
      m.querySelector('#pg-new-guest-toggle').style.display = 'none'
      showToast('Huésped creado')
    } catch (err) { showToast(err.message, 'err') }
  }

  // ── Guardar reserva ─────────────────────────────────────────────────────────
  m.querySelector('#pg-save').onclick = async () => {
    const checkIn  = m.querySelector('#pg-checkin').value
    const checkOut = m.querySelector('#pg-checkout').value
    const people   = Number(m.querySelector('#pg-people').value) || 1
    const channelId= Number(m.querySelector('#pg-channel').value) || undefined
    const rateId   = Number(m.querySelector('#pg-rate').value) || undefined
    const extCode  = m.querySelector('#pg-code').value || undefined

    if (!selectedGuestId)    { showToast('Selecciona o crea un huésped', 'err'); return }
    if (!checkIn || !checkOut) { showToast('Completa las fechas', 'err'); return }
    if (checkOut <= checkIn)   { showToast('La salida debe ser posterior a la entrada', 'err'); return }

    try {
      await api.createReservation({
        guestId: selectedGuestId, roomId,
        checkInDate: checkIn, checkOutDate: checkOut,
        people, bookingChannelId: channelId, rateId, externalCode: extCode,
      })
      m.remove()
      showToast('Reserva creada')
      loadGantt()
    } catch (err) { showToast(err.message, 'err') }
  }
}
