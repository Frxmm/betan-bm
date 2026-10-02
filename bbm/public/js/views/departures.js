import { api } from '../api.js'
import { loading, empty, showToast } from '../helpers.js'

function toISO(d) { return d.toISOString().slice(0, 10) }
function fmt(n) { return Number(n ?? 0).toFixed(2) }

let _date

export async function renderDepartures(container) {
  _date = toISO(new Date())

  container.innerHTML = `
    <div class="day-toolbar">
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn btn-ghost btn-sm" id="dep-prev">‹</button>
        <input type="date" id="dep-date" value="${_date}" class="plan-date-input">
        <button class="btn btn-ghost btn-sm" id="dep-next">›</button>
        <button class="btn btn-ghost btn-sm" id="dep-today">Hoy</button>
      </div>
    </div>
    <div id="dep-content">${loading()}</div>`

  document.getElementById('dep-date').onchange  = () => { _date = document.getElementById('dep-date').value; loadDepartures() }
  document.getElementById('dep-prev').onclick   = () => shiftDate(-1)
  document.getElementById('dep-next').onclick   = () => shiftDate(+1)
  document.getElementById('dep-today').onclick  = () => { _date = toISO(new Date()); syncDate(); loadDepartures() }

  await loadDepartures()
}

function shiftDate(n) {
  const d = new Date(_date + 'T12:00:00')
  d.setDate(d.getDate() + n)
  _date = toISO(d)
  syncDate()
  loadDepartures()
}

function syncDate() {
  const el = document.getElementById('dep-date')
  if (el) el.value = _date
}

async function loadDepartures() {
  const wrap = document.getElementById('dep-content')
  if (!wrap) return
  wrap.innerHTML = loading()

  try {
    const { data: list } = await api.departures(_date)

    const pending    = list.filter(r => r.status === 'checked_in')
    const checkedOut = list.filter(r => r.status === 'checked_out')

    wrap.innerHTML = `
      <div class="day-stats">
        <div class="day-stat">
          <span class="day-stat-num">${pending.length}</span>
          <span class="day-stat-label">Por salir</span>
        </div>
        <div class="day-stat checked">
          <span class="day-stat-num">${checkedOut.length}</span>
          <span class="day-stat-label">Ya salieron</span>
        </div>
        <div class="day-stat total">
          <span class="day-stat-num">${list.length}</span>
          <span class="day-stat-label">Total salidas</span>
        </div>
      </div>

      ${list.length === 0 ? empty('Sin salidas para este día') : `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Hab.</th>
              <th>Huésped</th>
              <th>Llegada</th>
              <th>Noches</th>
              <th>Canal</th>
              <th>Total</th>
              <th>Pagado</th>
              <th>Saldo</th>
              <th>Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${list.map(r => {
              const guest   = r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : '—'
              const room    = r.room?.code ?? '—'
              const ch      = r.bookingChannel?.name ?? '—'
              const total   = parseFloat(r.total ?? '0')
              const paid    = parseFloat(r.amountPaid ?? '0')
              const due     = total - paid
              const isPending = r.status === 'checked_in'
              const dueColor  = due > 0 ? 'color:var(--red);font-weight:600' : 'color:var(--green)'
              return `<tr>
                <td><span class="badge">${room}</span></td>
                <td><a href="#" onclick="event.preventDefault();window.goTo('reservation',${r.id})">${guest}</a></td>
                <td style="font-size:12px;color:var(--text2)">${r.checkInDate}</td>
                <td>${r.nights}</td>
                <td style="font-size:12px">${ch}</td>
                <td>${total > 0 ? fmt(total) + ' €' : '—'}</td>
                <td>${paid > 0 ? fmt(paid) + ' €' : '—'}</td>
                <td style="${dueColor}">${due !== 0 ? fmt(due) + ' €' : '✓'}</td>
                <td>${isPending
                  ? '<span class="status-chip checked_in">En casa</span>'
                  : '<span class="status-chip checked_out">Saliendo</span>'}</td>
                <td>
                  ${isPending
                    ? `<button class="btn btn-primary btn-sm" onclick="window._doCheckOut(${r.id})">Check-out</button>`
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

window._doCheckOut = async (id) => {
  try {
    await api.checkOut(id)
    showToast('Check-out realizado')
    loadDepartures()
  } catch (err) {
    showToast(err.message, 'err')
  }
}
