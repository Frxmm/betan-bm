import { api } from '../api.js'

const CELL_W = 62
const ROW_H  = 42
const COL_W  = 210

const DAY_ES = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá']
const MON_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

// ── Cálculo de precio efectivo ────────────────────────────────────────────────
function computePrice(rate, date, priceMap, ratesById) {
  const entry = priceMap[rate.id]?.[date]
  if (entry !== undefined) return { price: parseFloat(entry.price), closed: entry.closed, isOverride: true }

  if (!rate.baseRateId) {
    return { price: parseFloat(rate.adjustValue ?? 0), closed: false, isOverride: false }
  }
  const base = ratesById[rate.baseRateId]
  if (!base) return { price: 0, closed: false, isOverride: false }
  const { price: basePrice } = computePrice(base, date, priceMap, ratesById)
  let derived = basePrice
  const adj = parseFloat(rate.adjustValue ?? 0)
  if (rate.adjustType === 'percentage') derived = basePrice * (1 + adj / 100)
  else if (rate.adjustType === 'amount') derived = basePrice + adj
  else if (rate.adjustType === 'fixed')  derived = adj
  return { price: Math.max(0, derived), closed: false, isOverride: false }
}

function dateRange(from, to) {
  const dates = [], cur = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00')
  while (cur <= end) { dates.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }
  return dates
}
function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10) }
function today()       { return new Date().toISOString().slice(0, 10) }
function fmtDate(d)    { if (!d) return ''; const dt = new Date(d + 'T00:00:00'); return `${dt.getDate()} ${MON_ES[dt.getMonth()]} ${dt.getFullYear()}` }

const _state = {
  dateFrom:    today(),
  dateTo:      addDays(today(), 29),
  selectedIds: null,
  data:        null,
}

// ── Multi-select state ────────────────────────────────────────────────────────
let _drag           = null
let _mouseupHandler = null   // ref para limpiar el handler anterior

export async function renderPriceCalendar(container) {
  container.innerHTML = ''
  container.style.padding = '0'
  const wrap = document.createElement('div')
  wrap.id = 'pcal-wrap'
  container.appendChild(wrap)
  wrap.innerHTML = '<div class="loading" style="padding:40px">Cargando calendario…</div>'
  await loadAndRender(wrap)
}

