import { api } from '../api.js'
import { modal } from '../helpers.js'

// ── Colores por operador ──────────────────────────────────────────────────────
const OP_COLORS = {
  booking:   { bg: '#003580', color: '#fff' },
  airbnb:    { bg: '#ff385c', color: '#fff' },
  expedia:   { bg: '#00355f', color: '#ffcc00' },
  agoda:     { bg: '#e5383b', color: '#fff' },
  hotelbeds: { bg: '#0066cc', color: '#fff' },
  despegar:  { bg: '#00a1e4', color: '#fff' },
  tui:       { bg: '#c8102e', color: '#fff' },
}

function opBadge(op) {
  if (!op) return ''
  const c = OP_COLORS[op.code] ?? { bg: 'var(--bg3)', color: 'var(--text2)' }
  return `<span class="rate-op-badge" style="background:${c.bg};color:${c.color}" title="${op.name}">${op.name}</span>`
}

function ruleBadge(rate, ratesById) {
  if (!rate.baseRateId) return '<span class="rate-rule-badge" style="opacity:0.4">Independiente</span>'
  const base = ratesById[rate.baseRateId]
  const baseName = base ? (base.code ?? base.title) : `#${rate.baseRateId}`
  if (!rate.adjustType || rate.adjustValue == null) {
    return `<span class="rate-rule-badge">← ${baseName}</span>`
  }
  const adj  = parseFloat(rate.adjustValue)
  const sign = adj >= 0 ? '+' : ''
  const fmt  = rate.adjustType === 'percentage' ? `${sign}${adj}%`
             : rate.adjustType === 'amount'     ? `${sign}${adj.toFixed(2)} €`
             : rate.adjustType === 'fixed'      ? `${adj.toFixed(2)} € fijo`
             : ''
  return `<span class="rate-rule-badge" title="Regla de creación">← ${baseName} ${fmt}</span>`
}

function lockIcon(rate) {
  if (rate.locked) return `<button class="rate-lock-btn locked" title="Bloqueada — clic para desbloquear (admin)" onclick="window._rateUnlock(${rate.id})">🔒</button>`
  return `<button class="rate-lock-btn unlocked" title="Bloquear tarifa" onclick="window._rateLock(${rate.id})">🔓</button>`
}

function editableToggle(rate) {
  const checked = rate.userEditable ? 'checked' : ''
  const disabled = rate.locked ? 'disabled title="Desbloquea primero"' : ''
  return `<label class="rate-toggle ${rate.locked ? 'rate-toggle-disabled' : ''}" title="Editable por usuario">
    <input type="checkbox" ${checked} ${disabled} onchange="window._rateToggleEditable(${rate.id}, this.checked)">
    <span>Usuario</span>
  </label>`
}

