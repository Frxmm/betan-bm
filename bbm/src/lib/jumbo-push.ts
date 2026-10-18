// Integración con el portal B2B de Jumbo (tour operador ya integrado como
// canal del hotel — ver enums.ts 'jumbo_credit' y el canal "jumbo" en
// alerts.ts) — contracts.jumbonline.com. Login por formulario (no hay API
// real), luego setPrice.htm/getContractsCalendar.htm como haría el propio
// JS de la página (ver scripts/jumboContractsManagement.js, capturado del
// portal real). Toda esta lógica se validó primero de forma standalone en
// scripts/test-jumbo-price-push.ts antes de traerla aquí.
//
// La tarifa de Jumbo del tenant (settings jumbo.rateId) suele ser una tarifa
// DERIVADA de la tarifa raíz (baseRateId + adjustType/adjustValue), con un tipo
// de habitación de referencia (settings jumbo.roomTypeId, o rates.room_type_id
// si no se define): Jumbo usa ese tipo como "el" precio del contrato, aunque el
// contrato en sí combine varios roomIds de Jumbo en un único precio compartido
// (ver jumbo.rateIds/roomIds/boardIds en jumboCfg).
//
// El precio "de verdad" para una fecha es siempre el que resuelve
// resolvePrice() para (jumbo.rateId, tipo de referencia) — exactamente la misma función que usa el calendario para pintar
// el precio, así nunca puede haber desacuerdo entre lo que se ve en pantalla
// y lo que se empuja.
//
// La disponibilidad que se empuja (setStock.htm, operation=replace) es
// nuestra disponibilidad global real (computeCalendarAvailability, el mismo
// cálculo que usan el motor de reglas de precios y la alerta de alta
// ocupación) menos un colchón fijo (jumbo.availabilityBuffer) — no depende
// de ninguna tarifa, cambia con cada reserva/cancelación/bloqueo.
//
// El "dirty tracking" (tanto de precio como de disponibilidad) compara el
// valor resuelto/calculado contra el último que se empujó con éxito (tabla
// jumbo_push_state) — así detecta cualquier cambio real sea cual sea su
// origen (motor de reglas, edición manual de la tarifa raíz o de la de Jumbo, una nueva
// reserva, un bloqueo...), sin necesidad de rastrear "qué tocó qué".
import { db } from '../db'
import { getPropertyId, getSecret, getSetting, getBranding, hasFeature } from './property'
import { rates, rateDailyPrices, roomTypes, jumboPushState } from '../db/schema'
import { and, eq, or, isNull, inArray, sql } from 'drizzle-orm'
import { resolvePrice, type RateForPricing, type RoomTypeForPricing, type DailyPriceRow } from './price-resolver'
import { computeCalendarAvailability } from './calendarOccupancy'

// Cuántas habitaciones se reservan SIEMPRE fuera de lo que se publica en
// Jumbo, sobre la disponibilidad global real (mismo cálculo que usa el motor
// de reglas de precios y la alerta de alta ocupación) — colchón para no
// vaciar el hotel entero a través de este canal.

const BASE = 'https://contracts.jumbonline.com'

// Configuración Jumbo POR TENANT (settings jumbo.*): sin defaults de ningún hotel.
//   jumbo.buildingId / handlerId / pcId     — ids del edificio, gestor y contrato de venta en Jumbo
//   jumbo.rateIds / roomIds / boardIds      — combinaciones sobre las que Jumbo aplica UN precio compartido por día
//   jumbo.rateId / roomTypeId               — tarifa local que se publica y su tipo de habitación de referencia
//   jumbo.availabilityBuffer                — habitaciones que nunca se ofrecen por este canal (defecto 0)
// Credenciales: secretos JUMBO_LOGIN / JUMBO_PASSWORD.
interface JumboCfg {
  buildingId: string; handlerId: string; pcId: string
  rateIds: string; roomIds: string; boardIds: string
  rateId: number | null; roomTypeId: number | null; availabilityBuffer: number
  timezone: string
}