async function loadAndRender(wrap) {
  closeEditor()
  clearSelection()

  const { dateFrom, dateTo, selectedIds } = _state
  let data
  try {
    data = await api.ratesCalendar({
      dateFrom, dateTo,
      ...(selectedIds?.length ? { rateIds: selectedIds.join(',') } : {}),
    })
    _state.data = data
  } catch (e) {
    wrap.innerHTML = `<div class="empty" style="padding:40px"><p>Error: ${e.message}</p></div>`
    return
  }

  const { rates, allRates, priceMap } = data
  const ratesById = Object.fromEntries(allRates.map(r => [r.id, r]))
  const dates     = dateRange(dateFrom, dateTo)

  // Lista plana — sin concepto de tarifa base
  const displayRates = rates.slice().sort((a, b) => a.id - b.id)

  // Header meses
  const monthGroups = []
  let lastMonth = ''
  for (const d of dates) {
    const m = d.slice(0, 7)
    if (m !== lastMonth) {
      const dt = new Date(d + 'T00:00:00')
      monthGroups.push({ label: `${MON_ES[dt.getMonth()]} ${dt.getFullYear()}`, span: 1 })
      lastMonth = m
    } else { monthGroups[monthGroups.length - 1].span++ }
  }

  const totalW = COL_W + dates.length * CELL_W

  wrap.innerHTML = `
    <div id="pcal-toolbar">
      <button class="btn btn-ghost btn-sm" id="pcal-prev">◀</button>
      <span id="pcal-range">${fmtDate(dateFrom)} — ${fmtDate(dateTo)}</span>
      <button class="btn btn-ghost btn-sm" id="pcal-next">▶</button>
      <button class="btn btn-ghost btn-sm" id="pcal-today">Hoy</button>
      <div class="pcal-toolbar-sep"></div>
      <label style="font-size:12px;color:var(--text2)">Días:</label>
      <input id="pcal-days" type="number" min="7" max="90" value="${dates.length}"
        style="width:56px;background:var(--bg3);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:3px 6px;font-size:12px">
      <div class="pcal-toolbar-sep"></div>
      <button class="btn btn-ghost btn-sm" id="pcal-select-rates">Tarifas ▾</button>
      <div class="pcal-toolbar-sep"></div>
      <span class="pcal-legend-item pcal-loverride">Precio personalizado</span>
      <span class="pcal-legend-item pcal-lclosed">Cerrada</span>
      <span class="pcal-legend-item pcal-lderived">Derivada</span>
      <span style="font-size:11px;color:var(--text2);margin-left:4px">Arrastra para selección múltiple</span>
    </div>

    <div id="pcal-scroll-outer">
      <div id="pcal-grid" style="width:${totalW}px">

        <div class="pcal-header-row pcal-month-row">
          <div class="pcal-label-cell" style="width:${COL_W}px"></div>
          ${monthGroups.map(mg =>
            `<div class="pcal-month-cell" style="width:${mg.span * CELL_W}px">${mg.label}</div>`
          ).join('')}
        </div>

        <div class="pcal-header-row pcal-day-row">
          <div class="pcal-label-cell" style="width:${COL_W}px">
            <span style="font-size:11px;color:var(--text2)">${displayRates.length} tarifas</span>
          </div>
          ${dates.map(d => {
            const dt  = new Date(d + 'T00:00:00')
            const dow = dt.getDay()
            const isWE = dow === 0 || dow === 6
            const isTo = d === today()
            return `<div class="pcal-day-cell${isWE ? ' pcal-weekend' : ''}${isTo ? ' pcal-today' : ''}" style="width:${CELL_W}px">
              <span class="pcal-dow">${DAY_ES[dow]}</span>
              <span class="pcal-dn">${dt.getDate()}</span>
            </div>`
          }).join('')}
        </div>

        <div id="pcal-rows">
          ${displayRates.map(rate => buildRateRow(rate, dates, priceMap, ratesById)).join('')}
        </div>
      </div>
    </div>

    <div id="pcal-rate-selector" hidden>
      <div style="font-size:12px;font-weight:600;margin-bottom:8px">Mostrar tarifas:</div>
      ${allRates.map(r => `
        <label style="display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:13px">
          <input type="checkbox" data-rid="${r.id}"
            ${!_state.selectedIds || _state.selectedIds.includes(r.id) ? 'checked' : ''}>
          ${r.title}${r.locked ? ' 🔒' : ''}
        </label>`).join('')}
      <div style="margin-top:10px;display:flex;gap:6px">
        <button class="btn btn-sm btn-primary"   id="pcal-apply-sel">Aplicar</button>
        <button class="btn btn-sm btn-secondary" id="pcal-cancel-sel">Cancelar</button>
      </div>
    </div>
  `

  bindEvents(wrap, displayRates, dates, priceMap, ratesById, allRates)
}

