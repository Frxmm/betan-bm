import { api } from '../api.js'
import { fmtDate, fmtMoney, loading, empty } from '../helpers.js'

export async function renderRooms(container) {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]

  container.innerHTML = `
    <div class="search-bar">
      <label style="color:var(--text2);font-size:13px;align-self:center">Disponibilidad:</label>
      <input type="date" id="avail-from" value="${today}">
      <input type="date" id="avail-to" value="${tomorrow}">
      <button class="btn btn-ghost" id="btn-check-avail">Comprobar</button>
    </div>
    <div id="rooms-wrap">${loading()}</div>`

  document.getElementById('btn-check-avail').onclick = loadAvailability
  await loadRooms()
}

function sortRooms(data) {
  return data.sort((a, b) => {
    const na = parseInt(a.code), nb = parseInt(b.code)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    if (!isNaN(na)) return -1
    if (!isNaN(nb)) return  1
    return a.code.localeCompare(b.code)
  })
}

async function loadRooms() {
  const wrap = document.getElementById('rooms-wrap')
  if (!wrap) return
  try {
    const { data: raw } = await api.listRooms()
    const data = sortRooms(raw)
    if (!data.length) { wrap.innerHTML = empty('Sin habitaciones'); return }

    wrap.innerHTML = `
      <div class="card">
        <div class="card-header"><h2>Habitaciones (${data.length})</h2></div>
        <table>
          <thead><tr><th>Código</th><th>Tipo</th><th>Capacidad</th><th>Precio base</th><th>Activa</th></tr></thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td><strong style="color:var(--accent2)">${r.code}</strong></td>
                <td>${r.roomType?.name ?? '—'}</td>
                <td>${r.roomType?.maxOccupancy ?? '—'} pax</td>
                <td>${fmtMoney(r.roomType?.defaultPrice)}</td>
                <td>${r.active ? '<span style="color:var(--green)">●</span>' : '<span style="color:var(--red)">●</span>'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

async function loadAvailability() {
  const wrap = document.getElementById('rooms-wrap')
  const from = document.getElementById('avail-from').value
  const to   = document.getElementById('avail-to').value
  if (!from || !to) return
  wrap.innerHTML = loading()
  try {
    const { data: rawAvail } = await api.getAvailability({ dateFrom: from, dateTo: to })
    const data = sortRooms(rawAvail)
    wrap.innerHTML = `
      <div class="card">
        <div class="card-header">
          <h2>Disponibles del ${from} al ${to} — ${data.length} habitaciones</h2>
          <button class="btn btn-ghost btn-sm" onclick="loadAllRooms()">Ver todas</button>
        </div>
        ${!data.length ? empty('Sin habitaciones disponibles en ese rango') : `
        <table>
          <thead><tr><th>Código</th><th>Tipo</th><th>Capacidad</th><th>Precio base</th></tr></thead>
          <tbody>
            ${data.map(r => `
              <tr>
                <td><strong style="color:var(--green)">${r.code}</strong></td>
                <td>${r.roomType?.name ?? '—'}</td>
                <td>${r.roomType?.maxOccupancy ?? '—'} pax</td>
                <td>${fmtMoney(r.roomType?.defaultPrice)}</td>
              </tr>`).join('')}
          </tbody>
        </table>`}
      </div>`
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

window.loadAllRooms = loadRooms
