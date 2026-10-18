import { useState, useEffect, useRef, useCallback, Fragment, type CSSProperties } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, Legend, ResponsiveContainer,
} from 'recharts'
import { api } from '../lib/api'
import { today, addDays, toast } from '../lib/utils'
import { useAuth, canManage, hasRole } from '../contexts/AuthContext'

// ── Constants ─────────────────────────────────────────────────────────────────
const CELL_W = 62
const ROW_H  = 42
const COL_W  = 210
const DAY_ES = ['Do', 'Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá']
const MON_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']

function localISO(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
function dateRange(from: string, to: string) {
  const dates: string[] = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to   + 'T12:00:00')
  while (cur <= end) { dates.push(localISO(cur)); cur.setDate(cur.getDate() + 1) }
  return dates
}
function fmtDateCal(d: string) {
  if (!d) return ''
  const dt = new Date(d + 'T00:00:00')
  return `${dt.getDate()} ${MON_ES[dt.getMonth()]} ${dt.getFullYear()}`
}

// Une precios compartidos (roomTypeId=null) con los específicos de un tipo de
// habitación. El merge debe ser POR FECHA dentro de cada tarifa: un spread
// superficial reemplazaría el mapa de fechas completo y ocultaría los precios
// compartidos de la tarifa base en cuanto exista un solo override específico.
function mergePriceMaps(
  nullMap: Record<number, Record<string, any>>,
  rtMap: Record<number, Record<string, any>>
): Record<number, Record<string, any>> {
  const out: Record<number, Record<string, any>> = { ...nullMap }
  for (const rid of Object.keys(rtMap)) {
    out[Number(rid)] = { ...(nullMap[Number(rid)] ?? {}), ...rtMap[Number(rid)] }
  }
  return out
}

// rtPriceMap: { [rateId]: { [date]: { price, closed } } } — ya acotado al tipo de habitación
function computePrice(
  rate: any, date: string,
  rtPriceMap: Record<number, Record<string, { price: string; closed: boolean }>>,
  ratesById: Record<number, any>,
  occupancy = 1
): { price: number; closed: boolean; isOverride: boolean } {
  const entry = rtPriceMap[rate.id]?.[date]
  if (entry !== undefined) return { price: parseFloat(entry.price), closed: entry.closed, isOverride: true }
  if (!rate.baseRateId) return { price: parseFloat(rate.adjustValue ?? 0), closed: false, isOverride: false }
  const base = ratesById[rate.baseRateId]
  if (!base) return { price: 0, closed: false, isOverride: false }
  const { price: basePrice } = computePrice(base, date, rtPriceMap, ratesById, occupancy)
  let derived = basePrice
  const adj = parseFloat(rate.adjustValue ?? 0)
  if (rate.adjustType === 'percentage')       derived = basePrice * (1 + adj / 100)
  else if (rate.adjustType === 'amount')      derived = basePrice + adj
  else if (rate.adjustType === 'fixed')       derived = basePrice + adj
  else if (rate.adjustType === 'per_person')  derived = basePrice + adj * occupancy
  return { price: Math.max(0, derived), closed: false, isOverride: false }
}

// Igual que computePrice, pero si el TIPO DE HABITACIÓN deriva de otro, se
// calcula SIEMPRE desde el tipo base — ignora cualquier precio propio que
// pudiera haber quedado guardado (de antes de marcarlo como derivado). Mismo
// criterio que el backend: el único tipo con precio editable es el que no
// deriva de ningún otro.
function resolveRoomTypePrice(
  rate: any, date: string, roomTypeId: number | null,
  priceMap: Record<string, Record<number, Record<string, any>>>,
  ratesById: Record<number, any>,
  roomTypesById: Record<number, any>,
  occupancy = 1,
  depth = 0
): { price: number; closed: boolean; isOverride: boolean } {
  const rt = roomTypeId != null ? roomTypesById[roomTypeId] : null

  if (rt?.baseRoomTypeId && depth <= 5) {
    const base = resolveRoomTypePrice(rate, date, rt.baseRoomTypeId, priceMap, ratesById, roomTypesById, occupancy, depth + 1)
    if (base.price <= 0 && !base.isOverride) return { price: 0, closed: false, isOverride: false }
    const adj = parseFloat(rt.adjustValue ?? 0)
    let derived = base.price
    if (rt.adjustType === 'percentage')  derived = base.price * (1 + adj / 100)
    else if (rt.adjustType === 'amount') derived = base.price + adj
    else if (rt.adjustType === 'fixed')  derived = base.price + adj
    return { price: Math.max(0, derived), closed: false, isOverride: false }
  }

  const rtKey      = roomTypeId != null ? String(roomTypeId) : 'null'
  const rtPriceMap = mergePriceMaps(priceMap['null'] ?? {}, priceMap[rtKey] ?? {})
  return computePrice(rate, date, rtPriceMap, ratesById, occupancy)
}

// Compara un precio con el ADR real de SU semana ISO (adrByDate ya trae, por
// fecha, el ADR de la semana a la que pertenece — ver GET /catalog/rates/calendar).
// null cuando no hay nada que comparar: celda cerrada, sin precio, o semana
// sin ninguna noche ocupada todavía (adr null, no 0 — evita pintar "por
// encima" en semanas futuras sin reservas por el mero hecho de tener precio > 0).
function adrClassFor(price: number, closed: boolean, adr: number | null | undefined): '' | 'pcal-adr-above' | 'pcal-adr-below' {
  if (closed || price <= 0 || adr == null) return ''
  const diff = price - adr
  if (Math.abs(diff) < 0.005) return ''
  return diff > 0 ? 'pcal-adr-above' : 'pcal-adr-below'
}
function adrTitleFor(adr: number | null | undefined): string {
  return adr != null ? `ADR real de la semana: ${adr.toFixed(2)}€` : ''
}