function buildRateRow(rate, dates, priceMap, ratesById) {
  const isLocked   = rate.locked
  const isEditable = !isLocked && rate.userEditable
  const rowClass   = `pcal-rate-row${isLocked ? ' pcal-locked-row' : ''}`

  // Regla de creación compacta
  let rule = ''
  if (rate.baseRateId && ratesById[rate.baseRateId]) {
    const base = ratesById[rate.baseRateId]
    const adj  = parseFloat(rate.adjustValue ?? 0)
    const sign = adj >= 0 ? '+' : ''
    const fmt  = rate.adjustType === 'percentage' ? `${sign}${adj}%`
               : rate.adjustType === 'amount'     ? `${sign}${adj.toFixed(2)}€`
               : rate.adjustType === 'fixed'      ? `${adj.toFixed(2)}€ fijo`
               : ''
    rule = `<span class="pcal-rule-tag" title="Derivada de ${base.title}">← ${base.code ?? base.title.slice(0,8)} ${fmt}</span>`
  }

  const cells = dates.map(date => {
    const dt   = new Date(date + 'T00:00:00')
    const isWE = dt.getDay() === 0 || dt.getDay() === 6
    const isTo = date === today()
    const { price, closed, isOverride } = computePrice(rate, date, priceMap, ratesById)

    const cellClass = [
      'pcal-cell',
      isWE      ? 'pcal-weekend' : '',
      isTo      ? 'pcal-today'   : '',
      closed    ? 'pcal-closed'  : (isOverride ? 'pcal-override' : (rate.baseRateId ? 'pcal-derived-price' : 'pcal-base-price')),
      isEditable ? 'pcal-editable' : 'pcal-readonly',
    ].filter(Boolean).join(' ')

    const priceStr = closed ? 'CERR' : (price > 0 ? price.toFixed(2) : '—')

    return `<div class="${cellClass}" style="width:${CELL_W}px;height:${ROW_H}px"
                 data-rid="${rate.id}" data-date="${date}"
                 data-price="${price}" data-override="${isOverride}" data-closed="${closed}">
      <span class="pcal-price">${priceStr}</span>
      ${isOverride && !closed ? '<span class="pcal-dot">●</span>' : ''}
    </div>`
  }).join('')

  return `
    <div class="${rowClass}" style="min-height:${ROW_H}px" data-rate-id="${rate.id}">
      <div class="pcal-label-cell" style="width:${COL_W}px;height:${ROW_H}px">
        <div style="display:flex;flex-direction:column;gap:2px;overflow:hidden">
          <span class="pcal-rate-name">${isLocked ? '🔒 ' : ''}${rate.title}</span>
          <div style="display:flex;gap:4px;align-items:center">
            ${rate.code ? `<span class="pcal-rate-code">${rate.code}</span>` : ''}
            ${rule}
            ${!isEditable && !isLocked ? '<span class="pcal-readonly-badge">Solo admin</span>' : ''}
          </div>
        </div>
      </div>
      ${cells}
    </div>`
}

// ── Eventos ───────────────────────────────────────────────────────────────────
function bindEvents(wrap, displayRates, dates, priceMap, ratesById, allRates) {
  // Nav
  wrap.querySelector('#pcal-prev').onclick = () => {
    const n = dates.length
    _state.dateFrom = addDays(_state.dateFrom, -n); _state.dateTo = addDays(_state.dateTo, -n)
    loadAndRender(wrap)
  }
  wrap.querySelector('#pcal-next').onclick = () => {
    const n = dates.length
    _state.dateFrom = addDays(_state.dateFrom, n); _state.dateTo = addDays(_state.dateTo, n)
    loadAndRender(wrap)
  }
  wrap.querySelector('#pcal-today').onclick = () => {
    const n = dates.length
    _state.dateFrom = today(); _state.dateTo = addDays(today(), n - 1)
    loadAndRender(wrap)
  }
  wrap.querySelector('#pcal-days').onchange = (e) => {
    const n = Math.max(7, Math.min(90, parseInt(e.target.value) || 30))
    _state.dateTo = addDays(_state.dateFrom, n - 1)
    loadAndRender(wrap)
  }

  // Rate selector
  const selBtn   = wrap.querySelector('#pcal-select-rates')
  const selPanel = wrap.querySelector('#pcal-rate-selector')
  selBtn.onclick = (e) => { selPanel.hidden = !selPanel.hidden; e.stopPropagation() }
  wrap.querySelector('#pcal-cancel-sel').onclick = () => { selPanel.hidden = true }
  wrap.querySelector('#pcal-apply-sel').onclick  = () => {
    const checked = [...selPanel.querySelectorAll('input[data-rid]:checked')].map(i => Number(i.dataset.rid))
    _state.selectedIds = checked.length === allRates.length ? null : checked
    selPanel.hidden = true; loadAndRender(wrap)
  }

  // Scroll → fijar columna izquierda
  wrap.querySelector('#pcal-scroll-outer').addEventListener('scroll', function() {
    const x = this.scrollLeft
    wrap.querySelectorAll('.pcal-label-cell').forEach(el => { el.style.transform = `translateX(${x}px)` })
  })

  // ── Multi-select por arrastre ─────────────────────────────────────────────
  const rows = wrap.querySelector('#pcal-rows')

  rows.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('.pcal-editable')
    if (!cell) return
    e.preventDefault()
    closeEditor()
    clearSelection()
    const rateId = Number(cell.dataset.rid)
    _drag = { rateId, startDate: cell.dataset.date, endDate: cell.dataset.date, anchor: cell.dataset.date }
    cell.classList.add('pcal-selected')
    _drag.cells = new Set([cell.dataset.date])
  })

  rows.addEventListener('mousemove', (e) => {
    if (!_drag) return
    const cell = e.target.closest(`.pcal-cell[data-rid="${_drag.rateId}"]`)
    if (!cell) return
    const hoverDate = cell.dataset.date
    if (hoverDate === _drag.endDate) return
    _drag.endDate = hoverDate

    // Recalcular rango de selección
    const sorted = [_drag.anchor, hoverDate].sort()
    const range  = dateRange(sorted[0], sorted[1])
    _drag.cells  = new Set(range)

    // Actualizar clases
    rows.querySelectorAll(`.pcal-cell[data-rid="${_drag.rateId}"]`).forEach(c => {
      c.classList.toggle('pcal-selected', _drag.cells.has(c.dataset.date))
    })
  })

  if (_mouseupHandler) document.removeEventListener('mouseup', _mouseupHandler)
  _mouseupHandler = (e) => {
    if (!_drag) return
    const cells  = _drag.cells
    const rateId = _drag.rateId
    const rate   = displayRates.find(r => r.id === rateId)
    _drag = null

    // Siempre consulta el #pcal-rows actual — evita referencias a nodos huérfanos
    const currentRows = wrap.querySelector('#pcal-rows')
    if (cells.size === 1) {
      const date = [...cells][0]
      const cell = currentRows?.querySelector(`.pcal-cell[data-rid="${rateId}"][data-date="${date}"]`)
      if (cell && rate) openCellEditor(cell, rate, priceMap, ratesById, wrap)
    } else if (cells.size > 1 && rate) {
      const sortedDates = [...cells].sort()
      openBulkEditor(rateId, rate, sortedDates, priceMap, ratesById, wrap)
    }
  }
  document.addEventListener('mouseup', _mouseupHandler)
}