async function jumboCfg(): Promise<JumboCfg> {
  if (!await hasFeature('jumbo')) throw new Error('Módulo Jumbo no activado')
  const str = async (k: string) => { const v = await getSetting<string | number>(`jumbo.${k}`); return v == null ? '' : String(v) }
  const cfg = {
    buildingId: await str('buildingId'), handlerId: await str('handlerId'), pcId: await str('pcId'),
    rateIds: await str('rateIds'), roomIds: await str('roomIds'), boardIds: await str('boardIds'),
  }
  const missing = Object.entries(cfg).filter(([, v]) => !v).map(([k]) => `jumbo.${k}`)
  if (missing.length) throw new Error(`Jumbo sin configurar (settings ${missing.join(', ')})`)
  const rateId = await getSetting<number>('jumbo.rateId'), roomTypeId = await getSetting<number>('jumbo.roomTypeId')
  return {
    ...cfg,
    rateId: rateId != null ? Number(rateId) : null,
    roomTypeId: roomTypeId != null ? Number(roomTypeId) : null,
    availabilityBuffer: Number(await getSetting<number>('jumbo.availabilityBuffer', 0)) || 0,
    timezone: (await getBranding()).timezone,
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'
const BROWSER_HEADERS: Record<string, string> = {
  'Accept': '*/*',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'User-Agent': UA,
}
const AJAX_HEADERS: Record<string, string> = {
  ...BROWSER_HEADERS,
  'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
  'Origin': BASE,
  'Referer': `${BASE}/contractsManagement.htm`,
  'X-Requested-With': 'XMLHttpRequest',
}
const LOCALE_COOKIE = 'org.springframework.web.servlet.i18n.CookieLocaleResolver.LOCALE'

export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('jumbo')) return false
  return !!(await getSecret('JUMBO_LOGIN') && await getSecret('JUMBO_PASSWORD') && await getSetting('jumbo.pcId'))
}

function getSetCookies(res: Response): string[] {
  return typeof (res.headers as any).getSetCookie === 'function'
    ? (res.headers as any).getSetCookie() as string[]
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : [])
}

// Login + carga del building en sesión (buildingForPcManagement.htm) — sin
// esto setPrice.htm devuelve un "Internal Error" JSON (el servidor no tiene
// contrato cargado en la sesión). Se hace una vez por lote de push, no por
// fecha — reutilizar la sesión para todo el lote evita loguear N veces.
async function jumboLogin(): Promise<string> {
  const cfg      = await jumboCfg()
  const login    = await getSecret('JUMBO_LOGIN')
  const password = await getSecret('JUMBO_PASSWORD')
  if (!login || !password) throw new Error('JUMBO_LOGIN / JUMBO_PASSWORD no configurados')

  const jar = new Map<string, string>()
  const addCookies = (cookies: string[]) => {
    for (const c of cookies) {
      const kv = c.split(';')[0]!
      const eq = kv.indexOf('=')
      if (eq > 0) jar.set(kv.slice(0, eq), kv)
    }
  }

  const preRes = await fetch(`${BASE}/login.htm`, { headers: BROWSER_HEADERS })
  addCookies(getSetCookies(preRes))
  await preRes.text().catch(() => {})

  const loginBody = new URLSearchParams({
    urlAccess: '', contractId: '', offlineContractId: '', lastAction: '',
    login, password,
  })
  const loginRes = await fetch(`${BASE}/login.htm`, {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...(jar.size > 0 ? { Cookie: [...jar.values()].join('; ') } : {}),
    },
    body: loginBody.toString(),
    redirect: 'manual',
  })
  addCookies(getSetCookies(loginRes))

  if (![...jar.keys()].some(k => k.toUpperCase().includes('JSESSIONID'))) {
    throw new Error('Login a Jumbo falló: no se recibió cookie JSESSIONID (credenciales incorrectas o cambió login.htm)')
  }
  if (!jar.has(LOCALE_COOKIE)) jar.set(LOCALE_COOKIE, `${LOCALE_COOKIE}=en`)

  const cookieHeader = [...jar.values()].join('; ')

  const buildingBody = new URLSearchParams({
    buildingId: cfg.buildingId, handlerId: cfg.handlerId, cityId: '', districtId: '',
    categoryGroupIds: '', showOldContracts: 'false', showOnlyActiveContracts: 'false',
    language: 'en',
  })
  const buildingRes = await fetch(`${BASE}/buildingForPcManagement.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: buildingBody.toString(),
  })
  await buildingRes.text().catch(() => {})

  return cookieHeader
}

function isoToDMY(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d}/${m}/${y}`
}