export async function renderRates(container) {
  container.innerHTML = '<div class="loading">Cargando tarifas…</div>'

  let rates, operators
  try {
    ;[{ data: rates }, { data: operators }] = await Promise.all([
      api.listRates(),
      api.listOperators(),
    ])
  } catch (e) {
    container.innerHTML = `<div class="empty"><p>Error: ${e.message}</p></div>`
    return
  }

  const ratesById = Object.fromEntries(rates.map(r => [r.id, r]))
  const opById    = Object.fromEntries(operators.map(o => [o.id, o]))

  // Lista plana ordenada por id — sin jerarquía base/derivada
  const sortedRates = rates.slice().sort((a, b) => a.id - b.id)

  function rateRow(rate) {
    const op          = rate.operatorId ? opById[rate.operatorId] : rate.operator ?? null
    const editDisabled = rate.locked || !rate.userEditable ? 'disabled' : ''
    const rowClass    = `rate-row rate-row-flat${rate.locked ? ' rate-row-locked' : ''}`

    // El valor editable siempre es adjustValue (independientemente de si tiene relación o no)
    const valueDisplay = `<input class="rate-price-input" type="number" step="0.01" min="0"
        value="${parseFloat(rate.adjustValue ?? 0).toFixed(2)}"
        ${editDisabled}
        onblur="window._rateSavePrice(${rate.id}, this)"
        onkeydown="if(event.key==='Enter')this.blur()">`

    return `
      <div class="${rowClass}" data-id="${rate.id}">
        <div class="rate-col-name">
          <span class="rate-title">${rate.title}</span>
          ${rate.code ? `<span class="rate-code">${rate.code}</span>` : ''}
        </div>
        <div class="rate-col-rule">${ruleBadge(rate, ratesById)}</div>
        <div class="rate-col-op">${opBadge(op)}</div>
        <div class="rate-col-value">${valueDisplay}</div>
        <div class="rate-col-controls">
          ${editableToggle(rate)}
          ${lockIcon(rate)}
          <button class="btn btn-ghost btn-xs" title="Editar tarifa" onclick="window._rateEdit(${rate.id})">✎</button>
        </div>
      </div>`
  }

  container.innerHTML = `
    <div class="view-header">
      <div>
        <h2>Tarifas</h2>
        <p class="view-subtitle">${rates.length} tarifas · ${operators.length} operadores</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-secondary" onclick="window._rateManageOperators()">Operadores</button>
        <button class="btn btn-primary" onclick="window._rateNew()">+ Nueva tarifa</button>
      </div>
    </div>

    <div class="rates-table-header rate-row">
      <div class="rate-col-name">Tarifa</div>
      <div class="rate-col-rule">Regla de creación</div>
      <div class="rate-col-op">Operador</div>
      <div class="rate-col-value">Ajuste / Precio</div>
      <div class="rate-col-controls">Control</div>
    </div>

    <div id="rates-list">
      ${sortedRates.map(r => rateRow(r)).join('')}
    </div>

    ${operators.length ? `
    <div class="rates-operators-panel">
      <h3>Operadores conectados</h3>
      <div class="op-chips">
        ${operators.map(o => {
          const c = OP_COLORS[o.code] ?? { bg: 'var(--bg3)', color: 'var(--text2)' }
          return `<span class="op-chip" style="background:${c.bg};color:${c.color}">${o.name}</span>`
        }).join('')}
      </div>
    </div>` : ''}
  `

  // ── Handlers globales ───────────────────────────────────────────────────────

  window._rateSavePrice = async (id, input) => {
    const val = parseFloat(input.value)
    if (isNaN(val) || val < 0) { input.value = parseFloat(input.defaultValue).toFixed(2); return }
    try {
      await api.updateRate(id, { adjustValue: val })
      input.defaultValue = val.toFixed(2)
      input.closest('.rate-row').classList.add('rate-saved')
      setTimeout(() => input.closest('.rate-row')?.classList.remove('rate-saved'), 1000)
    } catch (e) {
      alert('Error al guardar: ' + e.message)
      input.value = input.defaultValue
    }
  }

  window._rateToggleEditable = async (id, value) => {
    try {
      await api.updateRate(id, { userEditable: value })
    } catch (e) {
      alert('Error: ' + e.message)
      renderRates(container)
    }
  }

  window._rateLock = async (id) => {
    if (!confirm('¿Bloquear esta tarifa? Los usuarios no podrán editarla hasta que la desbloquees.')) return
    try {
      await api.lockRate(id)
      renderRates(container)
    } catch (e) { alert('Error: ' + e.message) }
  }

  window._rateUnlock = async (id) => {
    try {
      await api.unlockRate(id)
      renderRates(container)
    } catch (e) { alert('Error: ' + e.message) }
  }

  window._rateEdit = (id) => {
    const rate = ratesById[id]
    if (!rate) return
    openEditModal(rate, rates, operators, container)
  }

  window._rateNew = () => {
    openEditModal(null, rates, operators, container)
  }

  window._rateManageOperators = () => {
    openOperatorsModal(operators, container)
  }
}