// ── Editor de celda individual ────────────────────────────────────────────────
function openCellEditor(cell, rate, priceMap, ratesById, wrap) {
  closeEditor()
  const date       = cell.dataset.date
  const { price, closed, isOverride } = computePrice(rate, date, priceMap, ratesById)

  const editor = document.createElement('div')
  editor.id = 'pcal-editor'
  editor.innerHTML = `
    <div class="pcal-editor-header">
      <span>${rate.title}</span>
      <span class="pcal-editor-date">${fmtDate(date)}</span>
    </div>
    <div class="pcal-editor-body">
      <input id="pcal-editor-input" type="number" step="0.01" min="0" value="${price.toFixed(2)}">
      <span class="pcal-editor-unit">€</span>
    </div>
    <label class="pcal-close-label">
      <input type="checkbox" id="pcal-editor-closed" ${closed ? 'checked' : ''}>
      Cerrar tarifa (cierre de canal)
    </label>
    <div class="pcal-editor-actions">
      <button class="btn btn-xs btn-primary" id="pcal-editor-save">Guardar</button>
      ${isOverride ? '<button class="btn btn-xs btn-ghost" id="pcal-editor-reset">↩ Limpiar</button>' : ''}
      <button class="btn btn-xs btn-ghost" id="pcal-editor-cancel">✕</button>
    </div>
  `
  positionEditor(editor, cell)
  document.body.appendChild(editor)

  const input = document.getElementById('pcal-editor-input')
  input.focus(); input.select()

  const save = async () => {
    const val      = parseFloat(input.value)
    const isClosed = document.getElementById('pcal-editor-closed').checked
    if (isNaN(val) || val < 0) return
    try {
      await api.setDailyPrice(rate.id, date, { price: val, closed: isClosed })
      if (!priceMap[rate.id]) priceMap[rate.id] = {}
      priceMap[rate.id][date] = { price: val.toFixed(2), closed: isClosed }
      // Re-consultar la celda del DOM actual (no confiar en la referencia capturada en el cierre)
      const freshCell = wrap.querySelector(`#pcal-rows .pcal-cell[data-rid="${rate.id}"][data-date="${date}"]`)
      if (freshCell) updateCell(freshCell, rate, date, priceMap, ratesById)
      updateDerivedCells(rate.id, date, priceMap, ratesById, wrap)
      closeEditor(); clearSelection()
    } catch (e) { alert('Error: ' + e.message) }
  }

  document.getElementById('pcal-editor-save').onclick   = save
  document.getElementById('pcal-editor-cancel').onclick = () => { closeEditor(); clearSelection() }
  document.getElementById('pcal-editor-reset')?.addEventListener('click', async () => {
    try {
      await api.deleteDailyPrice(rate.id, date)
      if (priceMap[rate.id]) delete priceMap[rate.id][date]
      const freshCell = wrap.querySelector(`#pcal-rows .pcal-cell[data-rid="${rate.id}"][data-date="${date}"]`)
      if (freshCell) updateCell(freshCell, rate, date, priceMap, ratesById)
      updateDerivedCells(rate.id, date, priceMap, ratesById, wrap)
      closeEditor(); clearSelection()
    } catch (e) { alert('Error: ' + e.message) }
  })
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { closeEditor(); clearSelection() } })
  setTimeout(() => {
    document.addEventListener('mousedown', (e) => {
      if (!document.getElementById('pcal-editor')?.contains(e.target)) { closeEditor(); clearSelection() }
    }, { once: true })
  }, 10)
}