async function jumboSetPrice(cookieHeader: string, dateDMY: string, price: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = await jumboCfg()
  const body = new URLSearchParams({
    rateIds: cfg.rateIds, roomIds: cfg.roomIds, boardIds: cfg.boardIds, pcId: cfg.pcId,
    selDays: dateDMY, weekdays: 'XXXXXXX', component: 'prices', isShared: 'yes',
    sharedVal: String(price), isOffer: 'false', baseRate: '', priceType: 'ROOM',
    paxType: '', amountType: '', values: '', isResetZero: 'false',
    operation: 'SET_PRICE', language: 'en',
  })
  const res = await fetch(`${BASE}/contractsManagement/setPrice.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  let data: any = null
  try { data = JSON.parse(text) } catch { return { ok: false, error: `respuesta no-JSON: ${text.slice(0, 200)}` } }
  if (data?.errors && data.errors.length > 0) return { ok: false, error: JSON.stringify(data.errors).slice(0, 300) }
  return { ok: true }
}

// operation=replace + sharedRooms=yes: fija el cupo a `units` para todas las
// habitaciones/tarifas/regímenes combinados del contrato en esa fecha — igual
// semántica que isShared=yes en setPrice. Confirmado contra el portal real en
// scripts/test-jumbo-price-push.ts.
async function jumboSetStock(cookieHeader: string, dateDMY: string, units: number): Promise<{ ok: boolean; error?: string }> {
  const cfg = await jumboCfg()
  const body = new URLSearchParams({
    rateIds: cfg.rateIds, roomIds: cfg.roomIds, boardIds: cfg.boardIds, pcId: cfg.pcId,
    selDays: dateDMY, weekdays: 'XXXXXXX', operation: 'replace',
    sharedRooms: 'yes', units: String(units), isSecurity: 'false', language: 'en',
  })
  const res = await fetch(`${BASE}/contractsManagement/setStock.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  let data: any = null
  try { data = JSON.parse(text) } catch { return { ok: false, error: `respuesta no-JSON: ${text.slice(0, 200)}` } }
  if (data?.errors && data.errors.length > 0) return { ok: false, error: JSON.stringify(data.errors).slice(0, 300) }
  return { ok: true }
}

// Cierra la venta para esa fecha (operation=Y — "msjCerrar" en el JS de la
// página real, ver scripts/jumboContractsManagement.js). Se usa en vez de
// setStock con 0 cuando la disponibilidad calculada da ≤ 0 — un canal B2B no
// debería anunciar "0 unidades", debe dejar de vender del todo. OJO: pcIds va
// en PLURAL aquí (a diferencia de pcId en setPrice/setStock), no hay
// componente ni sharedRooms/isSecurity/units, y la respuesta de éxito se
// valida por `validationErrors` (no por `errors`, a diferencia de
// setPrice/setStock) — así distingue completeStopResultScreen() en la página
// real entre msjCorrecto/msjIncorrecto. No hay confirmado un valor de
// "reabrir" — si una fecha vuelve a tener disponibilidad > 0 tras haber
// estado cerrada, este código solo vuelve a mandar setStock con el número
// real (ver computeJumboDirtyEntries); NO manda ninguna llamada explícita de
// reapertura porque no se ha confirmado ese operation value contra Jumbo.
async function jumboSetStopSales(cookieHeader: string, dateDMY: string): Promise<{ ok: boolean; error?: string }> {
  const cfg = await jumboCfg()
  const body = new URLSearchParams({
    rateIds: cfg.rateIds, roomIds: cfg.roomIds, boardIds: cfg.boardIds, pcIds: cfg.pcId,
    selDays: dateDMY, weekdays: 'XXXXXXX', operation: 'Y', language: 'en',
  })
  const res = await fetch(`${BASE}/contractsManagement/setStopSales.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
  let data: any = null
  try { data = JSON.parse(text) } catch { return { ok: false, error: `respuesta no-JSON: ${text.slice(0, 200)}` } }
  if (data?.validationErrors && data.validationErrors.length > 0) return { ok: false, error: JSON.stringify(data.validationErrors).slice(0, 300) }
  return { ok: true }
}

// Lee el calendario de un mes completo y devuelve fecha ISO → precio, usando
// currentDate (ms) convertido a fecha civil de Madrid — ver
// scripts/test-jumbo-price-push.ts para el razonamiento (día/mes/año sueltos
// no son fiables si el tipo no coincide con lo esperado).
async function jumboReadCalendarMonth(cookieHeader: string, dateFrom01: string): Promise<Map<string, number>> {
  const cfg = await jumboCfg()
  const body = new URLSearchParams({
    rateIds: cfg.rateIds, roomIds: cfg.roomIds, boardIds: cfg.boardIds, pcIds: cfg.pcId,
    dateFrom: dateFrom01, dateTo: '', view: 'month', isSecurityView: 'false',
    exactDay: 'false', currentComponent: 'prices',
  })
  const res = await fetch(`${BASE}/contractsManagement/getContractsCalendar.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: body.toString(),
  })
  const text = await res.text()
  const map = new Map<string, number>()
  if (!res.ok) return map
  let data: any = null
  try { data = JSON.parse(text) } catch { return map }
  for (const m of (data?.months ?? [])) {
    for (const d of (m.days ?? [])) {
      if (typeof d.currentDate !== 'number') continue
      const detail = d.priceDay?.priceDetails?.find((p: any) => String(p.pcId) === String(cfg.pcId))
      if (typeof detail?.value === 'number') map.set(new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date(d.currentDate)), detail.value)
    }
  }
  return map
}

