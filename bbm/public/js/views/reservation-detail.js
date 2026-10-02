import { api } from '../api.js'
import { fmtDate, fmtMoney, badge, loading, empty, showToast, modal, STATUS_LABEL } from '../helpers.js'
import { openCheckInModal } from '../checkin-modal.js'

export async function renderReservationDetail(container, id) {
  container.innerHTML = loading()
  try {
    const [{ data: r }, invoicesRes] = await Promise.all([
      api.getReservation(id),
      api.listInvoices({ reservationId: id }).catch(() => ({ data: [] })),
    ])
    const g = r.guest ?? {}
    const due = Number(r.total) - Number(r.amountPaid)
    const invoice = invoicesRes.data?.[0] ?? null

    container.innerHTML = `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:20px">
        <button class="btn btn-ghost btn-sm" onclick="window.goTo('reservations')">← Volver</button>
        <h2 style="font-size:18px">Reserva #${r.externalCode ?? r.id}</h2>
        ${badge(r.status)}
      </div>

      <div class="action-bar">
        ${r.status === 'confirmed'   ? `<button class="btn btn-green" onclick="doCheckin(${r.id})">Check-in</button>` : ''}
        ${r.status === 'checked_in'  ? `<button class="btn btn-yellow" onclick="doCheckout(${r.id})">Check-out</button>` : ''}
        ${!['cancelled'].includes(r.status) && Number(r.total) > 0
          ? invoice
            ? `<button class="btn btn-ghost btn-sm" onclick="printInvoice(${invoice.id})">🖨 Factura ${invoice.invoiceNumber}</button>`
            : `<button class="btn btn-ghost btn-sm" onclick="doCreateInvoice(${r.id})">+ Crear factura</button>`
          : ''}
        ${!['checked_out','cancelled'].includes(r.status)
          ? `<button class="btn btn-ghost" onclick="showAddNote(${r.id})">+ Nota</button>
             <button class="btn btn-red btn-sm" onclick="doCancel(${r.id})">Cancelar</button>` : ''}
      </div>

      <div class="detail-grid">
        <div class="detail-section">
          <h3>Huésped</h3>
          <div class="detail-row"><span class="k">Nombre</span><span class="v">${g.firstName ?? ''} ${g.lastName ?? ''}</span></div>
          <div class="detail-row"><span class="k">Email</span><span class="v">${g.email ?? '—'}</span></div>
          <div class="detail-row"><span class="k">Teléfono</span><span class="v">${g.phone ?? '—'}</span></div>
          <div class="detail-row"><span class="k">Documento</span><span class="v">${g.idDocType ? `${g.idDocType.toUpperCase()} ${g.idDocNumber ?? ''}` : '—'}</span></div>
          ${g.isVip ? '<div class="detail-row"><span class="k">VIP</span><span class="v" style="color:var(--yellow)">★ VIP</span></div>' : ''}
        </div>

        <div class="detail-section">
          <h3>Estancia</h3>
          <div class="detail-row"><span class="k">Habitación</span><span class="v">${r.room?.code ?? '—'}</span></div>
          <div class="detail-row"><span class="k">Tipo</span><span class="v">${r.room?.roomType?.name ?? '—'}</span></div>
          <div class="detail-row"><span class="k">Entrada</span><span class="v">${fmtDate(r.checkInDate)}</span></div>
          <div class="detail-row"><span class="k">Salida</span><span class="v">${fmtDate(r.checkOutDate)}</span></div>
          <div class="detail-row"><span class="k">Noches</span><span class="v">${r.nights}</span></div>
          <div class="detail-row"><span class="k">Personas</span><span class="v">${r.people}</span></div>
        </div>

        <div class="detail-section">
          <h3>Financiero</h3>
          <div class="detail-row"><span class="k">Total</span><span class="v">${fmtMoney(r.total)}</span></div>
          <div class="detail-row"><span class="k">Pagado</span><span class="v" style="color:var(--green)">${fmtMoney(r.amountPaid)}</span></div>
          <div class="detail-row"><span class="k">Pendiente</span><span class="v" style="color:${due > 0 ? 'var(--red)' : 'var(--green)'}">${fmtMoney(due)}</span></div>
          <div class="detail-row"><span class="k">Comisión canal</span><span class="v">${fmtMoney(r.bmCommission)}</span></div>
          <div class="detail-row"><span class="k">Factura</span><span class="v">${
            invoice
              ? `<a href="#" onclick="event.preventDefault();printInvoice(${invoice.id})" style="color:var(--accent2)">${invoice.invoiceNumber}</a>`
              : '—'
          }</span></div>
        </div>

        <div class="detail-section">
          <h3>Origen</h3>
          <div class="detail-row"><span class="k">Estado</span><span class="v">${STATUS_LABEL[r.status] ?? r.status}</span></div>
          ${r.checkedInAt ? `<div class="detail-row"><span class="k">Check-in</span><span class="v">${fmtDate(r.checkedInAt)}</span></div>` : ''}
          ${r.checkedOutAt ? `<div class="detail-row"><span class="k">Check-out</span><span class="v">${fmtDate(r.checkedOutAt)}</span></div>` : ''}
          <div class="detail-row"><span class="k">Reservado el</span><span class="v">${fmtDate(r.bookedAt)}</span></div>
          ${r.groupName ? `<div class="detail-row"><span class="k">Grupo</span><span class="v">${r.groupName}</span></div>` : ''}
        </div>
      </div>

      ${r.nightRows?.length ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header"><h2>Noches (${r.nightRows.length})</h2></div>
          <table>
            <thead><tr><th>Fecha</th><th>Huésped</th><th>Habitación</th><th>Cama</th><th>Precio</th><th>Comisión</th></tr></thead>
            <tbody>
              ${r.nightRows.map(n => `
                <tr>
                  <td>${fmtDate(n.date)}</td>
                  <td>${n.guest?.firstName ?? ''} ${n.guest?.lastName ?? ''}</td>
                  <td>${n.room?.code ?? '—'}</td>
                  <td>${n.bedIndex ?? '—'}</td>
                  <td>${fmtMoney(n.price)}</td>
                  <td>${fmtMoney(n.commission)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

      ${r.notes?.length ? `
        <div class="card" style="margin-bottom:20px">
          <div class="card-header">
            <h2>Notas (${r.notes.length})</h2>
            <button class="btn btn-ghost btn-sm" onclick="showAddNote(${r.id})">+ Añadir nota</button>
          </div>
          <div style="padding:0 18px">
            ${r.notes.map(n => `
              <div style="padding:14px 0;border-bottom:1px solid var(--border)">
                <div style="font-size:12px;color:var(--text2);margin-bottom:4px">
                  ${n.author ? `${n.author.firstName} ${n.author.lastName} · ` : ''}${fmtDate(n.createdAt)}
                </div>
                <p style="font-size:13.5px;white-space:pre-wrap">${n.note}</p>
              </div>`).join('')}
          </div>
        </div>` : ''}
    `
  } catch (err) {
    container.innerHTML = `<div class="empty"><p style="color:var(--red)">${err.message}</p></div>`
  }
}

window.doCheckin = (id) => openCheckInModal(id, () => window.goTo('reservation', id))

window.doCheckout = async (id) => {
  if (!confirm('¿Confirmar check-out?')) return
  try {
    await api.checkOut(id)
    showToast('Check-out realizado')
    window.goTo('reservation', id)
  } catch (err) { showToast(err.message, 'err') }
}

window.doCancel = async (id) => {
  if (!confirm('¿Cancelar esta reserva?')) return
  try {
    await api.cancelReservation(id)
    showToast('Reserva cancelada')
    window.goTo('reservations')
  } catch (err) { showToast(err.message, 'err') }
}

window.showAddNote = (id) => {
  const m = modal('Añadir nota', `
    <div class="form-group">
      <label>Nota</label>
      <textarea id="note-text" rows="4" placeholder="Escribe la nota…"></textarea>
    </div>`,
    `<button class="btn btn-ghost" data-close>Cancelar</button>
     <button class="btn btn-primary" id="btn-save-note">Guardar</button>`
  )
  m.querySelector('#btn-save-note').onclick = async () => {
    const note = m.querySelector('#note-text').value.trim()
    if (!note) return
    try {
      await api.addNote(id, note)
      m.remove()
      showToast('Nota añadida')
      window.goTo('reservation', id)
    } catch (err) { showToast(err.message, 'err') }
  }
}

window.doCreateInvoice = async (reservationId) => {
  try {
    const { data: inv } = await api.createInvoiceFromReservation(reservationId)
    showToast(`Factura ${inv.invoiceNumber} creada`)
    window.goTo('reservation', reservationId)
  } catch (err) { showToast(err.message, 'err') }
}

window.printInvoice = async (invoiceId) => {
  try {
    const { data: inv } = await api.getInvoice(invoiceId)
    const r   = inv.reservation ?? {}
    const g   = inv.guest ?? {}
    const fmt = (n) => Number(n ?? 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const win = window.open('', '_blank')
    win.document.write(`<!DOCTYPE html><html lang="es"><head>
      <meta charset="UTF-8">
      <title>Factura ${inv.invoiceNumber}</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 13px; color: #111; margin: 40px; }
        h1 { font-size: 22px; margin-bottom: 4px; }
        .sub { color: #555; font-size: 12px; margin-bottom: 24px; }
        .row { display: flex; justify-content: space-between; margin-bottom: 6px; }
        .label { color: #555; }
        hr { border: none; border-top: 1px solid #ddd; margin: 18px 0; }
        .total { font-size: 16px; font-weight: bold; }
        .footer { margin-top: 40px; font-size: 11px; color: #888; text-align: center; }
        @media print { body { margin: 20px; } }
      </style>
    </head><body>
      <h1>FACTURA</h1>
      <div class="sub">Hotel Betania</div>
      <hr>
      <div class="row"><span class="label">Nº Factura</span><span>${inv.invoiceNumber}</span></div>
      <div class="row"><span class="label">Fecha emisión</span><span>${inv.issuedAt}</span></div>
      <hr>
      <div class="row"><span class="label">Cliente</span><span>${g.firstName ?? ''} ${g.lastName ?? ''}</span></div>
      ${g.idDocType ? `<div class="row"><span class="label">Documento</span><span>${g.idDocType.toUpperCase()} ${g.idDocNumber ?? ''}</span></div>` : ''}
      ${g.address1  ? `<div class="row"><span class="label">Dirección</span><span>${g.address1}${g.city ? ', ' + g.city : ''}</span></div>` : ''}
      <hr>
      ${r.id ? `
      <div class="row"><span class="label">Reserva</span><span>#${r.externalCode ?? r.id}</span></div>
      <div class="row"><span class="label">Habitación</span><span>${r.room?.code ?? '—'}</span></div>
      <div class="row"><span class="label">Entrada</span><span>${r.checkInDate ?? '—'}</span></div>
      <div class="row"><span class="label">Salida</span><span>${r.checkOutDate ?? '—'}</span></div>
      <div class="row"><span class="label">Noches</span><span>${r.nights ?? '—'}</span></div>
      <hr>` : ''}
      <div class="row"><span class="label">Subtotal</span><span>${fmt(inv.subtotal)} €</span></div>
      <div class="row"><span class="label">IVA</span><span>${fmt(inv.taxAmount)} €</span></div>
      <div class="row total"><span>TOTAL</span><span>${fmt(inv.total)} €</span></div>
      <div class="footer">Hotel Betania · Documento generado el ${new Date().toLocaleDateString('es-ES')}</div>
      <script>window.onload = () => { window.print() }<\/script>
    </body></html>`)
    win.document.close()
  } catch (err) { showToast(err.message, 'err') }
}