function buildRateRow(
  rate: any, dates: string[],
  priceMap: Record<string, Record<number, Record<string, any>>>,
  ratesById: Record<number, any>,
  roomTypeId: number | null,
  roomTypesById: Record<number, any>,
  occupancy = 1,
  adrByDate: Record<string, number | null> = {}
): string {
  const isLocked      = rate.locked
  const rt             = roomTypeId != null ? roomTypesById[roomTypeId] : null
  const isRoomTypeDerived = !!rt?.baseRoomTypeId
  const isEditable     = !isLocked && rate.userEditable && !isRoomTypeDerived
  const rowClass       = `pcal-rate-row${!isEditable ? ' pcal-noedit-row' : ''}`
  const rtid           = roomTypeId ?? ''

  let rule = ''
  if (rate.baseRateId && ratesById[rate.baseRateId]) {
    const base = ratesById[rate.baseRateId]
    const adj  = parseFloat(rate.adjustValue ?? 0)
    const sign = adj >= 0 ? '+' : ''
    const fmt  = rate.adjustType === 'percentage'  ? `${sign}${adj}%`
               : rate.adjustType === 'amount'      ? `${sign}${adj.toFixed(2)}€`
               : rate.adjustType === 'fixed'       ? `${sign}${adj.toFixed(2)}€`
               : rate.adjustType === 'per_person'  ? `${sign}${adj.toFixed(2)}€/pers`
               : ''
    rule = `<span class="pcal-rule-tag" title="Derivada de ${base.title}">← ${base.code ?? base.title.slice(0, 8)} ${fmt}</span>`
  }

  const cells = dates.map(date => {
    const dt   = new Date(date + 'T00:00:00')
    const isWE = dt.getDay() === 0 || dt.getDay() === 6
    const isTo = date === today()
    const { price, closed, isOverride } = resolveRoomTypePrice(rate, date, roomTypeId, priceMap, ratesById, roomTypesById, occupancy)
    const cellClass = [
      'pcal-cell',
      isWE   ? 'pcal-weekend' : '',
      isTo   ? 'pcal-today'   : '',
      closed ? 'pcal-closed' : (isOverride ? 'pcal-override' : (rate.baseRateId ? 'pcal-derived-price' : 'pcal-base-price')),
      isEditable ? 'pcal-editable' : 'pcal-readonly',
    ].filter(Boolean).join(' ')
    const priceStr  = closed ? 'CERR' : (price > 0 ? price.toFixed(2) : '—')
    const adr       = adrByDate[date]
    const adrClass  = adrClassFor(price, closed, adr)
    const adrTitle  = adrTitleFor(adr)
    return `<div class="${cellClass}" style="width:${CELL_W}px;height:${ROW_H}px"
                 data-rid="${rate.id}" data-date="${date}" data-rtid="${rtid}"
                 data-price="${price}" data-override="${isOverride}" data-closed="${closed}"
                 ${adrTitle ? `title="${adrTitle}"` : ''}>
      <span class="pcal-price${adrClass ? ' ' + adrClass : ''}">${priceStr}</span>
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
            ${isRoomTypeDerived ? `<span class="pcal-readonly-badge" title="Se calcula a partir de ${roomTypesById[rt.baseRoomTypeId]?.name ?? 'otro tipo'}, no es editable">Solo admin</span>`
              : (!isEditable && !isLocked ? '<span class="pcal-readonly-badge">Solo admin</span>' : '')}
          </div>
        </div>
      </div>
      ${cells}
    </div>`
}

function clearSelectionDOM() { document.querySelectorAll('.pcal-selected').forEach(c => c.classList.remove('pcal-selected')) }

// ── Fila resumen global ──────────────────────────────────────────────────────
// Una única fila, por encima de todos los tipos de habitación, con — por día —
// el total de unidades libres de TODA la propiedad (todos los tipos, sin
// aplicar el filtro de tarifas/tipos visibles), el % de ocupación coloreado
// con la misma regla que Informes → Ocupación (verde ≥80%, azul ≥60%, ámbar
// ≥40%, gris el resto), y hasta 3 marcas de lead time medio de Booking.com
// (ventanas de 6, 28 y 64 días hacia atrás desde hoy — mismo cálculo y mismo
// canal que usa la regla de precio lead_time_dip, no el promedio de todos
// los canales: Booking sigue siendo el canal mayoritario, así que es la
// referencia real que mueve el precio) señalando en qué día caería
// "hoy + lead time medio" de cada ventana.
const SUMMARY_ROW_H = 48
const LEAD_WINDOWS: { key: '6' | '28' | '64'; days: number; label: string; color: string }[] = [
  { key: '6',  days: 6,  label: 'L6',  color: '#22c55e' },
  { key: '28', days: 28, label: 'L28', color: '#3b82f6' },
  { key: '64', days: 64, label: 'L64', color: '#a855f7' },
]

function occColor(pct: number) {
  if (pct >= 80) return '#22c55e'
  if (pct >= 60) return '#3b82f6'
  if (pct >= 40) return '#f59e0b'
  return '#94a3b8'
}

function buildSummaryRow(
  dates: string[],
  availTotals: Record<string, number>,
  availOccupied: Record<string, Record<string, number>>,
  availOverrides: Record<string, Record<string, number>>,
  leadTimeWindows: { '6': number | null; '28': number | null; '64': number | null } | null | undefined,
  todayIso: string | undefined,
): string {
  const totalRooms = Object.values(availTotals).reduce((s, n) => s + n, 0)
  const anchor = todayIso ?? today()

  // Fecha objetivo ("hoy + lead time medio", redondeado) por ventana — varias
  // ventanas pueden coincidir en el mismo día.
  const targetsByDate: Record<string, typeof LEAD_WINDOWS[number][]> = {}
  for (const w of LEAD_WINDOWS) {
    const avgLead = leadTimeWindows?.[w.key] ?? null
    if (avgLead == null) continue
    const dt = new Date(anchor + 'T12:00:00Z')
    dt.setUTCDate(dt.getUTCDate() + Math.round(avgLead))
    const targetDate = dt.toISOString().slice(0, 10)
    ;(targetsByDate[targetDate] ??= []).push(w)
  }

  const cells = dates.map(date => {
    let avail = 0
    for (const rtKey of Object.keys(availTotals)) {
      const total = availTotals[rtKey] ?? 0
      const ov    = availOverrides[rtKey]?.[date] ?? null
      const occ   = availOccupied[rtKey]?.[date] ?? 0
      avail += ov !== null ? Math.max(0, ov) : Math.max(0, total - occ)
    }
    const occPct = totalRooms > 0 ? Math.round((1 - avail / totalRooms) * 100) : 0
    const color  = occColor(occPct)

    const dt   = new Date(date + 'T00:00:00')
    const isWE = dt.getDay() === 0 || dt.getDay() === 6
    const isTo = date === today()

    const marks = targetsByDate[date] ?? []
    const marksHTML = marks.length > 0
      ? `<div class="pcal-summary-marks">${marks.map(m =>
          `<span class="pcal-lead-badge" style="background:${m.color}">${m.label}</span>`
        ).join('')}</div>`
      : ''

    const tooltipLines = [
      `${avail}/${totalRooms} unidades libres (${occPct}% ocupación)`,
      ...marks.map(m => `${m.label}: cae aquí — lead time medio Booking.com ${leadTimeWindows?.[m.key]} días (ventana ${m.days}d)`),
    ]

    return `<div class="pcal-summary-cell${isWE ? ' pcal-weekend' : ''}${isTo ? ' pcal-today' : ''}"
                 style="width:${CELL_W}px;height:${SUMMARY_ROW_H}px" title="${tooltipLines.join(' · ')}">
      <span class="pcal-summary-avail">${avail}</span>
      <span class="pcal-summary-occ" style="color:${color}">${occPct}%</span>
      ${marksHTML}
    </div>`
  }).join('')

  const legend = LEAD_WINDOWS.map(w => {
    const v = leadTimeWindows?.[w.key]
    return `<span style="color:${w.color};font-weight:700">${w.label}</span> ${v != null ? fmt1cal(v) + 'd' : '—'}`
  }).join(' · ')

  return `
    <div class="pcal-rate-row pcal-summary-row" data-summary-row="1">
      <div class="pcal-label-cell" style="width:${COL_W}px;height:${SUMMARY_ROW_H}px"
           title="Unidades libres y % de ocupación de toda la propiedad por día. L6/L28/L64: día en que cae &quot;hoy + lead time medio de Booking.com&quot;, calculado sobre las reservas de Booking.com hechas en los últimos 6/28/64 días — mismo canal y misma ventana que usa la regla de precio dinámico 'lead_time_dip'.">
        <div style="display:flex;flex-direction:column;gap:1px">
          <span style="font-size:11px;font-weight:700;color:var(--accent)">Resumen propiedad</span>
          <span style="font-size:10px;color:var(--text2)">${legend}</span>
        </div>
      </div>
      ${cells}
    </div>`
}
function fmt1cal(n: number) { return n.toLocaleString('es-ES', { maximumFractionDigits: 1 }) }

// ── Fila de disponibilidad ─────────────────────────────────────────────────────
function buildAvailRow(
  rtKey: string, dates: string[],
  occupied: Record<string, number>,
  overrides: Record<string, number>,
  total: number,
  rtName?: string
): string {
  const cells = dates.map(date => {
    const occ      = occupied[date] ?? 0
    const ov       = overrides[date] ?? null
    const avail    = ov !== null ? Math.max(0, ov) : Math.max(0, total - occ)
    const isOv     = ov !== null
    const dt       = new Date(date + 'T00:00:00')
    const isWE     = dt.getDay() === 0 || dt.getDay() === 6
    const isTo     = date === today()
    const colorCls = avail === 0 ? 'pcal-avail-zero' : (avail <= 1 ? 'pcal-avail-low' : 'pcal-avail-ok')
    return `<div class="pcal-avail-cell ${colorCls}${isWE ? ' pcal-weekend' : ''}${isTo ? ' pcal-today' : ''}"
               style="width:${CELL_W}px;height:${ROW_H}px"
               data-rtkey="${rtKey}" data-date="${date}" data-total="${total}"
               data-occupied="${occ}" data-override="${ov !== null ? ov : ''}">
      <span class="pcal-avail-num">${avail}</span>
      <span class="pcal-avail-sep">/${total}</span>
      ${isOv ? '<span class="pcal-avail-dot">●</span>' : ''}
    </div>`
  }).join('')

  return `
    <div class="pcal-rate-row pcal-avail-row">
      <div class="pcal-label-cell" style="width:${COL_W}px;min-height:${ROW_H}px">
        <div style="display:flex;flex-direction:column;gap:1px">
          <span style="font-size:11px;font-weight:700;color:var(--accent)">${rtName ?? 'Disponibilidad'}</span>
          <span style="font-size:10px;color:var(--text2)">${total} hab. disponibles · editable</span>
        </div>
      </div>
      ${cells}
    </div>`
}

// ── Main component ─────────────────────────────────────────────────────────────
export default function PriceCalendarView() {
  const { user }                                = useAuth()
  const isAdmin                                 = canManage(user)
  const canFdm                                  = isAdmin || hasRole(user, 'recepcion')
  const canViewHistory                          = isAdmin || hasRole(user, 'recepcion')
  const canViewCompetitors                      = isAdmin || hasRole(user, 'recepcion')
  const [tab,              setTab]              = useState<'calendar' | 'config' | 'history' | 'competitors'>('calendar')
  const [dateFrom,         setDateFrom]         = useState(() => addDays(today(), -1))
  const [numDays,          setNumDays]          = useState(30)
  const [selRateIds,       setSelRateIds]       = useState<number[] | null>(null)
  const [selRoomTypeIds,   setSelRoomTypeIds]   = useState<number[] | null>(null)
  const [loading,          setLoading]          = useState(true)
  const [error,            setError]            = useState<string | null>(null)
  const [showRatePanel,    setShowRatePanel]    = useState(false)
  const [showTypePanel,    setShowTypePanel]    = useState(false)
  const [fdmPushing,       setFdmPushing]       = useState(false)
  const [showBulkOp,       setShowBulkOp]       = useState(false)

  // Click-to-toggle selection
  const selCellsRef  = useRef<Map<string, { roomTypeId: number | null; rateId: number; date: string }>>(new Map())
  const [selCount,         setSelCount]         = useState(0)
  const [selClosed,        setSelClosed]        = useState(false)
  const [selSingleRateId,  setSelSingleRateId]  = useState<number | null>(null)
  const [previewPrice,     setPreviewPrice]     = useState<number | null>(null)
  const selPriceRef  = useRef<HTMLInputElement>(null)

  const isFirstLoad = useRef(true)
  const dataRef = useRef<{
    rates: any[]; allRates: any[]; roomTypes: any[]
    priceMap:       Record<string, Record<number, Record<string, any>>>
    ratesById:      Record<number, any>
    availTotals:    Record<string, number>
    availOccupied:  Record<string, Record<string, number>>
    availOverrides: Record<string, Record<string, number>>
    defaultRateIds?:     number[] | null
    defaultRoomTypeIds?: number[] | null
    defaultDays?:        number | null
    leadTimeWindows?:    { '6': number | null; '28': number | null; '64': number | null } | null
    todayIso?:           string
    adrByDate?:          Record<string, number | null>
  } | null>(null)
  const gridRef    = useRef<HTMLDivElement>(null)

  type AvailEditorData = {
    rtId: number; date: string; total: number; occupied: number; override: number | null
    rect: { top: number; left: number; bottom: number }
  }
  const [availEditor, setAvailEditor] = useState<AvailEditorData | null>(null)
  const availEditorCbRef = useRef<(d: AvailEditorData) => void>(() => {})
  availEditorCbRef.current = setAvailEditor

  const dateTo = addDays(dateFrom, numDays - 1)

  const clearSel = useCallback(() => {
    selCellsRef.current.clear()
    setSelCount(0)
    setSelSingleRateId(null)
    setPreviewPrice(null)
    clearSelectionDOM()
  }, [])

  const load = useCallback(async (from: string, nd: number, rateIds: number[] | null, roomTypeIds: number[] | null) => {
    const to = addDays(from, nd - 1)
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { dateFrom: from, dateTo: to }
      if (rateIds?.length) params.rateIds = rateIds.join(',')
      const data: any = await api.ratesCalendar(params)

      // Primera carga: si el nº de días por defecto configurado (Ajustes →
      // Configuración) es distinto del usado para este pedido (el hardcoded
      // inicial de 30), recargar ya con el rango correcto antes de pintar
      // nada — isFirstLoad.current sigue en true, así que la re-llamada
      // vuelve a pasar por este mismo bloque y aplica también rate/roomType
      // por defecto con los datos correctos.
      if (isFirstLoad.current && rateIds === null) {
        const defaultDays: number | null = data.defaultDays ?? null
        if (defaultDays && defaultDays !== nd) {
          setNumDays(defaultDays)
          await load(from, defaultDays, rateIds, roomTypeIds)
          return
        }
      }

      dataRef.current = data

      let effectiveRoomTypeIds = roomTypeIds

      // Primera carga: aplicar selecciones por defecto (configurables en Ajustes → Configuración)
      if (isFirstLoad.current && rateIds === null) {
        isFirstLoad.current = false

        const defaultRateIds: number[] | null = data.defaultRateIds ?? null
        if (defaultRateIds && defaultRateIds.length > 0 && defaultRateIds.length < data.allRates.length) {
          setSelRateIds(defaultRateIds)
          data.rates = (data.allRates as any[]).filter(r => defaultRateIds.includes(r.id))
        }

        if (effectiveRoomTypeIds === null) {
          const defaultRoomTypeIds: number[] | null = data.defaultRoomTypeIds ?? null
          if (defaultRoomTypeIds && defaultRoomTypeIds.length > 0 && defaultRoomTypeIds.length < data.roomTypes.length) {
            setSelRoomTypeIds(defaultRoomTypeIds)
            effectiveRoomTypeIds = defaultRoomTypeIds
          }
        }
      }

      renderGrid(data, from, nd, effectiveRoomTypeIds)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, []) // eslint-disable-line

  useEffect(() => { load(dateFrom, numDays, selRateIds, selRoomTypeIds) }, []) // eslint-disable-line
  useEffect(() => () => { clearSelectionDOM() }, [])

  // Volver a la pestaña "Calendario" desmonta y remonta <div ref={gridRef}/>
  // (vive dentro del bloque condicional de abajo) — el nuevo nodo llega
  // vacío porque renderGrid() pinta con innerHTML directo sobre el nodo
  // anterior, no con estado de React. Repintar aquí desde dataRef.current
  // (ya cargado) en vez de volver a pedir todo a la API.
  useEffect(() => {
    if (tab === 'calendar' && dataRef.current) {
      renderGrid(dataRef.current, dateFrom, numDays, selRoomTypeIds)
    }
  }, [tab]) // eslint-disable-line

  function renderGrid(data: any, from: string, nd: number, visibleTypeIds: number[] | null) {
    if (!gridRef.current) return
    const wrap = gridRef.current
    clearSel()

    const to = addDays(from, nd - 1)
    const { rates, allRates, roomTypes: rtList = [], priceMap,
            availTotals = {}, availOccupied = {}, availOverrides = {},
            leadTimeWindows = null, todayIso = undefined, adrByDate = {} } = data
    const ratesById = Object.fromEntries(allRates.map((r: any) => [r.id, r]))
    data.ratesById = ratesById
    const dates = dateRange(from, to)
    const totalW = COL_W + dates.length * CELL_W

    // Tarifas compartidas (roomTypeId=null) → aparecen en todos los grupos de tipo
    // Tarifas con roomTypeId asignado → solo en su grupo
    const sharedRates = rates.filter((r: any) => r.roomTypeId == null).sort((a: any, b: any) => a.id - b.id)
    const groups: { typeId: number | null; typeName: string; rates: any[] }[] = []

    if (rtList.length === 0) {
      // Sin tipos de habitación definidos: vista plana
      groups.push({ typeId: null, typeName: 'Tarifas', rates: sharedRates })
    } else {
      for (const rt of rtList) {
        if (visibleTypeIds && !visibleTypeIds.includes(rt.id)) continue
        const specific = rates.filter((r: any) => r.roomTypeId === rt.id).sort((a: any, b: any) => a.id - b.id)
        const grpRates = [...sharedRates, ...specific]
        if (grpRates.length === 0) continue
        groups.push({ typeId: rt.id, typeName: rt.name, rates: grpRates })
      }
    }

    // Cabecera de meses y días (compartida, sticky)
    const monthGroups: { label: string; span: number }[] = []
    let lastMonth = ''
    for (const d of dates) {
      const m = d.slice(0, 7)
      if (m !== lastMonth) {
        const dt = new Date(d + 'T00:00:00')
        monthGroups.push({ label: `${MON_ES[dt.getMonth()]} ${dt.getFullYear()}`, span: 1 })
        lastMonth = m
      } else { monthGroups[monthGroups.length - 1].span++ }
    }

    const dayHeaderHTML = `
      <div class="pcal-header-row pcal-month-row">
        <div class="pcal-label-cell" style="width:${COL_W}px"></div>
        ${monthGroups.map(mg => `<div class="pcal-month-cell" style="width:${mg.span * CELL_W}px">${mg.label}</div>`).join('')}
      </div>
      <div class="pcal-header-row pcal-day-row">
        <div class="pcal-label-cell" style="width:${COL_W}px"></div>
        ${dates.map(d => {
          const dt = new Date(d + 'T00:00:00')
          const dow = dt.getDay()
          const isWE = dow === 0 || dow === 6
          const isTo = d === today()
          return `<div class="pcal-day-cell${isWE ? ' pcal-weekend' : ''}${isTo ? ' pcal-today' : ''}" style="width:${CELL_W}px">
            <span class="pcal-dow">${DAY_ES[dow]}</span>
            <span class="pcal-dn">${dt.getDate()}</span>
          </div>`
        }).join('')}
      </div>`

    const roomTypesById = Object.fromEntries((rtList as any[]).map((rt: any) => [rt.id, rt]))

    const groupsHTML = groups.map(g => {
      const rtKey      = g.typeId != null ? String(g.typeId) : 'null'
      const occupancy  = g.typeId != null ? (roomTypesById[g.typeId]?.maxOccupancy ?? 1) : 1
      const availRow   = g.typeId != null
        ? buildAvailRow(rtKey, dates,
            availOccupied[rtKey] ?? {},
            availOverrides[rtKey] ?? {},
            availTotals[rtKey] ?? 0,
            g.typeName)
        : ''
      return `
      <div class="pcal-type-section">
        <div class="pcal-type-header" style="width:${totalW}px">
          <span>${g.typeName}</span>
          <span style="font-size:11px;opacity:.6">${g.rates.length} tarifa${g.rates.length !== 1 ? 's' : ''} · ${availTotals[rtKey] ?? 0} hab.</span>
        </div>
        <div class="pcal-type-rows">
          ${availRow}
          ${g.rates.map((rate: any) => buildRateRow(rate, dates, priceMap, ratesById, g.typeId, roomTypesById, occupancy, adrByDate)).join('')}
        </div>
      </div>`
    }).join('')

    const summaryRowHTML = buildSummaryRow(dates, availTotals, availOccupied, availOverrides, leadTimeWindows, todayIso)

    wrap.innerHTML = `
      <div id="pcal-header-wrap">
        <div style="width:${totalW}px">
          ${dayHeaderHTML}
        </div>
      </div>
      <div id="pcal-scroll-outer">
        <div id="pcal-grid" style="width:${totalW}px">
          <div id="pcal-rows">
            ${summaryRowHTML}
            ${groups.length === 0
              ? `<div style="padding:40px;color:var(--text2);text-align:center">Sin tarifas para los tipos seleccionados</div>`
              : groupsHTML}
          </div>
        </div>
      </div>
    `

    // Sincronizar scroll horizontal entre headers y contenido
    const scrollOuter = wrap.querySelector('#pcal-scroll-outer') as HTMLElement
    const headerWrap  = wrap.querySelector('#pcal-header-wrap') as HTMLElement
    scrollOuter.addEventListener('scroll', function() {
      headerWrap.scrollLeft = scrollOuter.scrollLeft
    })

    // Click-to-toggle selection
    const rows = wrap.querySelector('#pcal-rows')!
    rows.addEventListener('click', (e: Event) => {
      // Disponibilidad: abrir editor inline
      const availCell = (e.target as Element).closest('.pcal-avail-cell') as HTMLElement | null
      if (availCell) {
        const rect = availCell.getBoundingClientRect()
        availEditorCbRef.current({
          rtId:     Number(availCell.dataset.rtkey),
          date:     availCell.dataset.date!,
          total:    Number(availCell.dataset.total),
          occupied: Number(availCell.dataset.occupied),
          override: availCell.dataset.override !== '' ? Number(availCell.dataset.override) : null,
          rect: { top: rect.top, left: rect.left, bottom: rect.bottom },
        })
        return
      }

      const cell = (e.target as Element).closest('.pcal-editable') as HTMLElement | null
      if (!cell) return
      const rtid = cell.dataset.rtid || ''
      const key  = `${rtid}-${cell.dataset.rid}-${cell.dataset.date}`
      if (selCellsRef.current.has(key)) {
        selCellsRef.current.delete(key)
        cell.classList.remove('pcal-selected')
      } else {
        const roomTypeId = rtid ? Number(rtid) : null
        selCellsRef.current.set(key, { roomTypeId, rateId: Number(cell.dataset.rid), date: cell.dataset.date! })
        cell.classList.add('pcal-selected')
      }
      const rateIds = new Set([...selCellsRef.current.values()].map(c => c.rateId))
      setSelSingleRateId(rateIds.size === 1 ? [...rateIds][0] : null)
      setSelCount(selCellsRef.current.size)
    })
  }

  // Vuelve a pedir el calendario entero al servidor (preservando el scroll) en
  // vez de parchear priceMap a mano. Motivo: priceMap mezcla, sin distinguirlos,
  // los overrides reales CON los precios de tarifas derivadas ya resueltos por
  // el servidor para rellenar huecos (ver /rates/calendar en catalog.ts) — al
  // mutar solo la entrada de la tarifa editada, la de cualquier tarifa derivada
  // se queda con su valor precalculado "congelado" de la última carga, y
  // computePrice() lo lee como si fuera un override real sin volver a mirar la
  // base — ni repintando 1000 veces se corrige sin volver a preguntarle al
  // servidor, que es quien sabe recalcularlo bien.
  const refetchKeepingScroll = async () => {
    const scrollOuter = gridRef.current?.querySelector('#pcal-scroll-outer') as HTMLElement | null
    const scrollLeft  = scrollOuter?.scrollLeft ?? 0
    const scrollTop   = scrollOuter?.scrollTop ?? 0
    await load(dateFrom, numDays, selRateIds, selRoomTypeIds)
    const newScrollOuter = gridRef.current?.querySelector('#pcal-scroll-outer') as HTMLElement | null
    if (newScrollOuter) { newScrollOuter.scrollLeft = scrollLeft; newScrollOuter.scrollTop = scrollTop }
  }

  const applyBulk = async () => {
    const d = dataRef.current
    if (!d || selCellsRef.current.size === 0) return

    const rawVal = parseFloat(selPriceRef.current?.value ?? '')
    const hasPrice = !isNaN(rawVal) && rawVal >= 0

    // Si no es cierre, se requiere precio válido
    if (!selClosed && !hasPrice) { alert('Introduce un precio válido'); return }

    const entries = [...selCellsRef.current.values()]

    // Agrupar por (roomTypeId, rateId) para una sola llamada bulk por combinación
    const byRtRate = new Map<string, { roomTypeId: number | null; rateId: number; dates: string[] }>()
    for (const { roomTypeId, rateId, date } of entries) {
      const key = `${roomTypeId}-${rateId}`
      if (!byRtRate.has(key)) byRtRate.set(key, { roomTypeId, rateId, dates: [] })
      byRtRate.get(key)!.dates.push(date)
    }

    try {
      await Promise.all([...byRtRate.values()].map(({ roomTypeId, rateId, dates }) =>
        api.bulkDailyPrices(rateId, dates.map(date => ({
          date,
          ...(hasPrice ? { price: rawVal } : {}),
          closed: selClosed,
          roomTypeId,
        })))
      ))
      // Vuelve a pedir el calendario al servidor — necesario para que las
      // tarifas derivadas se recalculen bien (ver comentario en
      // refetchKeepingScroll), no solo la celda que se acaba de editar.
      await refetchKeepingScroll()
    } catch (e: any) { alert('Error: ' + e.message) }
  }

  const clearOverrides = async () => {
    if (selCellsRef.current.size === 0) return
    if (!confirm(`¿Limpiar los overrides de ${selCellsRef.current.size} celda(s)?`)) return
    const entries = [...selCellsRef.current.values()]
    try {
      await Promise.all(entries.map(({ roomTypeId, rateId, date }) =>
        api.deleteDailyPrice(rateId, date, roomTypeId).catch(() => {})
      ))
      await refetchKeepingScroll()
    } catch (e: any) { alert('Error: ' + e.message) }
  }

  const shift = (n: number) => {
    const nf = addDays(dateFrom, n * numDays)
    setDateFrom(nf); load(nf, numDays, selRateIds, selRoomTypeIds)
  }
  const goToday = () => { setDateFrom(today()); load(today(), numDays, selRateIds, selRoomTypeIds) }
  const applyDays = (nd: number) => {
    const safe = Math.max(7, Math.min(90, nd))
    setNumDays(safe); load(dateFrom, safe, selRateIds, selRoomTypeIds)
  }

  const applyRateSelection = (ids: number[]) => {
    const newIds = dataRef.current && ids.length === dataRef.current.allRates.length ? null : ids
    setSelRateIds(newIds); setShowRatePanel(false); load(dateFrom, numDays, newIds, selRoomTypeIds)
  }

  // Jumbo corre en segundo plano en el servidor (ver pushPrices más abajo) —
  // esto sondea el resultado cada 3s hasta que termine, sin bloquear nada.
  const pollJumboPushStatus = async () => {
    for (let i = 0; i < 30; i++) { // hasta ~90s
      await new Promise(r => setTimeout(r, 3000))
      try {
        const resp = await fetch('/api/jumbo/push-status', { credentials: 'include' })
        const data = await resp.json()
        const status = data.data
        if (!status.running && status.last) {
          const last = status.last
          const horaResuelto = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
          if (last.skipped) {
            toast(`Jumbo (en segundo plano): sin cambios (${last.reason ?? '?'})`)
          } else if (last.errors > 0) {
            toast(`Jumbo (en segundo plano): ${last.verified}/${last.requestedDates} verificado(s) · ${last.errors} errores — ${horaResuelto}`, 'err')
          } else {
            toast(`✅ Carga manual a Jumbo correcta — ${last.verified}/${last.requestedDates} verificado(s) a las ${horaResuelto}`, 'ok')
          }
          return
        }
      } catch { /* seguimos intentando */ }
    }
    toast('Jumbo: sigue en segundo plano, está tardando más de lo normal — revisa más tarde', 'err')
  }

  // Un solo botón para todos los canales — FDM (precio + disponibilidad) y
  // Jumbo (solo precio derivado de la tarifa raíz), mismos permisos que FDM para
  // ambos. Ambos endpoints ya filtran por su cuenta a solo lo que cambió
  // desde el último envío — este botón nunca reenvía un rango entero sin
  // necesidad.
  const pushPrices = async () => {
    setFdmPushing(true)
    const parts: string[] = []
    try {
      try {
        const resp = await fetch('/api/fdm/push-prices', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: dateFrom, to: dateTo, mode: 'prices_and_avail' }),
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
        const r = data.data
        parts.push(r.skippedNoChanges
          ? 'FDM: sin cambios'
          : `FDM: ${r.pushed} enviados${r.errors > 0 ? ` · ${r.errors} errores` : ''}`)
      } catch (e: any) { parts.push(`FDM: error — ${e.message}`) }

      try {
        const resp = await fetch('/api/jumbo/push-prices', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: dateFrom, to: dateTo }),
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error ?? `HTTP ${resp.status}`)
        const r = data.data
        if (r.skippedNoChanges) {
          parts.push(`Jumbo: sin cambios (${r.reason ?? '?'})`)
        } else if (r.alreadyRunning) {
          parts.push('Jumbo: ya hay un envío en curso')
        } else {
          // Jumbo puede tardar >30s por fecha (login + setPrice + verificación) —
          // el envío real corre en segundo plano en el servidor; aquí solo se
          // avisa de que empezó y se sondea el resultado aparte, sin bloquear
          // este toast ni el resto de la página.
          parts.push(`Jumbo: enviando ${r.total} fecha(s) en segundo plano…`)
          void pollJumboPushStatus()
        }
      } catch (e: any) { parts.push(`Jumbo: error — ${e.message}`) }

      toast(parts.join(' · '), parts.some(p => p.includes('error')) ? 'err' : undefined)
    } finally { setFdmPushing(false) }
  }

  const applyRoomTypeSelection = (ids: number[]) => {
    const allTypes = dataRef.current?.roomTypes ?? []
    const newIds = ids.length === allTypes.length ? null : ids
    setSelRoomTypeIds(newIds); setShowTypePanel(false)
    // Re-renderizar sin recargar: el filtro es client-side
    if (dataRef.current) renderGrid(dataRef.current, dateFrom, numDays, newIds)
  }

  // Preview de tarifas derivadas mientras el usuario escribe el precio
  const derivedPreviews = (() => {
    if (previewPrice === null || isNaN(previewPrice) || !selSingleRateId || !dataRef.current) return []
    return (dataRef.current.allRates as any[])
      .filter((r: any) => r.baseRateId === selSingleRateId)
      .map((r: any) => {
        const adj = parseFloat(r.adjustValue ?? '0')
        let price = previewPrice
        if (r.adjustType === 'percentage') price = previewPrice * (1 + adj / 100)
        else                               price = previewPrice + adj
        return { id: r.id, title: r.title, price: Math.round(Math.max(0, price) * 100) / 100 }
      })
  })()

  return (
    <div id="pcal-wrap" style={{ padding: 0 }}>
      {(isAdmin || canViewHistory || canViewCompetitors) && (
        <div className="tabs" style={{ margin: '0 0 12px' }}>
          <button className={`tab-btn${tab === 'calendar' ? ' active' : ''}`} onClick={() => setTab('calendar')}>Calendario</button>
          {canViewCompetitors && <button className={`tab-btn${tab === 'competitors' ? ' active' : ''}`} onClick={() => setTab('competitors')}>Competidores</button>}
          {canViewHistory && <button className={`tab-btn${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>Historial</button>}
          {isAdmin && <button className={`tab-btn${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}>Configuración</button>}
        </div>
      )}

      {tab === 'config' && isAdmin ? (
        <CalendarDefaultsPanel
          allRates={dataRef.current?.allRates ?? []}
          roomTypes={dataRef.current?.roomTypes ?? []}
          defaultRateIds={dataRef.current?.defaultRateIds ?? null}
          defaultRoomTypeIds={dataRef.current?.defaultRoomTypeIds ?? null}
          defaultDays={dataRef.current?.defaultDays ?? numDays}
          onSaved={(rateIds, roomTypeIds, days) => {
            if (dataRef.current) {
              dataRef.current.defaultRateIds = rateIds
              dataRef.current.defaultRoomTypeIds = roomTypeIds
              dataRef.current.defaultDays = days
            }
          }}
        />
      ) : tab === 'competitors' && canViewCompetitors ? (
        <CompetitorsPanel allRates={dataRef.current?.allRates ?? []} allRoomTypes={dataRef.current?.roomTypes ?? []} readOnly={!isAdmin} />
      ) : tab === 'history' && canViewHistory ? (
        <PriceHistoryPanel allRates={dataRef.current?.allRates ?? []} />
      ) : <>
      <div id="pcal-toolbar">
        <button className="btn btn-ghost btn-sm" onClick={() => shift(-1)}>◀</button>
        <span id="pcal-range">{fmtDateCal(dateFrom)} — {fmtDateCal(dateTo)}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => shift(1)}>▶</button>
        <button className="btn btn-ghost btn-sm" onClick={goToday}>Hoy</button>
        <div className="pcal-toolbar-sep" />
        <label style={{ fontSize: 12, color: 'var(--text2)' }}>Días:</label>
        <input type="number" min={7} max={90} value={numDays}
          onChange={e => setNumDays(Number(e.target.value))}
          onBlur={e => applyDays(Number(e.target.value))}
          onKeyDown={e => { if (e.key === 'Enter') applyDays(Number((e.target as HTMLInputElement).value)) }}
          style={{ width: 56, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '3px 6px', fontSize: 12 }} />
        <div className="pcal-toolbar-sep" />
        <button className="btn btn-ghost btn-sm" onClick={() => { setShowTypePanel(v => !v); setShowRatePanel(false) }}>
          Tipo hab.{selRoomTypeIds ? ` (${selRoomTypeIds.length})` : ''} ▾
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => { setShowRatePanel(v => !v); setShowTypePanel(false) }}>
          Tarifas{selRateIds ? ` (${selRateIds.length})` : ''} ▾
        </button>
        {isAdmin && <>
          <div className="pcal-toolbar-sep" />
          <button className="btn btn-ghost btn-sm" onClick={() => setShowBulkOp(true)}>
            Op. Masiva
          </button>
        </>}
        {canFdm && <>
          <div className="pcal-toolbar-sep" />
          <button className="btn btn-ghost btn-sm" onClick={pushPrices} disabled={fdmPushing}
            title={`Enviar a FDM y Jumbo solo lo que cambió: ${dateFrom} → ${dateTo}`}>
            {fdmPushing ? 'Enviando…' : '⇅ Enviar precios'}
          </button>
        </>}
        <div className="pcal-toolbar-sep" />
        <span className="pcal-legend-item pcal-loverride">Precio personalizado</span>
        <span className="pcal-legend-item pcal-lclosed">Cerrada</span>
        <span className="pcal-legend-item pcal-lderived">Derivada</span>
        <div className="pcal-toolbar-sep" />
        <span className="pcal-legend-item pcal-ladr-above" title="Precio por encima del ADR real de esa semana (ingresos ÷ noches ocupadas)">Sobre ADR semanal</span>
        <span className="pcal-legend-item pcal-ladr-below" title="Precio por debajo del ADR real de esa semana (ingresos ÷ noches ocupadas)">Bajo ADR semanal</span>
        <span style={{ fontSize: 11, color: 'var(--text2)', marginLeft: 4 }}>Click para seleccionar celdas</span>
      </div>

      {showTypePanel && dataRef.current && (
        <RoomTypeSelector
          roomTypes={dataRef.current.roomTypes ?? []}
          defaultIds={dataRef.current.defaultRoomTypeIds ?? null}
          selectedIds={selRoomTypeIds}
          onApply={applyRoomTypeSelection}
          onCancel={() => setShowTypePanel(false)}
        />
      )}

      {showRatePanel && dataRef.current && (
        <RateSelector
          allRates={dataRef.current.allRates}
          defaultIds={dataRef.current.defaultRateIds ?? null}
          selectedIds={selRateIds}
          onApply={applyRateSelection}
          onCancel={() => setShowRatePanel(false)}
        />
      )}

      {loading && <div className="loading" style={{ padding: 40 }}>Cargando calendario…</div>}
      {error   && <div className="empty" style={{ padding: 40 }}><p style={{ color: 'var(--red)' }}>Error: {error}</p></div>}

      <div ref={gridRef} />

      {availEditor && (
        <AvailEditor
          {...availEditor}
          onSave={async (maxAvail) => {
            const ed = availEditor
            try {
              await api.setAvailOverride(ed.rtId, ed.date, maxAvail)
              setAvailEditor(null)
              if (dataRef.current) {
                const rtKey = String(ed.rtId)
                ;(dataRef.current.availOverrides[rtKey] ??= {})[ed.date] = maxAvail
                renderGrid(dataRef.current, dateFrom, numDays, selRoomTypeIds)
              }
            } catch (err: any) { alert('Error: ' + err.message) }
          }}
          onClear={async () => {
            const ed = availEditor
            try {
              await api.clearAvailOverride(ed.rtId, ed.date)
              setAvailEditor(null)
              if (dataRef.current) {
                const rtKey = String(ed.rtId)
                if (dataRef.current.availOverrides[rtKey]) {
                  delete dataRef.current.availOverrides[rtKey][ed.date]
                }
                renderGrid(dataRef.current, dateFrom, numDays, selRoomTypeIds)
              }
            } catch (err: any) { alert('Error: ' + err.message) }
          }}
          onCancel={() => setAvailEditor(null)}
        />
      )}

      {selCount > 0 && (
        <div id="pcal-sel-bar">
          <span className="pcal-sel-count">{selCount} celda{selCount !== 1 ? 's' : ''} seleccionada{selCount !== 1 ? 's' : ''}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, cursor: 'pointer', color: selClosed ? 'var(--red)' : 'var(--text2)' }}>
              <input type="checkbox" checked={selClosed} onChange={e => setSelClosed(e.target.checked)} />
              Cerrar tarifa
            </label>
            {!selClosed && (
              <input
                ref={selPriceRef}
                type="number"
                step="0.01"
                min="0"
                placeholder="Precio (€)"
                autoFocus
                style={{ width: 110, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 13 }}
                onChange={e => setPreviewPrice(parseFloat(e.target.value) || null)}
                onKeyDown={e => { if (e.key === 'Enter') applyBulk() }}
              />
            )}
            {derivedPreviews.length > 0 && !selClosed && (
              <div className="pcal-derived-preview">
                <span className="pcal-derived-preview-label">Tarifas derivadas:</span>
                {derivedPreviews.map(r => (
                  <span key={r.id} className="pcal-derived-preview-chip">
                    {r.title}: {r.price.toFixed(2)}€
                  </span>
                ))}
              </div>
            )}
            <button className="btn btn-sm btn-primary" onClick={applyBulk}>
              {selClosed ? 'Cerrar' : 'Aplicar precio'}
            </button>
            <button className="btn btn-sm btn-danger" onClick={clearOverrides}>
              Limpiar overrides
            </button>
            <button className="btn btn-sm btn-ghost" onClick={clearSel}>
              ✕ Cancelar
            </button>
          </div>
        </div>
      )}
      {showBulkOp && (
        <BulkOpModal
          allRates={dataRef.current?.allRates ?? []}
          onClose={() => setShowBulkOp(false)}
          onDone={() => { setShowBulkOp(false); refetchKeepingScroll() }}
        />
      )}
      </>}
    </div>
  )
}