// Igual que jumboReadCalendarMonth pero pidiendo currentComponent=allotment
// (la vista de cupos, no la de precios) y leyendo stockDetails[].available —
// el cupo interno que fija setStock con operation=replace (distinto de
// totalAvailable, que es la disponibilidad ya publicada al público — ver
// scripts/test-jumbo-price-push.ts).
async function jumboReadCalendarStockMonth(cookieHeader: string, dateFrom01: string): Promise<Map<string, number>> {
  const cfg = await jumboCfg()
  const body = new URLSearchParams({
    rateIds: cfg.rateIds, roomIds: cfg.roomIds, boardIds: cfg.boardIds, pcIds: cfg.pcId,
    dateFrom: dateFrom01, dateTo: '', view: 'month', isSecurityView: 'false',
    exactDay: 'false', currentComponent: 'allotment',
  })
  const res = await fetch(`${BASE}/contractsManagement/getContractsCalendar.htm`, {
    method: 'POST',
    headers: { ...AJAX_HEADERS, 'Cookie': cookieHeader },
    body: body.toString(),
  })
  const text = await res.text()
  const map = new Map<string, number>()
  if (!res.ok) return map
  let data: any = null
  try { data = JSON.parse(text) } catch { return map }
  for (const m of (data?.months ?? [])) {
    for (const d of (m.days ?? [])) {
      if (typeof d.currentDate !== 'number') continue
      const detail = (d.stockDetails ?? []).find((p: any) => String(p.pcId) === String(cfg.pcId))
      if (typeof detail?.available === 'number') map.set(new Intl.DateTimeFormat('en-CA', { timeZone: cfg.timezone }).format(new Date(d.currentDate)), detail.available)
    }
  }
  return map
}

export interface JumboPushEntry {
  date: string /* ISO YYYY-MM-DD */
  price?: number
  // availability y stopSales son mutuamente excluyentes para una fecha: si
  // stopSales viene true, availability se ignora (ver computeJumboDirtyEntries
  // — nunca se manda un `units` con la fecha cerrada, se cierra la venta).
  availability?: number
  stopSales?: boolean
}
export interface JumboPushDetail {
  date: string
  pricePushed?: boolean; priceVerified?: boolean; priceError?: string
  availabilityPushed?: boolean; availabilityVerified?: boolean; availabilityError?: string
  // stopSales no tiene verificación fiable todavía (no hay confirmado qué
  // campo de getContractsCalendar refleja el cierre — ver
  // scripts/test-jumbo-price-push.ts) — se trata "pushed sin error" como éxito.
  stopSalesPushed?: boolean; stopSalesError?: string
}
export interface JumboPushResult { pushed: number; verified: number; errors: number; details: JumboPushDetail[] }

