import { api } from '../api.js'
import { fmtDate, fmtMoney, badge, loading, empty, showToast, modal } from '../helpers.js'

let currentPage = 1
let currentFilters = {}

export async function renderReservations(container) {
  container.innerHTML = `
    <div class="search-bar">
      <input id="res-search" placeholder="Buscar por nombre, código…" type="search">
      <select id="res-status">
        <option value="">Todos los estados</option>
        <option value="confirmed">Confirmadas</option>
        <option value="checked_in">En casa</option>
        <option value="checked_out">Han salido</option>
        <option value="cancelled">Canceladas</option>
        <option value="no_show">No show</option>
      </select>
      <input id="res-date" type="date" title="Filtrar por fecha de llegada">
      <button class="btn btn-primary" id="btn-new-res">+ Nueva reserva</button>
    </div>
    <div id="res-table-wrap">${loading()}</div>`

  document.getElementById('res-search').oninput  = debounce(applyFilters, 350)
  document.getElementById('res-status').onchange = applyFilters
  document.getElementById('res-date').onchange   = applyFilters
  document.getElementById('btn-new-res').onclick  = () => showNewReservationModal(container)

  await loadReservations(container)
}

async function applyFilters() {
  const q      = document.getElementById('res-search')?.value?.trim()
  const status = document.getElementById('res-status')?.value
  const date   = document.getElementById('res-date')?.value
  currentFilters = {}
  if (status) currentFilters.status  = status
  if (date)   currentFilters.checkIn = date
  currentPage = 1
  await loadReservations(document.getElementById('content'))
}

async function loadReservations(container) {
  const wrap = document.getElementById('res-table-wrap')
  if (!wrap) return
  wrap.innerHTML = loading()

  try {
    const { data, meta } = await api.listReservations({ ...currentFilters, page: currentPage, limit: 50 })

    if (!data.length) { wrap.innerHTML = empty('Sin reservas'); return }

    wrap.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>Reservas <span style="color:var(--text2);font-weight:400">(${meta.total})</span></h2>
        </div>
        <table>
          <thead>
            <tr>
              <th>Código</th>
              <th>Huésped</th>
              <th>Habitación</th>
              <th>Llegada</th>
              <th>Salida</th>
              <th>Noches</th>
              <th>Total</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            ${data.map(r => `
              <tr onclick="window.goTo('reservation', ${r.id})">
                <td style="font-family:monospace;font-size:12px">${r.externalCode ?? r.id}</td>
                <td><strong>${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}</strong></td>
                <td>${r.room?.code ?? '—'}</td>
                <td>${fmtDate(r.checkInDate)}</td>
                <td>${fmtDate(r.checkOutDate)}</td>
                <td>${r.nights}</td>
                <td>${fmtMoney(r.total)}</td>
                <td>${badge(r.status)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${meta.total > 50 ? `
          <div style="padding:12px 16px;display:flex;gap:8px;justify-content:flex-end;border-top:1px solid var(--border)">
            <button class="btn btn-ghost btn-sm" onclick="changePage(-1)" ${currentPage===1?'disabled':''}>← Anterior</button>
            <span style="padding:4px 8px;color:var(--text2);font-size:13px">Página ${currentPage}</span>
            <button class="btn btn-ghost btn-sm" onclick="changePage(1)">Siguiente →</button>
          </div>` : ''}
      </div>`
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

window.changePage = async (dir) => {
  currentPage = Math.max(1, currentPage + dir)
  await loadReservations(document.getElementById('content'))
}

async function showNewReservationModal(container) {
  let rooms = [], guests = [], rates = [], channels = []
  try {
    ;[rooms, guests, rates, channels] = await Promise.all([
      api.listRooms().then(r => r.data),
      api.listGuests({ limit: 100 }).then(r => r.data),
      api.listRates().then(r => r.data),
      api.listChannels().then(r => r.data),
    ])
  } catch (e) {}

  const m = modal('Nueva reserva', `
    <div class="form-grid">
      <div class="form-group full">
        <label>Huésped *</label>
        <select id="f-guest" required>
          <option value="">Seleccionar huésped…</option>
          ${guests.map(g => `<option value="${g.id}">${g.firstName} ${g.lastName} ${g.email ? `— ${g.email}` : ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Habitación *</label>
        <select id="f-room" required>
          <option value="">Seleccionar…</option>
          ${rooms.map(r => `<option value="${r.id}">${r.code} — ${r.roomType?.name ?? ''}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Canal</label>
        <select id="f-channel">
          <option value="">Sin canal</option>
          ${channels.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Fecha de entrada *</label>
        <input type="date" id="f-checkin" required>
      </div>
      <div class="form-group">
        <label>Fecha de salida *</label>
        <input type="date" id="f-checkout" required>
      </div>
      <div class="form-group">
        <label>Personas</label>
        <input type="number" id="f-people" value="1" min="1" max="10">
      </div>
      <div class="form-group">
        <label>Tarifa</label>
        <select id="f-rate">
          <option value="">Sin tarifa específica</option>
          ${rates.map(r => `<option value="${r.id}">${r.title}</option>`).join('')}
        </select>
      </div>
      <div class="form-group full">
        <label>Código externo (Booking, etc.)</label>
        <input type="text" id="f-code" placeholder="Opcional">
      </div>
    </div>`,
    `<button class="btn btn-ghost" data-close>Cancelar</button>
     <button class="btn btn-primary" id="btn-save-res">Crear reserva</button>`
  )

  m.querySelector('#btn-save-res').onclick = async () => {
    const data = {
      guestId:          Number(m.querySelector('#f-guest').value),
      roomId:           Number(m.querySelector('#f-room').value),
      checkInDate:      m.querySelector('#f-checkin').value,
      checkOutDate:     m.querySelector('#f-checkout').value,
      people:           Number(m.querySelector('#f-people').value),
      rateId:           Number(m.querySelector('#f-rate').value) || undefined,
      bookingChannelId: Number(m.querySelector('#f-channel').value) || undefined,
      externalCode:     m.querySelector('#f-code').value || undefined,
    }
    if (!data.guestId || !data.roomId || !data.checkInDate || !data.checkOutDate) {
      showToast('Completa los campos obligatorios', 'err'); return
    }
    try {
      const res = await api.createReservation(data)
      m.remove()
      showToast('Reserva creada')
      window.goTo('reservation', res.data.id)
    } catch (err) {
      showToast(err.message, 'err')
    }
  }
}

function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms) }
}