// ── Editor en bloque ──────────────────────────────────────────────────────────
function openBulkEditor(rateId, rate, dates, priceMap, ratesById, wrap) {
  closeEditor()

  // Precio sugerido: valor del primer día
  const first = computePrice(rate, dates[0], priceMap, ratesById)

  const editor = document.createElement('div')
  editor.id = 'pcal-editor'
  editor.innerHTML = `
    <div class="pcal-editor-header">
      <span>${rate.title}</span>
      <span class="pcal-editor-date">${dates.length} días</span>
    </div>
    <div style="font-size:11px;color:var(--text2);margin-bottom:6px">
      ${fmtDate(dates[0])} → ${fmtDate(dates[dates.length - 1])}
    </div>

    <label style="display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:8px;cursor:pointer">
      <input type="checkbox" id="pcal-bulk-change-price" checked>
      Cambiar precio
    </label>
    <div class="pcal-editor-body" id="pcal-bulk-price-wrap">
      <input id="pcal-bulk-input" type="number" step="0.01" min="0" value="${first.price.toFixed(2)}">
      <span class="pcal-editor-unit">€</span>
    </div>

    <label class="pcal-close-label" style="margin-top:8px">
      <input type="checkbox" id="pcal-bulk-closed" ${first.closed ? 'checked' : ''}>
      Cerrar tarifa (cierre de canal)
    </label>

    <div class="pcal-editor-actions" style="margin-top:10px">
      <button class="btn btn-xs btn-primary" id="pcal-bulk-save">Aplicar a ${dates.length} días</button>
      <button class="btn btn-xs btn-danger"  id="pcal-bulk-clear">Limpiar overrides</button>
      <button class="btn btn-xs btn-ghost"   id="pcal-bulk-cancel">✕</button>
    </div>
  `

  // Posicionar centrado en la selección
  const firstCell = wrap.querySelector(`.pcal-cell[data-rid="${rateId}"][data-date="${dates[0]}"]`)
  positionEditor(editor, firstCell)
  document.body.appendChild(editor)

  const changePriceCheck = document.getElementById('pcal-bulk-change-price')
  const priceWrap        = document.getElementById('pcal-bulk-price-wrap')
  changePriceCheck.onchange = () => { priceWrap.style.opacity = changePriceCheck.checked ? '1' : '0.4' }

  const input = document.getElementById('pcal-bulk-input')
  input.focus(); input.select()

  const save = async () => {
    const isClosed     = document.getElementById('pcal-bulk-closed').checked
    const changePrice  = changePriceCheck.checked
    const val          = parseFloat(input.value)
    if (changePrice && (isNaN(val) || val < 0)) { alert('Precio inválido'); return }

    try {
      const entries = dates.map(date => ({
        date,
        ...(changePrice ? { price: val } : {}),
        closed: isClosed,
      }))
      await api.bulkDailyPrices(rateId, entries)
      closeEditor(); clearSelection()

      // Actualizar priceMap local
      if (!priceMap[rateId]) priceMap[rateId] = {}
      for (const date of dates) {
        const existing = priceMap[rateId][date]
        const existingPrice = existing?.price ?? computePrice(rate, date, {}, ratesById).price.toFixed(2)
        priceMap[rateId][date] = {
          price:  changePrice ? val.toFixed(2) : existingPrice,
          closed: isClosed,
        }
        const cell = wrap.querySelector(`.pcal-cell[data-rid="${rateId}"][data-date="${date}"]`)
        if (cell) {
          updateCell(cell, rate, date, priceMap, ratesById)
          updateDerivedCells(rateId, date, priceMap, ratesById, wrap)
        }
      }
    } catch (e) { alert('Error: ' + e.message) }
  }

  const clearAll = async () => {
    if (!confirm(`¿Limpiar los overrides de ${dates.length} días? Volverán al precio calculado.`)) return
    try {
      await Promise.all(dates.map(date => api.deleteDailyPrice(rateId, date).catch(() => {})))
      closeEditor(); clearSelection()
      for (const date of dates) {
        if (priceMap[rateId]) delete priceMap[rateId][date]
        const cell = wrap.querySelector(`.pcal-cell[data-rid="${rateId}"][data-date="${date}"]`)
        if (cell) { updateCell(cell, rate, date, priceMap, ratesById); updateDerivedCells(rateId, date, priceMap, ratesById, wrap) }
      }
    } catch (e) { alert('Error: ' + e.message) }
  }

  document.getElementById('pcal-bulk-save').onclick   = save
  document.getElementById('pcal-bulk-clear').onclick  = clearAll
  document.getElementById('pcal-bulk-cancel').onclick = () => { closeEditor(); clearSelection() }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { closeEditor(); clearSelection() } })
  setTimeout(() => {
    document.addEventListener('mousedown', (e) => {
      if (!document.getElementById('pcal-editor')?.contains(e.target)) { closeEditor(); clearSelection() }
    }, { once: true })
  }, 10)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function positionEditor(editor, anchor) {
  if (!anchor) { editor.style.position = 'fixed'; editor.style.left = '200px'; editor.style.top = '200px'; return }
  const rect = anchor.getBoundingClientRect()
  editor.style.position = 'fixed'
  editor.style.left = Math.min(rect.left, window.innerWidth  - 260) + 'px'
  editor.style.top  = Math.min(rect.bottom + 4, window.innerHeight - 250) + 'px'
}