// Empuja un lote de entradas (precio y/o disponibilidad por fecha): login una
// vez, setPrice/setStock secuencial por fecha (sin concurrencia — es una
// integración de formulario, no una API pensada para paralelismo), y una
// verificación final por cada mes distinto tocado (un getContractsCalendar
// de precios si hubo precios, otro de allotment si hubo disponibilidad — no
// por fecha) comparando lo que Jumbo dice tener contra lo pedido: un 2xx de
// setPrice/setStock no demuestra que el cambio quedó puesto de verdad.
export async function pushEntriesToJumbo(entries: JumboPushEntry[]): Promise<JumboPushResult> {
  if (!await isConfigured()) throw new Error('Jumbo no configurado (módulo, settings jumbo.* y JUMBO_LOGIN / JUMBO_PASSWORD)')
  if (entries.length === 0) return { pushed: 0, verified: 0, errors: 0, details: [] }

  const cookieHeader = await jumboLogin()
  const details: JumboPushDetail[] = entries.map(e => ({ date: e.date }))
  const detailByDate = new Map(details.map(d => [d.date, d]))

  for (const e of entries) {
    const d = detailByDate.get(e.date)!
    if (e.price != null) {
      try {
        const r = await jumboSetPrice(cookieHeader, isoToDMY(e.date), e.price)
        d.pricePushed = r.ok
        d.priceError  = r.error
      } catch (err: any) { d.pricePushed = false; d.priceError = err.message }
    }
    if (e.stopSales) {
      try {
        const r = await jumboSetStopSales(cookieHeader, isoToDMY(e.date))
        d.stopSalesPushed = r.ok
        d.stopSalesError  = r.error
      } catch (err: any) { d.stopSalesPushed = false; d.stopSalesError = err.message }
    } else if (e.availability != null) {
      try {
        const r = await jumboSetStock(cookieHeader, isoToDMY(e.date), e.availability)
        d.availabilityPushed = r.ok
        d.availabilityError  = r.error
      } catch (err: any) { d.availabilityPushed = false; d.availabilityError = err.message }
    }
  }

  const months = new Set(entries.map(e => e.date.slice(0, 7))) // YYYY-MM
  const needsPriceVerify        = entries.some(e => e.price       != null)
  const needsAvailabilityVerify = entries.some(e => e.availability != null)

  for (const ym of months) {
    const [y, m] = ym.split('-').map(Number)
    const dateFrom01 = `01/${String(m).padStart(2, '0')}/${y}`

    if (needsPriceVerify) {
      try {
        const priceMap = await jumboReadCalendarMonth(cookieHeader, dateFrom01)
        for (const e of entries) {
          if (!e.date.startsWith(ym) || e.price == null) continue
          const d = detailByDate.get(e.date)!
          if (!d.pricePushed) continue
          const actual = priceMap.get(e.date)
          d.priceVerified = actual != null && Math.abs(actual - e.price) < 0.01
          if (!d.priceVerified) d.priceError = `verificación: Jumbo tiene ${actual ?? '(no encontrado)'}, se pidió ${e.price}`
        }
      } catch (err: any) {
        for (const e of entries) {
          if (!e.date.startsWith(ym) || e.price == null) continue
          const d = detailByDate.get(e.date)!
          if (d.pricePushed) d.priceError = d.priceError ?? `verificación falló: ${err.message}`
        }
      }
    }

    if (needsAvailabilityVerify) {
      try {
        const availMap = await jumboReadCalendarStockMonth(cookieHeader, dateFrom01)
        for (const e of entries) {
          if (!e.date.startsWith(ym) || e.availability == null) continue
          const d = detailByDate.get(e.date)!
          if (!d.availabilityPushed) continue
          const actual = availMap.get(e.date)
          d.availabilityVerified = actual === e.availability
          if (!d.availabilityVerified) d.availabilityError = `verificación: Jumbo tiene ${actual ?? '(no encontrado)'}, se pidió ${e.availability}`
        }
      } catch (err: any) {
        for (const e of entries) {
          if (!e.date.startsWith(ym) || e.availability == null) continue
          const d = detailByDate.get(e.date)!
          if (d.availabilityPushed) d.availabilityError = d.availabilityError ?? `verificación falló: ${err.message}`
        }
      }
    }
  }

  let pushed = 0, verified = 0, errors = 0
  for (const d of details) {
    if (d.pricePushed !== undefined) { pushed++; d.priceVerified ? verified++ : errors++ }
    if (d.availabilityPushed !== undefined) { pushed++; d.availabilityVerified ? verified++ : errors++ }
    // Sin verificación de lectura fiable (ver comentario de stopSalesPushed
    // en JumboPushDetail) — una respuesta sin error se cuenta como verificada.
    if (d.stopSalesPushed !== undefined) { pushed++; d.stopSalesPushed && !d.stopSalesError ? verified++ : errors++ }
  }

  return { pushed, verified, errors, details }
}

export interface JumboSyncResult {
  skipped: boolean
  reason?: string
  pushed: number
  verified: number
  errors: number
  errorList: string[]
}

// Sube la cadena baseRateId desde jumboRate hasta la raíz (tarifa raíz),
// hasta 6 niveles — igual límite que buildDerivationChain en price-resolver.ts.
async function buildRateChain(startRate: RateForPricing): Promise<Map<number, RateForPricing>> {
  const map = new Map<number, RateForPricing>([[startRate.id, startRate]])
  let cur = startRate
  let depth = 0
  while (cur.baseRateId && depth < 6) {
    if (map.has(cur.baseRateId)) break // ciclo
    const [base] = await db.select({ id: rates.id, baseRateId: rates.baseRateId, adjustType: rates.adjustType, adjustValue: rates.adjustValue })
      .from(rates).where(and(eq(rates.id, cur.baseRateId), eq(rates.propertyId, getPropertyId()))).limit(1)
    if (!base) break
    map.set(base.id, base)
    cur = base
    depth++
  }
  return map
}

