import { api } from '../api.js'
import { loading, empty, showToast } from '../helpers.js'
import { openCheckInModal } from '../checkin-modal.js'

function toISO(d) { return d.toISOString().slice(0, 10) }

let _date

export async function renderArrivals(container) {
  _date = toISO(new Date())

  container.innerHTML = `
    <div class="day-toolbar">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-ghost btn-sm" id="arr-prev">‹</button>
        <input type="date" id="arr-date" value="${_date}" class="plan-date-input">
        <button class="btn btn-ghost btn-sm" id="arr-next">›</button>
        <button class="btn btn-ghost btn-sm" id="arr-today">Hoy</button>
      </div>
    </div>
    <div id="arr-content">${loading()}</div>`

  document.getElementById('arr-date').onchange  = () => { _date = document.getElementById('arr-date').value; loadArrivals() }
  document.getElementById('arr-prev').onclick   = () => shiftDate(-1)
  document.getElementById('arr-next').onclick   = () => shiftDate(+1)
  document.getElementById('arr-today').onclick  = () => { _date = toISO(new Date()); syncDate(); loadArrivals() }

  await loadArrivals()
}

function shiftDate(n) {
  const d = new Date(_date + 'T12:00:00')
  d.setDate(d.getDate() + n)
  _date = toISO(d)
  syncDate()
  loadArrivals()
}

function syncDate() {
  const el = document.getElementById('arr-date')
  if (el) el.value = _date
}

async function loadArrivals() {
  const wrap = document.getElementById('arr-content')
  if (!wrap) return
  wrap.innerHTML = loading()

  try {
    const { data: list, meta } = await api.arrivals(_date)

    const pending   = list.filter(r => r.status === 'confirmed')
    const arrived   = list.filter(r => r.status === 'checked_in')

    const label = new Date(_date + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })

    wrap.innerHTML = `
      <div class="day-stats">
        <div class="day-stat">
          <span class="day-stat-num">${pending.length}</span>
          <span class="day-stat-label">Por llegar</span>
        </div>
        <div class="day-stat checked">
          <span class="day-stat-num">${arrived.length}</span>
          <span class="day-stat-label">Ya en casa</span>
        </div>
        <div class="day-stat total">
          <span class="day-stat-num">${list.length}</span>
          <span class="day-stat-label">Total llegadas</span>
        </div>
      </div>

      ${list.length === 0 ? empty('Sin llegadas para este día') : `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Hab.</th>
              <th>Huésped</th>
              <th>Tipo</th>
              <th>Noches</th>
              <th>Personas</th>
              <th>Canal</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const guest = r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : '—'
              const room  = r.room?.code ?? '—'
              const type  = r.room?.roomType?.name ?? '—'
              const ch    = r.bookingChannel?.name ?? '—'
              const isPending = r.status === 'confirmed'
              return `<tr>
                <td><span class="badge">${room}</span></td>
                <td><a href="#" onclick="event.preventDefault();window.goTo('reservation',${r.id})">${guest}</a></td>
                <td style="color:var(--text2);font-size:12px">${type}</td>
                <td>${r.nights}</td>
                <td>${r.people ?? 1}</td>
                <td style="font-size:12px">${ch}</td>
                <td>${isPending
                  ? '<span class="status-chip confirmed">Por llegar</span>'
                  : '<span class="status-chip checked_in">En casa</span>'}</td>
                <td>
                  ${isPending
                    ? `<button class="btn btn-primary btn-sm" onclick="window._doCheckIn(${r.id})">Check-in</button>`
                    : `<button class="btn btn-ghost btn-sm" onclick="window.goTo('reservation',${r.id})">Ver</button>`}
                </td>
              </tr>`
            }).join('')}
          </tbody>
        </table>
      </div>`}
    `
  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

window._doCheckIn = (id) => openCheckInModal(id, loadArrivals)