// ── Modal de edición de tarifa ────────────────────────────────────────────────
function openEditModal(rate, allRates, operators, container) {
  const isNew   = !rate
  const title   = isNew ? 'Nueva tarifa' : `Editar tarifa: ${rate.title}`
  const baseOptions = allRates
    .filter(r => !r.baseRateId && (!rate || r.id !== rate.id))
    .map(r => `<option value="${r.id}" ${rate?.baseRateId === r.id ? 'selected' : ''}>${r.title}</option>`)
    .join('')
  const opOptions = operators
    .map(o => `<option value="${o.id}" ${rate?.operatorId === o.id ? 'selected' : ''}>${o.name}</option>`)
    .join('')

  const body = `
    <div class="form-grid-2">
      <div class="field">
        <label>Nombre</label>
        <input id="re-title" type="text" value="${rate?.title ?? ''}" placeholder="Ej: Tarifa Booking +10%">
      </div>
      <div class="field">
        <label>Código</label>
        <input id="re-code" type="text" value="${rate?.code ?? ''}" placeholder="Ej: WEB_AL">
      </div>
    </div>

    <div class="field">
      <label>Descripción</label>
      <input id="re-desc" type="text" value="${rate?.description ?? ''}" placeholder="Descripción opcional">
    </div>

    <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px">
      <legend style="padding:0 6px;color:var(--text2);font-size:12px">Regla de creación</legend>
      <div class="form-grid-2">
        <div class="field">
          <label>Tarifa base</label>
          <select id="re-base">
            <option value="">— Es tarifa base —</option>
            ${baseOptions}
          </select>
        </div>
        <div class="field" id="re-adj-wrap">
          <label>Ajuste</label>
          <div style="display:flex;gap:6px">
            <select id="re-adj-type" style="width:130px">
              <option value="fixed"      ${rate?.adjustType === 'fixed'      ? 'selected' : ''}>Fijo (€)</option>
              <option value="percentage" ${rate?.adjustType === 'percentage' ? 'selected' : ''}>Porcentaje (%)</option>
              <option value="amount"     ${rate?.adjustType === 'amount'     ? 'selected' : ''}>Importe (+€)</option>
            </select>
            <input id="re-adj-value" type="number" step="0.01"
              value="${rate?.adjustValue ?? '0'}" style="flex:1">
          </div>
        </div>
      </div>
    </fieldset>

    <fieldset style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:12px">
      <legend style="padding:0 6px;color:var(--text2);font-size:12px">Operador y permisos</legend>
      <div class="form-grid-2">
        <div class="field">
          <label>Operador (OTA)</label>
          <select id="re-operator">
            <option value="">— Sin operador —</option>
            ${opOptions}
          </select>
        </div>
        <div class="field" style="display:flex;align-items:center;gap:16px;padding-top:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
            <input type="checkbox" id="re-user-editable" ${rate?.userEditable !== false ? 'checked' : ''}>
            Editable por usuario
          </label>
        </div>
      </div>
    </fieldset>
  `

  modal(title, body, `
    <button class="btn btn-secondary" data-close>Cancelar</button>
    <button class="btn btn-primary" id="re-save">Guardar</button>
  `)

  // Mostrar/ocultar ajuste según si es base o derivada
  const baseSelect = document.getElementById('re-base')
  const adjWrap    = document.getElementById('re-adj-wrap')
  const toggleAdj  = () => { adjWrap.style.opacity = baseSelect.value ? '1' : '0.35' }
  baseSelect.addEventListener('change', toggleAdj)
  toggleAdj()

  document.getElementById('re-save').onclick = async () => {
    const titleVal = document.getElementById('re-title').value.trim()
    if (!titleVal) { alert('El nombre es obligatorio'); return }

    const payload = {
      title:        titleVal,
      description:  document.getElementById('re-desc').value.trim() || null,
      baseRateId:   document.getElementById('re-base').value ? Number(document.getElementById('re-base').value) : null,
      adjustType:   document.getElementById('re-adj-type').value,
      adjustValue:  parseFloat(document.getElementById('re-adj-value').value) || 0,
      operatorId:   document.getElementById('re-operator').value ? Number(document.getElementById('re-operator').value) : null,
      userEditable: document.getElementById('re-user-editable').checked,
    }

    try {
      if (isNew) {
        await fetch('/api/catalog/rates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, propertyId: 1, active: true }),
        })
      } else {
        await api.updateRate(rate.id, payload)
      }
      document.querySelector('[data-close]')?.click()
      renderRates(container)
    } catch (e) {
      alert('Error al guardar: ' + e.message)
    }
  }
}

// ── Modal gestión de operadores ───────────────────────────────────────────────
function openOperatorsModal(operators, container) {
  const rows = operators.map(o => {
    const c = OP_COLORS[o.code] ?? { bg: 'var(--bg3)', color: 'var(--text2)' }
    return `
      <div class="op-row" data-id="${o.id}">
        <span class="op-chip" style="background:${c.bg};color:${c.color}">${o.name}</span>
        <span style="color:var(--text2);font-size:12px">${o.code}</span>
        <span style="flex:1"></span>
        <button class="btn btn-ghost btn-xs" onclick="window._opEdit(${o.id})">✎</button>
      </div>`
  }).join('')

  modal('Operadores', `
    <div style="margin-bottom:12px">
      ${rows || '<p style="color:var(--text2);font-size:13px">No hay operadores</p>'}
    </div>
    <hr style="border-color:var(--border);margin:12px 0">
    <div class="form-grid-2">
      <div class="field"><label>Nombre</label><input id="op-name" type="text" placeholder="Booking.com"></div>
      <div class="field"><label>Código</label><input id="op-code" type="text" placeholder="booking"></div>
    </div>
    <div class="field"><label>URL logo</label><input id="op-logo" type="text" placeholder="https://…"></div>
  `, `
    <button class="btn btn-secondary" data-close>Cerrar</button>
    <button class="btn btn-primary" id="op-add">+ Añadir operador</button>
  `)

  document.getElementById('op-add').onclick = async () => {
    const name = document.getElementById('op-name').value.trim()
    const code = document.getElementById('op-code').value.trim()
    if (!name || !code) { alert('Nombre y código son obligatorios'); return }
    try {
      await api.createOperator({ name, code, logoUrl: document.getElementById('op-logo').value.trim() })
      document.querySelector('[data-close]')?.click()
      renderRates(container)
    } catch (e) { alert('Error: ' + e.message) }
  }
}