// Precio "de verdad" de la tarifa de Jumbo para cada fecha: se resuelve para
// su tipo de habitación de referencia con resolvePrice(), la
// misma función que usa el calendario — así nunca puede haber desacuerdo
// entre lo que se ve en PriceCalendarView y lo que se empuja aquí.
async function resolveJumboPricesForDates(
  jumboRate: RateForPricing & { roomTypeId: number | null },
  dates: string[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (dates.length === 0) return result
  if (jumboRate.roomTypeId == null) return result // sin tipo de habitación de referencia configurado (rates.room_type_id)

  const targetRoomTypeId = jumboRate.roomTypeId
  const ratesById = await buildRateChain(jumboRate)
  const chainIds  = [...ratesById.keys()]

  const [roomTypeRow] = await db.select({
    id: roomTypes.id, baseRoomTypeId: roomTypes.baseRoomTypeId,
    adjustType: roomTypes.adjustType, adjustValue: roomTypes.adjustValue,
    maxOccupancy: roomTypes.maxOccupancy,
  }).from(roomTypes).where(and(eq(roomTypes.id, targetRoomTypeId), eq(roomTypes.propertyId, getPropertyId()))).limit(1)
  if (!roomTypeRow) return result
  const roomTypesById = new Map<number, RoomTypeForPricing>([[roomTypeRow.id, roomTypeRow]])
  const occupancy = roomTypeRow.maxOccupancy ?? 1

  const priceRowsRaw = await db.select({
    rateId: rateDailyPrices.rateId, roomTypeId: rateDailyPrices.roomTypeId,
    date: rateDailyPrices.date, price: rateDailyPrices.price,
  }).from(rateDailyPrices).where(and(
    inArray(rateDailyPrices.rateId, chainIds),
    or(eq(rateDailyPrices.roomTypeId, targetRoomTypeId), isNull(rateDailyPrices.roomTypeId)),
    inArray(rateDailyPrices.date, dates),
  ))
  const priceRows: DailyPriceRow[] = priceRowsRaw

  for (const date of dates) {
    const price = resolvePrice(ratesById, roomTypesById, priceRows, jumboRate.id, targetRoomTypeId, date, occupancy)
    if (price != null) result.set(date, price)
  }
  return result
}

// Disponibilidad "de verdad" a empujar a Jumbo para cada fecha: nuestra
// disponibilidad global real (mismo cálculo que el motor de reglas de
// precios y la alerta de alta ocupación — habitaciones físicas activas menos
// ocupadas/bloqueadas, respetando overrides manuales) menos un colchón fijo
// (jumbo.availabilityBuffer) que nunca se ofrece por este canal.
async function resolveJumboAvailabilityForDates(dates: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>()
  if (dates.length === 0) return result
  const buffer = (await jumboCfg()).availabilityBuffer
  const sorted = [...dates].sort()
  const { freeByDate } = await computeCalendarAvailability(sorted[0]!, sorted[sorted.length - 1]!)
  for (const date of dates) {
    const free = freeByDate.get(date)
    if (free != null) result.set(date, Math.max(0, free - buffer))
  }
  return result
}

export type JumboDirtyCheck =
  | { skipped: true; reason: string }
  | { skipped: false; toPush: JumboPushEntry[] }

// Parte RÁPIDA (solo BD, sin tocar Jumbo): resuelve precio Y disponibilidad de
// la tarifa de Jumbo para cada fecha candidata y decide qué campo(s) de cada una
// difieren del último valor empujado con éxito (jumbo_push_state) — o todo lo
// resoluble si force. Separado de la parte lenta (pushAndCacheJumboEntries)
// porque el push manual (src/routes/jumbo.ts) necesita poder responder
// "sin cambios" al instante sin esperar a Jumbo.
export async function computeJumboDirtyEntries(candidateDates: string[], opts: { force?: boolean } = {}): Promise<JumboDirtyCheck> {
  if (!await isConfigured()) return { skipped: true, reason: 'Jumbo no configurado (módulo, settings jumbo.* y credenciales JUMBO_*)' }
  if (candidateDates.length === 0) return { skipped: true, reason: 'sin fechas' }

  const cfg = await jumboCfg()
  if (cfg.rateId == null) return { skipped: true, reason: 'Jumbo sin tarifa configurada (setting jumbo.rateId)' }
  const rateRow = await db.query.rates.findFirst({
    where: and(eq(rates.id, cfg.rateId), eq(rates.propertyId, getPropertyId())),
  })
  if (!rateRow) return { skipped: true, reason: 'la tarifa de Jumbo (jumbo.rateId) no existe' }
  const jumboRate = { ...rateRow, roomTypeId: cfg.roomTypeId ?? rateRow.roomTypeId }
  if (jumboRate.roomTypeId == null) return { skipped: true, reason: 'tarifa de Jumbo sin tipo de habitación de referencia (jumbo.roomTypeId o rates.room_type_id)' }

  const ratesById = await buildRateChain(jumboRate)
  const chainIds  = [...ratesById.keys()]

  const [resolvedPrices, resolvedAvailability, closedRows] = await Promise.all([
    resolveJumboPricesForDates(jumboRate, candidateDates),
    resolveJumboAvailabilityForDates(candidateDates),
    // Si la tarifa de Jumbo o cualquier tarifa de su cadena está cerrada para
    // una fecha, equivale a disponibilidad 0 — se dispara stopSales igual que
    // cuando no quedan habitaciones físicas libres.
    db.select({ date: rateDailyPrices.date }).from(rateDailyPrices).where(and(
      eq(rateDailyPrices.propertyId, getPropertyId()),
      inArray(rateDailyPrices.rateId, chainIds),
      inArray(rateDailyPrices.date, candidateDates),
      eq(rateDailyPrices.closed, true),
    )),
  ])
  if (resolvedPrices.size === 0 && resolvedAvailability.size === 0 && closedRows.length === 0) {
    return { skipped: true, reason: 'sin precio ni disponibilidad resolubles para esas fechas' }
  }

  // Fechas marcadas como cerradas en la cadena de la tarifa de Jumbo → forzar avail=0
  for (const { date } of closedRows) {
    resolvedAvailability.set(date, 0)
  }

  const allDates = new Set([...resolvedPrices.keys(), ...resolvedAvailability.keys()])
  const cacheByDate = new Map<string, { price: number | null; availability: number | null; stopSales: boolean | null }>()
  if (!opts.force) {
    const cached = await db.select().from(jumboPushState)
      .where(and(eq(jumboPushState.propertyId, getPropertyId()), inArray(jumboPushState.date, [...allDates])))
    for (const r of cached) {
      cacheByDate.set(r.date, {
        price: r.price != null ? parseFloat(r.price) : null,
        availability: r.availability,
        stopSales: r.stopSales,
      })
    }
  }

  const toPush: JumboPushEntry[] = []
  for (const date of allDates) {
    const price        = resolvedPrices.get(date)
    const availability  = resolvedAvailability.get(date)
    const cached = cacheByDate.get(date)

    const priceDirty = price !== undefined
      && (opts.force || cached?.price == null || Math.abs(cached.price - price) >= 0.005)

    // Si la disponibilidad calculada da ≤ 0, se cierra la venta (setStopSales)
    // en vez de mandar un `units` de 0 por setStock — un canal B2B no debería
    // anunciar "0 unidades", debe dejar de vender del todo esa fecha.
    let availabilityDirty = false
    let stopSalesDirty = false
    if (availability !== undefined) {
      if (availability <= 0) {
        stopSalesDirty = opts.force || cached?.stopSales !== true
      } else {
        // Recupera disponibilidad > 0: se manda el número real por setStock.
        // No hay una llamada explícita de "reabrir" confirmada contra Jumbo —
        // ver el comentario de jumboSetStopSales — así que esto es lo más
        // parecido a una reapertura que se puede hacer con lo que sabemos.
        availabilityDirty = opts.force || cached?.availability == null || cached.availability !== availability
      }
    }

    if (!priceDirty && !availabilityDirty && !stopSalesDirty) continue
    toPush.push({
      date,
      ...(priceDirty ? { price } : {}),
      ...(stopSalesDirty ? { stopSales: true } : availabilityDirty ? { availability } : {}),
    })
  }

  if (toPush.length === 0) return { skipped: true, reason: 'sin cambios desde el último push' }
  return { skipped: false, toPush }
}

// Parte LENTA: el push real a Jumbo (login + N×setPrice/setStock +
// verificación) y la actualización de la caché — solo el campo (precio y/o
// disponibilidad) que verificó con éxito en cada fecha; el que falla queda
// "sucio" para reintentar en el siguiente push. Dos upserts separados (no uno
// solo con ambos campos) porque cada fecha puede traer solo precio, solo
// disponibilidad, o ambos — un upsert conjunto pisaría con null el campo que
// esa fecha no tocaba esta vez si ya había algo cacheado de antes.
async function pushAndCacheJumboEntries(toPush: JumboPushEntry[]): Promise<JumboSyncResult> {
  const result = await pushEntriesToJumbo(toPush)
  const entryByDate = new Map(toPush.map(e => [e.date, e]))

  const priceVerifiedDates = result.details.filter(d => d.priceVerified).map(d => d.date)
  if (priceVerifiedDates.length > 0) {
    await db.insert(jumboPushState).values(priceVerifiedDates.map(date => ({
      propertyId: getPropertyId(), date, price: entryByDate.get(date)!.price!.toFixed(2), availability: null, pushedAt: new Date(),
    }))).onConflictDoUpdate({
      target: [jumboPushState.propertyId, jumboPushState.date],
      set: { price: sql`excluded.price`, pushedAt: sql`excluded.pushed_at` },
    })
  }

  const availabilityVerifiedDates = result.details.filter(d => d.availabilityVerified).map(d => d.date)
  if (availabilityVerifiedDates.length > 0) {
    // Un setStock con éxito significa que esa fecha ya NO está parada (es lo
    // más parecido a una reapertura confirmada que se puede afirmar aquí, ver
    // jumboSetStopSales) — se marca stopSales:false para que el próximo cálculo
    // no la trate como "todavía cerrada".
    await db.insert(jumboPushState).values(availabilityVerifiedDates.map(date => ({
      propertyId: getPropertyId(), date, price: null, availability: entryByDate.get(date)!.availability!, stopSales: false, pushedAt: new Date(),
    }))).onConflictDoUpdate({
      target: [jumboPushState.propertyId, jumboPushState.date],
      set: { availability: sql`excluded.availability`, stopSales: sql`excluded.stop_sales`, pushedAt: sql`excluded.pushed_at` },
    })
  }

  const stopSalesVerifiedDates = result.details.filter(d => d.stopSalesPushed && !d.stopSalesError).map(d => d.date)
  if (stopSalesVerifiedDates.length > 0) {
    await db.insert(jumboPushState).values(stopSalesVerifiedDates.map(date => ({
      propertyId: getPropertyId(), date, price: null, availability: null, stopSales: true, pushedAt: new Date(),
    }))).onConflictDoUpdate({
      target: [jumboPushState.propertyId, jumboPushState.date],
      set: { stopSales: sql`excluded.stop_sales`, pushedAt: sql`excluded.pushed_at` },
    })
  }

  return {
    skipped: false,
    pushed: result.pushed, verified: result.verified, errors: result.errors,
    errorList: result.details.flatMap(d =>
      [d.priceError, d.availabilityError, d.stopSalesError].filter((e): e is string => !!e).map(err => `${d.date}: ${err}`)
    ),
  }
}

// Punto de entrada usado por el hook automático del motor de reglas
// (pricingRulesEngine.ts, no es una petición HTTP así que puede esperar sin
// problema): calcula y empuja en un solo paso.
export async function syncJumboPrices(candidateDates: string[], opts: { force?: boolean } = {}): Promise<JumboSyncResult> {
  const empty = { pushed: 0, verified: 0, errors: 0, errorList: [] as string[] }
  const check = await computeJumboDirtyEntries(candidateDates, opts)
  if (check.skipped) return { skipped: true, reason: check.reason, ...empty }
  return pushAndCacheJumboEntries(check.toPush)
}

// ── Push manual en segundo plano ────────────────────────────────────────────
// Jumbo puede tardar >30s en responder a un solo setPrice.htm — con varias
// fechas seguidas (login + buildingForPcManagement + N×setPrice + verificación)
// la petición HTTP del push manual supera con facilidad el timeout del proxy
// (504 Gateway Timeout) aunque el envío en sí termine bien en el servidor. Por
// eso src/routes/jumbo.ts NO espera a syncJumboPrices(): lanza esto, responde
// al instante, y el resultado se consulta aparte (GET /api/jumbo/push-status).
export interface JumboPushStatus {
  running: boolean
  last: (JumboSyncResult & { finishedAt: string; requestedDates: number }) | null
}

const jumboPushRunning = new Set<number>()                      // por tenant
const lastJumboPushResult = new Map<number, JumboPushStatus['last']>()

export function getJumboPushStatus(): JumboPushStatus {
  const pid = getPropertyId()
  return { running: jumboPushRunning.has(pid), last: lastJumboPushResult.get(pid) ?? null }
}

// Devuelve false si ya había un push en curso (no se lanza uno nuevo encima).
export function startJumboPushInBackground(toPush: JumboPushEntry[]): boolean {
  const pid = getPropertyId()
  if (jumboPushRunning.has(pid)) return false
  jumboPushRunning.add(pid)
  pushAndCacheJumboEntries(toPush)
    .then(result => {
      lastJumboPushResult.set(pid, { ...result, finishedAt: new Date().toISOString(), requestedDates: toPush.length })
    })
    .catch(err => {
      lastJumboPushResult.set(pid, {
        skipped: true, reason: err instanceof Error ? err.message : String(err),
        pushed: 0, verified: 0, errors: 1, errorList: [err instanceof Error ? err.message : String(err)],
        finishedAt: new Date().toISOString(), requestedDates: toPush.length,
      })
    })
    .finally(() => { jumboPushRunning.delete(pid) })
  return true
}
