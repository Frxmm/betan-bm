import { api } from '../api.js'
import { fmtDate, fmtMoney, badge, loading, empty } from '../helpers.js'

export async function renderDashboard(container) {
  container.innerHTML = loading()

  const today = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' })

  try {
    const [stats, arrivals, departures] = await Promise.all([
      api.dashboard(),
      api.arrivals(),
      api.departures(),
    ])
    const s = stats.data

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card blue">
          <div class="label">Llegadas hoy</div>
          <div class="value">${s.arrivals}</div>
          <div class="sub">pendientes de check-in</div>
        </div>
        <div class="stat-card green">
          <div class="label">Salidas hoy</div>
          <div class="value">${s.departures}</div>
          <div class="sub">pendientes de check-out</div>
        </div>
        <div class="stat-card yellow">
          <div class="label">En casa</div>
          <div class="value">${s.inHouse}</div>
          <div class="sub">reservas activas</div>
        </div>
        <div class="stat-card">
          <div class="label">Nuevas hoy</div>
          <div class="value">${s.newReservations}</div>
          <div class="sub">reservas creadas</div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
        <div class="card">
          <div class="card-header"><h2>Llegadas (${arrivals.data.length})</h2></div>
          ${arrivals.data.length === 0
            ? empty('Sin llegadas pendientes')
            : `<table>
                <thead><tr><th>Huésped</th><th>Habitación</th><th>Noches</th><th>Estado</th></tr></thead>
                <tbody>
                  ${arrivals.data.map(r => `
                    <tr data-id="${r.id}" onclick="window.goTo('reservation', ${r.id})">
                      <td><strong>${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}</strong><br>
                          <span style="color:var(--text2);font-size:12px">${r.externalCode ?? ''}</span></td>
                      <td>${r.room?.code ?? '—'}</td>
                      <td>${r.nights}</td>
                      <td>${badge(r.status)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`}
        </div>

        <div class="card">
          <div class="card-header"><h2>Salidas (${departures.data.length})</h2></div>
          ${departures.data.length === 0
            ? empty('Sin salidas pendientes')
            : `<table>
                <thead><tr><th>Huésped</th><th>Habitación</th><th>Pendiente</th><th></th></tr></thead>
                <tbody>
                  ${departures.data.map(r => `
                    <tr data-id="${r.id}" onclick="window.goTo('reservation', ${r.id})">
                      <td><strong>${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}</strong></td>
                      <td>${r.room?.code ?? '—'}</td>
                      <td>${fmtMoney(Number(r.total) - Number(r.amountPaid))}</td>
                      <td>${badge(r.status)}</td>
                    </tr>`).join('')}
                </tbody>
              </table>`}
        </div>
      </div>`
  } catch (err) {
    container.innerHTML = `<div class="empty"><p style="color:var(--red)">Error: ${err.message}</p></div>`
  }
}