function closeEditor()    { document.getElementById('pcal-editor')?.remove() }
function clearSelection() {
  document.querySelectorAll('.pcal-selected').forEach(c => c.classList.remove('pcal-selected'))
  _drag = null
}

function updateCell(cell, rate, date, priceMap, ratesById) {
  const { price, closed, isOverride } = computePrice(rate, date, priceMap, ratesById)
  const priceSpan = cell.querySelector('.pcal-price')
  priceSpan.textContent = closed ? 'CERR' : (price > 0 ? price.toFixed(2) : '—')

  let dot = cell.querySelector('.pcal-dot')
  if (isOverride && !closed) {
    if (!dot) { dot = document.createElement('span'); dot.className = 'pcal-dot'; dot.textContent = '●'; cell.appendChild(dot) }
  } else if (dot) { dot.remove() }

  cell.dataset.price    = String(price)
  cell.dataset.override = String(isOverride)
  cell.dataset.closed   = String(closed)
  cell.classList.toggle('pcal-closed',        closed)
  cell.classList.toggle('pcal-override',      !closed && isOverride)
  cell.classList.toggle('pcal-base-price',    !closed && !isOverride && !rate.baseRateId)
  cell.classList.toggle('pcal-derived-price', !closed && !isOverride &&  !!rate.baseRateId)
}

function updateDerivedCells(baseRateId, date, priceMap, ratesById, wrap) {
  wrap.querySelectorAll(`.pcal-cell[data-date="${date}"]`).forEach(cell => {
    const rate = ratesById[Number(cell.dataset.rid)]
    if (rate && rate.baseRateId === baseRateId) updateCell(cell, rate, date, priceMap, ratesById)
  })
}