// ── Modal de Operación Masiva ─────────────────────────────────────────────────

function BulkOpModal({ allRates, onClose, onDone }: {
  allRates: any[]
  onClose: () => void
  onDone: () => void
}) {
  const [opType,     setOpType]     = useState<'close' | 'increase'>('close')
  const [rateId,     setRateId]     = useState<number | ''>('')
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  const [amtType,    setAmtType]    = useState<'pct' | 'fixed'>('pct')
  const [amount,     setAmount]     = useState('')
  const [saving,     setSaving]     = useState(false)
  const [info,       setInfo]       = useState<string | null>(null)

  const baseRates = allRates.filter(r => !r.baseRateId)
  const ratesForOp = opType === 'close' ? allRates : baseRates

  const dayCount = (() => {
    if (!dateFrom || !dateTo || dateFrom > dateTo) return 0
    return dateRange(dateFrom, dateTo).length
  })()

  const submit = async () => {
    if (rateId === '') { setInfo('Selecciona una tarifa'); return }
    if (!dateFrom || !dateTo) { setInfo('Introduce las fechas'); return }
    if (dateFrom > dateTo)    { setInfo('La fecha inicio debe ser anterior al fin'); return }
    const dates = dateRange(dateFrom, dateTo)
    if (dates.length === 0 || dates.length > 365) { setInfo('Rango no válido (máx. 365 días)'); return }
    setSaving(true); setInfo(null)
    try {
      if (opType === 'close') {
        await api.bulkDailyPrices(rateId as number, dates.map(d => ({ date: d, closed: true })))
        toast(`${dates.length} días cerrados para ${allRates.find(r => r.id === rateId)?.title ?? ''}`)
        onDone()
      } else {
        const amt = parseFloat(amount)
        if (isNaN(amt) || amt <= 0) { setInfo('Introduce un importe válido'); setSaving(false); return }
        const rate = allRates.find(r => r.id === rateId)
        const calData: any = await api.ratesCalendar({ dateFrom, dateTo, rateIds: String(rateId) })
        const pm: Record<string, Record<number, Record<string, { price: string; closed: boolean }>>> = calData.priceMap ?? {}
        const globalMap: Record<string, { price: string; closed: boolean }> = pm['null']?.[rateId as number] ?? {}
        const baseDefault = parseFloat(rate?.adjustValue ?? '0')
        const entries = dates.map(d => {
          const override = globalMap[d]
          const cur = override ? parseFloat(override.price) : baseDefault
          const next = amtType === 'pct'
            ? Math.round(cur * (1 + amt / 100) * 100) / 100
            : Math.round((cur + amt) * 100) / 100
          return { date: d, price: Math.max(0, next) }
        })
        await api.bulkDailyPrices(rateId as number, entries)
        toast(`Precios actualizados en ${dates.length} días para ${rate?.title ?? ''}`)
        onDone()
      }
    } catch (e: any) { setInfo(e.message); setSaving(false) }
  }

  const inp: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)',
    background: 'var(--bg)', color: 'var(--text1)', fontSize: 13, outline: 'none', width: '100%',
  }
  const opBtn = (t: 'close' | 'increase', label: string) => (
    <button type="button"
      onClick={() => { setOpType(t); setRateId('') }}
      style={{
        flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--border)',
        cursor: 'pointer', fontSize: 13, fontWeight: 600,
        background: opType === t ? 'var(--accent)' : 'var(--bg2)',
        color: opType === t ? '#fff' : 'var(--text1)',
      }}>
      {label}
    </button>
  )

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1100,
      background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{
        background: 'var(--bg1, var(--bg))', borderRadius: 12, padding: 28, width: 440,
        boxShadow: '0 8px 32px rgba(0,0,0,.35)', display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Operación masiva</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: 'var(--text2)', lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          {opBtn('close',    'Cerrar tarifa')}
          {opBtn('increase', 'Subir precio')}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>
            {opType === 'close' ? 'Tarifa a cerrar' : 'Tarifa base'}
          </span>
          <select style={inp} value={rateId} onChange={e => setRateId(Number(e.target.value) || '')}>
            <option value="">— Selecciona —</option>
            {ratesForOp.map((r: any) => (
              <option key={r.id} value={r.id}>{r.title}{r.code ? ` (${r.code})` : ''}</option>
            ))}
          </select>
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Desde</span>
            <input type="date" style={inp} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 13 }}>
            <span style={{ fontWeight: 600 }}>Hasta</span>
            <input type="date" style={inp} value={dateTo} onChange={e => setDateTo(e.target.value)} />
          </label>
        </div>

        {opType === 'increase' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13 }}>Incremento</span>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['pct', 'fixed'] as const).map(t => (
                <button key={t} type="button"
                  onClick={() => setAmtType(t)}
                  style={{
                    padding: '5px 16px', borderRadius: 6, border: '1px solid var(--border)',
                    cursor: 'pointer', fontSize: 12, fontWeight: 600,
                    background: amtType === t ? 'var(--accent)' : 'var(--bg2)',
                    color: amtType === t ? '#fff' : 'var(--text1)',
                  }}>
                  {t === 'pct' ? 'Porcentaje (%)' : 'Importe fijo (€)'}
                </button>
              ))}
            </div>
            <input type="number" style={inp} min="0" step={amtType === 'pct' ? '0.1' : '0.01'}
              placeholder={amtType === 'pct' ? 'Ej: 10 (= +10%)' : 'Ej: 5.00 (= +5 €)'}
              value={amount} onChange={e => setAmount(e.target.value)} />
          </div>
        )}

        {dayCount > 0 && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text2)' }}>
            {opType === 'close'
              ? `Se cerrarán ${dayCount} día${dayCount !== 1 ? 's' : ''} para esta tarifa.`
              : `Se actualizará el precio de ${dayCount} día${dayCount !== 1 ? 's' : ''}.`}
          </p>
        )}

        {info && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--red, #ef4444)', fontWeight: 500 }}>{info}</p>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button
            className={`btn ${opType === 'close' ? 'btn-danger' : 'btn-primary'}`}
            onClick={submit} disabled={saving || !rateId || !dateFrom || !dateTo}>
            {saving ? 'Aplicando…' : opType === 'close' ? 'Cerrar tarifa' : 'Aplicar subida'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Configuración: tarifas/tipos de habitación visibles por defecto ───────────
// (solo admin) — sustituye lo que antes estaba hardcodeado en el componente.

function CalendarDefaultsPanel({ allRates, roomTypes, defaultRateIds, defaultRoomTypeIds, defaultDays, onSaved }: {
  allRates: any[]; roomTypes: any[]
  defaultRateIds: number[] | null; defaultRoomTypeIds: number[] | null
  defaultDays: number
  onSaved: (rateIds: number[] | null, roomTypeIds: number[] | null, days: number) => void
}) {
  const [rateChecked, setRateChecked] = useState<Set<number>>(
    () => new Set(defaultRateIds ?? allRates.map((r: any) => r.id))
  )
  const [typeChecked, setTypeChecked] = useState<Set<number>>(
    () => new Set(defaultRoomTypeIds ?? roomTypes.map((t: any) => t.id))
  )
  const [days,    setDays]    = useState(String(defaultDays))
  const [saving, setSaving] = useState(false)

  const toggleRate = (id: number) => setRateChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const toggleType = (id: number) => setTypeChecked(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })

  const save = async () => {
    const nd = Math.min(90, Math.max(7, parseInt(days) || defaultDays))
    setSaving(true)
    try {
      const rateIds     = rateChecked.size === allRates.length ? null : [...rateChecked]
      const roomTypeIds = typeChecked.size === roomTypes.length ? null : [...typeChecked]
      await api.setCalendarDefaults(rateIds, roomTypeIds, nd)
      onSaved(rateIds, roomTypeIds, nd)
      setDays(String(nd))
      toast('Valores por defecto guardados')
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginBottom: 4 }}>Vista por defecto del calendario de precios</h3>
      <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
        Elige qué tarifas y tipos de habitación se muestran al abrir el calendario, y cuántos días se cargan de una vez, para todo el mundo.
      </p>
      <div className="form-group" style={{ marginBottom: 20, maxWidth: 160 }}>
        <label>Días por defecto</label>
        <input type="number" min={7} max={90} value={days} onChange={e => setDays(e.target.value)} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Tarifas ({rateChecked.size}/{allRates.length})</div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {allRates.map((r: any) => (
              <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={rateChecked.has(r.id)} onChange={() => toggleRate(r.id)} />
                <span>{r.title}{r.code ? ` (${r.code})` : ''}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Tipos de habitación ({typeChecked.size}/{roomTypes.length})</div>
          <div style={{ maxHeight: 320, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
            {roomTypes.map((t: any) => (
              <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 0', cursor: 'pointer', fontSize: 13 }}>
                <input type="checkbox" checked={typeChecked.has(t.id)} onChange={() => toggleType(t.id)} />
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
      </div>
    </div>
  )
}

// ── Historial de cambios de precio ─────────────────────────────────────────────
function fmtDateTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}
function fmtDatesAffected(dates: string[]): string {
  if (dates.length === 0) return '—'
  if (dates.length === 1) return fmtDateCal(dates[0]!)
  // Fechas contiguas → mostrar como rango, si no como "1ª — Nª (n fechas)"
  const sorted = [...dates].sort()
  const allContiguous = sorted.every((d, i) => i === 0 || addDays(sorted[i - 1]!, 1) === d)
  return allContiguous
    ? `${fmtDateCal(sorted[0]!)} — ${fmtDateCal(sorted[sorted.length - 1]!)} (${sorted.length})`
    : `${fmtDateCal(sorted[0]!)} … ${fmtDateCal(sorted[sorted.length - 1]!)} (${sorted.length} fechas)`
}
function fmtPrice(p: string | null): string {
  return p != null ? `${parseFloat(p).toFixed(2)}€` : '—'
}

// ── Comparativa de precios con la competencia ───────────────────────────────
const COMPETITOR_COLORS = ['#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316']
const PLATFORM_LABEL: Record<string, string> = { paraty: 'Paraty', cloudbeds: 'Cloudbeds' }
const PLATFORM_FIELDS: Record<string, { key: string; label: string; placeholder: string; optional?: boolean }[]> = {
  paraty:    [
    { key: 'namespace',  label: 'Namespace',    placeholder: 'ej. sol-y-miel' },
    { key: 'websiteUrl', label: 'Web del hotel', placeholder: 'https://www.solymiel.com' },
    { key: 'apiBaseUrl', label: 'URL de la API (opcional)', placeholder: 'Solo si no usa el dominio genérico de Paraty', optional: true },
  ],
  cloudbeds: [
    { key: 'baseUrl', label: 'Web del hotel', placeholder: 'https://www.sunserramar.com' },
  ],
}

function fmtEur1(n: number) {
  return n.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 })
}

const PERIOD_OPTIONS = [45, 90, 180, 365]

function CompetitorsPanel({ allRates, allRoomTypes, readOnly = false }: { allRates: any[]; allRoomTypes: any[]; readOnly?: boolean }) {
  const [hotels,   setHotels]   = useState<any[]>([])
  const [series,   setSeries]   = useState<any[]>([])
  const [loading,  setLoading]  = useState(true)
  const [refreshingId, setRefreshingId] = useState<number | null>(null)
  const [showAdd,  setShowAdd]  = useState(false)
  const [periodDays, setPeriodDays] = useState(45)
  const [rateId, setRateId] = useState<number | ''>(10)
  const [roomTypeId, setRoomTypeId] = useState<number | ''>(1)
  const [form, setForm] = useState<{ name: string; platform: 'paraty' | 'cloudbeds'; config: Record<string, string>; divisor: string }>({
    name: '', platform: 'paraty', config: {}, divisor: '1.38',
  })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [hRes, pRes]: any[] = await Promise.all([
        api.listCompetitors(),
        api.getCompetitorPrices(today(), addDays(today(), periodDays), rateId !== '' ? rateId : undefined, roomTypeId !== '' ? roomTypeId : undefined),
      ])
      setHotels(hRes.data ?? [])
      setSeries(pRes.data?.series ?? [])
    } catch (e: any) { toast(e.message, 'err') }
    finally { setLoading(false) }
  }, [periodDays, rateId, roomTypeId])

  useEffect(() => { load() }, [load])

  const refresh = async (id: number) => {
    setRefreshingId(id)
    try {
      await api.refreshCompetitor(id)
      toast('Precios actualizados')
      await load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setRefreshingId(null) }
  }

  const remove = async (id: number, name: string) => {
    if (!confirm(`¿Eliminar "${name}" de la comparativa? Se borrará también su histórico de precios.`)) return
    try {
      await api.deleteCompetitor(id)
      toast('Competidor eliminado')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const toggleActive = async (h: any) => {
    try {
      await api.updateCompetitor(h.id, { active: !h.active })
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  const save = async () => {
    if (!form.name.trim()) { toast('Ponle un nombre', 'err'); return }
    const fields = PLATFORM_FIELDS[form.platform]!
    if (fields.some(f => !f.optional && !form.config[f.key]?.trim())) { toast('Rellena todos los campos', 'err'); return }
    const divisor = parseFloat(form.divisor)
    if (isNaN(divisor) || divisor <= 0) { toast('Divisor inválido', 'err'); return }
    setSaving(true)
    try {
      await api.createCompetitor({ name: form.name.trim(), platform: form.platform, config: form.config, bookingEffectiveDivisor: divisor })
      toast('Competidor añadido — actualizando sus precios…')
      setShowAdd(false)
      setForm({ name: '', platform: 'paraty', config: {}, divisor: '1.38' })
      load()
    } catch (e: any) { toast(e.message, 'err') }
    finally { setSaving(false) }
  }

  const updateDivisor = async (h: any, value: string) => {
    const divisor = parseFloat(value)
    if (isNaN(divisor) || divisor <= 0 || divisor === parseFloat(h.bookingEffectiveDivisor)) return
    try {
      await api.updateCompetitor(h.id, { bookingEffectiveDivisor: divisor })
      toast('Divisor actualizado')
      load()
    } catch (e: any) { toast(e.message, 'err') }
  }

  if (loading) return <div className="loading">Cargando…</div>

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="card">
        <div className="card-header">
          <h2>Hoteles competidores</h2>
          {!readOnly && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(v => !v)}>
              {showAdd ? 'Cancelar' : '+ Añadir competidor'}
            </button>
          )}
        </div>
        <p style={{ padding: '8px 18px 4px', fontSize: 13, color: 'var(--text2)' }}>
          El precio se lee directamente de la web oficial de cada competidor (nunca de Booking.com,
          para no incumplir sus términos de uso) — se actualiza solo, una vez al día.
        </p>

        {showAdd && !readOnly && (
          <div style={{ padding: '4px 18px 18px', display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 420 }}>
            <div className="form-group">
              <label>Nombre</label>
              <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="ej. Sol y Miel" />
            </div>
            <div className="form-group">
              <label>Motor de reservas</label>
              <select value={form.platform} onChange={e => setForm(f => ({ ...f, platform: e.target.value as any, config: {} }))}>
                {Object.entries(PLATFORM_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </div>
            {PLATFORM_FIELDS[form.platform]!.map(field => (
              <div className="form-group" key={field.key}>
                <label>{field.label}</label>
                <input
                  value={form.config[field.key] ?? ''}
                  placeholder={field.placeholder}
                  onChange={e => setForm(f => ({ ...f, config: { ...f.config, [field.key]: e.target.value } }))}
                />
              </div>
            ))}
            <div className="form-group">
              <label>Divisor precio efectivo</label>
              <input type="number" min="1" step="0.01" value={form.divisor}
                onChange={e => setForm(f => ({ ...f, divisor: e.target.value }))} />
              <span style={{ fontSize: 11, color: 'var(--text2)' }}>
                El precio de su web se guarda dividido entre esto (1.38 ≈ Genius + 10% de Booking). 1 = sin ajustar.
              </span>
            </div>
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving} style={{ alignSelf: 'flex-start' }}>
              {saving ? 'Guardando…' : 'Guardar'}
            </button>
          </div>
        )}

        <table className="data-table">
          <thead><tr>
            <th>Nombre</th><th>Motor</th><th>Última actualización</th>
            <th title="Precio de mostrador ÷ esto = precio efectivo (Booking Genius + rebaja)">Divisor</th>
            <th>Activo</th>{!readOnly && <th></th>}
          </tr></thead>
          <tbody>
            {hotels.map((h: any) => (
              <tr key={h.id}>
                <td>{h.name}</td>
                <td style={{ fontSize: 12, color: 'var(--text2)' }}>{PLATFORM_LABEL[h.platform] ?? h.platform}</td>
                <td style={{ fontSize: 12, color: h.lastError ? 'var(--red)' : 'var(--text2)' }}
                  title={h.lastError ?? undefined}>
                  {h.lastFetchedAt ? new Date(h.lastFetchedAt).toLocaleString('es-ES') : 'Nunca'}
                  {h.lastError ? ' · error' : ''}
                </td>
                <td>
                  {readOnly ? h.bookingEffectiveDivisor : (
                    <input type="number" min="1" step="0.01" defaultValue={h.bookingEffectiveDivisor}
                      style={{ width: 64, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '3px 6px', fontSize: 12 }}
                      onBlur={e => updateDivisor(h, e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
                  )}
                </td>
                <td>
                  <label className="rate-toggle">
                    <input type="checkbox" checked={h.active} disabled={readOnly} onChange={() => toggleActive(h)} />
                  </label>
                </td>
                {!readOnly && (
                  <td style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost btn-sm" disabled={refreshingId === h.id} onClick={() => refresh(h.id)}>
                      {refreshingId === h.id ? '…' : 'Actualizar'}
                    </button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--red)' }} onClick={() => remove(h.id, h.name)}>✕</button>
                  </td>
                )}
              </tr>
            ))}
            {hotels.length === 0 && <tr><td colSpan={readOnly ? 5 : 6} style={{ color: 'var(--text2)' }}>Sin competidores configurados todavía.</td></tr>}
          </tbody>
        </table>
      </div>

      {hotels.length > 0 && (
        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2>Comparativa de precios</h2>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Nuestra tarifa:</span>
                <select value={rateId} onChange={e => setRateId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">La más barata</option>
                  {allRates.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Tipo de habitación:</span>
                <select value={roomTypeId} onChange={e => setRoomTypeId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">La más barata</option>
                  {allRoomTypes.map((rt: any) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
                </select>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--text2)' }}>Periodo:</span>
                <select value={periodDays} onChange={e => setPeriodDays(Number(e.target.value))}>
                  {PERIOD_OPTIONS.map(d => <option key={d} value={d}>{d} días</option>)}
                </select>
              </div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={360}>
            <LineChart data={series} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }}
                tickFormatter={(d: string) => d.slice(8, 10) + '/' + d.slice(5, 7)} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={fmtEur1} width={60} />
              <RTooltip formatter={(v: any) => v == null ? 'sin datos' : fmtEur1(v)} labelFormatter={(d: any) => String(d)} />
              <Legend />
              <Line type="monotone" dataKey="ours"
                name={(() => {
                  const parts = [
                    rateId !== '' ? allRates.find((r: any) => r.id === rateId)?.title : null,
                    roomTypeId !== '' ? allRoomTypes.find((rt: any) => rt.id === roomTypeId)?.name : null,
                  ].filter(Boolean)
                  return parts.length ? `Nosotros (${parts.join(' · ')})` : 'Nosotros'
                })()}
                stroke="#22c55e" strokeWidth={3} dot={false} connectNulls />
              {hotels.map((h: any, i: number) => (
                <Line key={h.id} type="monotone" dataKey={`c_${h.id}`} name={h.name}
                  stroke={COMPETITOR_COLORS[i % COMPETITOR_COLORS.length]} strokeWidth={2} dot={false} connectNulls />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

function PriceHistoryPanel({ allRates }: { allRates: any[] }) {
  const [from,       setFrom]       = useState(addDays(today(), -14))
  const [to,         setTo]         = useState(addDays(today(), 45))
  const [rateId,     setRateId]     = useState<number | ''>('')
  const [batches,    setBatches]    = useState<import('../lib/api').PriceHistoryBatch[]>([])
  const [expanded,   setExpanded]   = useState<Set<string>>(new Set())
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const params: Record<string, string> = { from, to }
      if (rateId !== '') params.rateId = String(rateId)
      const r = await api.priceHistory(params)
      setBatches(r.data)
    } catch (e: any) { setError(e.message) }
    finally { setLoading(false) }
  }, [from, to, rateId])

  useEffect(() => { load() }, [load])

  const toggle = (batchId: string) => setExpanded(s => {
    const n = new Set(s); if (n.has(batchId)) n.delete(batchId); else n.add(batchId); return n
  })

  return (
    <div className="card" style={{ padding: 16 }}>
      <h3 style={{ marginBottom: 4 }}>Historial de cambios de precio</h3>
      <p style={{ color: 'var(--text2)', fontSize: 13, marginBottom: 16 }}>
        Ediciones manuales desde el calendario y ajustes automáticos del motor de reglas dinámicas —
        quién (o si fue automático), cuándo, precio antes/después y qué fechas afectó.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 16 }}>
        <div className="form-group" style={{ margin: 0 }}>
          <label style={{ fontSize: 11 }}>Fechas afectadas desde</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 13 }} />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label style={{ fontSize: 11 }}>hasta</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 13 }} />
        </div>
        <div className="form-group" style={{ margin: 0 }}>
          <label style={{ fontSize: 11 }}>Tarifa</label>
          <select value={rateId} onChange={e => setRateId(e.target.value ? Number(e.target.value) : '')}
            style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '5px 8px', fontSize: 13 }}>
            <option value="">Todas las tarifas</option>
            {allRates.map((r: any) => <option key={r.id} value={r.id}>{r.title}</option>)}
          </select>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={load}>Refrescar</button>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 30, color: 'var(--text2)' }}>Cargando…</div>}
      {error   && <div style={{ textAlign: 'center', padding: 20, color: 'var(--red)' }}>Error: {error}</div>}
      {!loading && !error && batches.length === 0 && (
        <div style={{ textAlign: 'center', padding: 30, color: 'var(--text2)' }}>Sin cambios de precio en este rango</div>
      )}

      {!loading && !error && batches.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Usuario / origen</th>
                <th>Tarifa</th>
                <th>Tipo(s) hab.</th>
                <th>Antes → Después</th>
                <th>Fechas afectadas</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {batches.map(b => {
                const isOpen = expanded.has(b.batchId)
                return (
                  <Fragment key={b.batchId}>
                    <tr style={{ cursor: b.items.length > 1 ? 'pointer' : 'default' }}
                        onClick={() => b.items.length > 1 && toggle(b.batchId)}>
                      <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{fmtDateTime(b.changedAt)}</td>
                      <td>
                        {b.source === 'manual'
                          ? <span>{b.userName ?? 'Usuario desconocido'}</span>
                          : <span title={b.ruleName ? `Regla: ${b.ruleName}` : 'Reverso automático a precio base'} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                              🤖 Automático{b.ruleName ? ` (${b.ruleName})` : ' (reverso a base)'}
                            </span>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{b.rateTitle}</td>
                      <td style={{ fontSize: 12.5 }}>{b.roomTypes.join(', ')}</td>
                      <td style={{ fontSize: 13, whiteSpace: 'nowrap' }}>
                        {b.uniform
                          ? <>{fmtPrice(b.oldPrice)} → <strong>{fmtPrice(b.newPrice)}</strong></>
                          : <span style={{ color: 'var(--text2)' }}>varios (ver detalle)</span>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>
                        {fmtDatesAffected(b.datesAffected)}
                        {b.items.length > 1 && <span style={{ marginLeft: 6, color: 'var(--accent)' }}>{isOpen ? '▲' : '▼'}</span>}
                      </td>
                      <td></td>
                    </tr>
                    {isOpen && b.items.length > 1 && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--bg3)', padding: '8px 14px' }}>
                          <table style={{ width: '100%' }}>
                            <thead>
                              <tr>
                                <th style={{ fontSize: 11 }}>Fecha</th>
                                <th style={{ fontSize: 11 }}>Tipo hab.</th>
                                <th style={{ fontSize: 11 }}>Antes → Después</th>
                                <th style={{ fontSize: 11 }}>Cerrada</th>
                              </tr>
                            </thead>
                            <tbody>
                              {b.items.map((it, i) => (
                                <tr key={i}>
                                  <td style={{ fontSize: 12 }}>{fmtDateCal(it.date)}</td>
                                  <td style={{ fontSize: 12 }}>{it.roomTypeName}</td>
                                  <td style={{ fontSize: 12 }}>{fmtPrice(it.oldPrice)} → {fmtPrice(it.newPrice)}</td>
                                  <td style={{ fontSize: 12 }}>{it.closed ? 'Sí' : ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ── AvailEditor ───────────────────────────────────────────────────────────────
function AvailEditor({ rtId, date, total, occupied, override, rect, onSave, onClear, onCancel }: {
  rtId: number; date: string; total: number; occupied: number; override: number | null
  rect: { top: number; left: number; bottom: number }
  onSave: (val: number) => void; onClear: () => void; onCancel: () => void
}) {
  const calculated = Math.max(0, total - occupied)
  const [val, setVal] = useState(String(override !== null ? override : calculated))
  const dt = new Date(date + 'T00:00:00')
  const fmtDate = `${dt.getDate()}/${dt.getMonth() + 1}/${dt.getFullYear()}`

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const el = document.getElementById('pcal-avail-editor')
      if (el && !el.contains(e.target as Node)) onCancel()
    }
    const t = setTimeout(() => document.addEventListener('mousedown', handler), 100)
    return () => { clearTimeout(t); document.removeEventListener('mousedown', handler) }
  }, [onCancel])

  const save = () => { const n = parseInt(val); if (!isNaN(n) && n >= 0) onSave(n) }

  const style: CSSProperties = {
    position: 'fixed', zIndex: 1001,
    top:  rect.bottom + 6,
    left: Math.max(4, Math.min(rect.left, window.innerWidth - 260)),
  }

  return (
    <div id="pcal-avail-editor" style={style}>
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
        Disponibilidad — {fmtDate}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 10 }}>
        Calculado: {calculated}/{total} · {occupied} reservada{occupied !== 1 ? 's' : ''}
        {override !== null && <span style={{ color: '#f59e0b' }}> · Override: {override}</span>}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="number" min={0} max={total} value={val}
          onChange={e => setVal(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') onCancel() }}
          autoFocus
          style={{ width: 70, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', padding: '4px 8px', fontSize: 13 }}
        />
        <button className="btn btn-sm btn-primary" onClick={save}>Guardar</button>
        {override !== null && (
          <button className="btn btn-sm btn-ghost" onClick={onClear} title="Volver al valor calculado desde reservas">
            Auto
          </button>
        )}
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>✕</button>
      </div>
    </div>
  )
}

function RoomTypeSelector({ roomTypes, defaultIds, selectedIds, onApply, onCancel }:
  { roomTypes: any[]; defaultIds: number[] | null; selectedIds: number[] | null; onApply: (ids: number[]) => void; onCancel: () => void }) {
  const allIds = roomTypes.map((t: any) => t.id)
  const defaultIdSet = new Set(defaultIds ?? [])
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(selectedIds ?? allIds)
  )
  const toggle = (id: number) => setChecked(s => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  return (
    <div id="pcal-rate-selector">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Tipos de habitación</span>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>{checked.size}/{roomTypes.length}</span>
      </div>
      {roomTypes.length === 0 && <p style={{ fontSize: 12, color: 'var(--text2)' }}>Sin tipos definidos</p>}
      {roomTypes.map((t: any) => {
        const isVirtual = t.name.toLowerCase().includes('virtual')
        return (
          <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={checked.has(t.id)} onChange={() => toggle(t.id)} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            {defaultIdSet.has(t.id) && (
              <span style={{ fontSize: 9, color: 'var(--accent)', background: 'rgba(79,124,255,.15)', padding: '1px 5px', borderRadius: 8, marginLeft: 'auto' }}>★</span>
            )}
            {isVirtual && <span style={{ fontSize: 9, color: 'var(--text2)', background: 'var(--bg3)', padding: '1px 5px', borderRadius: 8, marginLeft: defaultIdSet.has(t.id) ? 4 : 'auto' }}>virtual</span>}
          </label>
        )
      })}
      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" onClick={() => onApply([...checked])}>Aplicar</button>
        {defaultIds && <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set(defaultIdSet))}>Predeter.</button>}
        <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set(allIds))}>Todos</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set())}>Ninguno</button>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>✕</button>
      </div>
    </div>
  )
}

function RateSelector({ allRates, defaultIds, selectedIds, onApply, onCancel }:
  { allRates: any[]; defaultIds: number[] | null; selectedIds: number[] | null; onApply: (ids: number[]) => void; onCancel: () => void }) {
  const allIds = allRates.map((r: any) => r.id)
  const defaultIdSet = new Set(defaultIds ?? [])
  const [checked, setChecked] = useState<Set<number>>(
    () => new Set(selectedIds ?? allIds)
  )
  const toggle = (id: number) => setChecked(s => {
    const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n
  })
  return (
    <div id="pcal-rate-selector">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>Tarifas visibles</span>
        <span style={{ fontSize: 11, color: 'var(--text2)' }}>{checked.size}/{allRates.length}</span>
      </div>
      {allRates.map((r: any) => (
        <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={checked.has(r.id)} onChange={() => toggle(r.id)} />
          <span>{r.title}{r.locked ? ' 🔒' : ''}</span>
          {defaultIdSet.has(r.id) && (
            <span style={{ fontSize: 9, color: 'var(--accent)', background: 'rgba(79,124,255,.15)', padding: '1px 5px', borderRadius: 8, marginLeft: 'auto' }}>★</span>
          )}
        </label>
      ))}
      <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-sm btn-primary" onClick={() => onApply([...checked])}>Aplicar</button>
        {defaultIds && <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set(defaultIdSet))}>Predeter.</button>}
        <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set(allIds))}>Todas</button>
        <button className="btn btn-sm btn-ghost" onClick={() => setChecked(new Set())}>Ninguna</button>
        <button className="btn btn-sm btn-secondary" onClick={onCancel}>✕</button>
      </div>
    </div>
  )
}
