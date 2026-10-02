import { api } from '../api.js'
import { loading, empty } from '../helpers.js'

function toISO(d) { return d.toISOString().slice(0, 10) }
function fmt(n) { return Number(n ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }

function firstOfMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

let _from, _to, _tab = 'pending'

export async function renderBilling(container) {
  _from = firstOfMonth()
  _to   = toISO(new Date())

  container.innerHTML = `
    <div class="day-toolbar" style="gap:16px">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span style="color:var(--text2);font-size:12px">Del</span>
        <input type="date" id="bil-from" value="${_from}" class="plan-date-input">
        <span style="color:var(--text2);font-size:12px">al</span>
        <input type="date" id="bil-to"   value="${_to}"   class="plan-date-input">
        <button class="btn btn-ghost btn-sm" id="bil-apply">Aplicar</button>
      </div>
      <div class="tab-bar">
        <button class="tab-btn active" data-tab="pending">Saldo pendiente</button>
        <button class="tab-btn" data-tab="summary">Resumen</button>
        <button class="tab-btn" data-tab="all">Todas</button>
      </div>
    </div>
    <div id="bil-content">${loading()}</div>`

  document.getElementById('bil-apply').onclick = () => {
    _from = document.getElementById('bil-from').value
    _to   = document.getElementById('bil-to').value
    loadBilling()
  }

  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      _tab = btn.dataset.tab
      loadBilling()
    }
  })

  await loadBilling()
}

async function loadBilling() {
  const wrap = document.getElementById('bil-content')
  if (!wrap) return
  wrap.innerHTML = loading()

  try {
    const { data: list, meta } = await api.billingReport({ dateFrom: _from, dateTo: _to })

    const totalRevenue = parseFloat(meta.totalRevenue)
    const totalPaid    = parseFloat(meta.totalPaid)
    const totalDue     = parseFloat(meta.totalDue)

    const summaryCards = `
      <div class="billing-cards">
        <div class="billing-card">
          <span class="billing-card-label">Facturado</span>
          <span class="billing-card-num">${fmt(totalRevenue)} €</span>
          <span class="billing-card-sub">${meta.count} reservas</span>
        </div>
        <div class="billing-card green">
          <span class="billing-card-label">Cobrado</span>
          <span class="billing-card-num">${fmt(totalPaid)} €</span>
          <span class="billing-card-sub">${totalRevenue > 0 ? Math.round(totalPaid / totalRevenue * 100) : 0}% del total</span>
        </div>
        <div class="billing-card ${totalDue > 0 ? 'red' : 'green'}">
          <span class="billing-card-label">Pendiente</span>
          <span class="billing-card-num">${fmt(totalDue)} €</span>
          <span class="billing-card-sub">${list.filter(r => parseFloat(r.amountPaid ?? '0') < parseFloat(r.total ?? '0')).length} reservas con saldo</span>
        </div>
      </div>`

    let tableHtml = ''

    if (_tab === 'pending') {
      const withDue = list.filter(r => {
        const due = parseFloat(r.total ?? '0') - parseFloat(r.amountPaid ?? '0')
        return due > 0.01
      }).sort((a, b) => {
        const da = parseFloat(a.total ?? '0') - parseFloat(a.amountPaid ?? '0')
        const db2 = parseFloat(b.total ?? '0') - parseFloat(b.amountPaid ?? '0')
        return db2 - da
      })

      tableHtml = withDue.length === 0
        ? empty('Sin saldos pendientes en el período')
        : buildTable(withDue, true)

    } else if (_tab === 'summary') {
      const byChannel = meta.byChannel
      const rows = Object.entries(byChannel)
        .sort(([, a], [, b]) => b.revenue - a.revenue)
        .map(([ch, v]) => `<tr>
          <td>${ch}</td>
          <td>${v.count}</td>
          <td>${fmt(v.revenue)} €</td>
          <td>${fmt(v.paid)} €</td>
          <td style="color:${v.revenue - v.paid > 0.01 ? 'var(--red)' : 'var(--green)'}">
            ${fmt(v.revenue - v.paid)} €
          </td>
        </tr>`).join('')

      tableHtml = `
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr>
              <th>Canal</th><th>Reservas</th><th>Facturado</th><th>Cobrado</th><th>Pendiente</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`

    } else {
      tableHtml = list.length === 0 ? empty('Sin reservas en el período') : buildTable(list, false)
    }

    wrap.innerHTML = summaryCards + tableHtml

  } catch (err) {
    wrap.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

function buildTable(list, highlightDue) {
  const rows = list.map(r => {
    const guest  = r.guest ? `${r.guest.firstName} ${r.guest.lastName}` : '—'
    const room   = r.room?.code ?? '—'
    const ch     = r.bookingChannel?.name ?? '—'
    const total  = parseFloat(r.total ?? '0')
    const paid   = parseFloat(r.amountPaid ?? '0')
    const due    = total - paid
    const dueColor = due > 0.01 ? 'color:var(--red);font-weight:600' : 'color:var(--green)'

    const statusMap = {
      confirmed:   ['confirmed',  'Confirmada'],
      checked_in:  ['checked_in', 'En casa'],
      checked_out: ['checked_out','Saliendo'],
    }
    const [cls, label] = statusMap[r.status] ?? ['', r.status]

    return `<tr>
      <td><span class="badge">${room}</span></td>
      <td><a href="#" onclick="event.preventDefault();window.goTo('reservation',${r.id})">${guest}</a></td>
      <td style="font-size:12px;color:var(--text2)">${r.checkInDate} → ${r.checkOutDate}</td>
      <td style="font-size:12px">${ch}</td>
      <td>${total > 0 ? fmt(total) + ' €' : '—'}</td>
      <td>${paid > 0 ? fmt(paid) + ' €' : '—'}</td>
      <td style="${dueColor}">${Math.abs(due) > 0.01 ? fmt(due) + ' €' : '✓'}</td>
      <td><span class="status-chip ${cls}">${label}</span></td>
      <td><button class="btn btn-ghost btn-sm" onclick="window.goTo('reservation',${r.id})">Ver</button></td>
    </tr>`
  }).join('')

  return `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr>
          <th>Hab.</th><th>Huésped</th><th>Estancia</th><th>Canal</th>
          <th>Total</th><th>Pagado</th><th>Saldo</th><th>Estado</th><th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}
