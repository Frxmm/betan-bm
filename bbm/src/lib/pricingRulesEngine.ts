// ─── Motor de reglas de precio dinámico ────────────────────────────────────────
// Corre cada 30 minutos. Ajusta el precio de la tarifa raíz (pricing.rootRateId; de la que
// derivan todas las demás vía resolvePrice(), así que ajustarla aquí se
// propaga sola al resto) según las reglas activas en pricing_rules:
//
//   low_availability: sube el precio de cualquier día del horizonte (30 días)
//     cuya disponibilidad caiga por debajo del umbral de la regla.
//   lead_time_dip:    baja el precio, pero SOLO del día que cae exactamente en
//     "hoy + lead time medio de reservas de Booking.com (últimos 28 días)",
//     si la ocupación de ESE día concreto está por debajo del umbral.
//   local_min_dip:    baja el precio en los mínimos locales discretos de
//     ocupación dentro de hoy+3..hoy+60 (mesetas completas incluidas), con
//     ocupación por debajo del umbral de la regla. Si coincide con el día
//     exacto de lead_time_dip, manda lead_time_dip (más específica) y esta
//     no toca esa fecha.
//   demand_pulse_dip: BAJA el precio de forma progresiva en fechas hoy..hoy+3
//     cuando pasan bloques de PULSE_HOURS_THRESHOLD horas sin ninguna reserva
//     nueva CUYA ESTADÍA PASE POR ESA NOCHE (check_in_date <= fecha <
//     check_out_date, no solo las que entran exactamente ese día — una
//     reserva de varias noches cuenta como demanda para TODAS las que ocupa)
//     y su ocupación sigue por debajo del umbral de la regla — un escalón de
//     −adjustValue% por cada bloque.
//     El precio nunca baja de minAdrFloorPct% (configurable por regla, por
//     defecto 90%) del ADR real de LA SEMANA de esa fecha (weeklyAdrByDate,
//     mismo cálculo que colorea el calendario de precios) — si esa semana
//     aún no tiene ADR real, cae a un tope fijo de seguridad del 30% de
//     descuento sobre basePrice. El % acumulado nunca se pasa de lo que ese
//     suelo permite (se capa en cada pasada), así que en cuanto el precio
//     toca el suelo, las siguientes PULSE_BOOKINGS_PER_STEP reservas ya
//     suben el precio de verdad, sin pasos "de más" que recuperar antes.
//     Cada PULSE_BOOKINGS_PER_STEP reservas nuevas de esa fecha suben un
//     escalón de +adjustValue/2%, hasta volver al precio original. En cuanto
//     la ocupación de esa fecha vuelve a superar el umbral, O booking_surge
//     detecta un repunte de reservas en vivo para esa misma fecha (si está
//     activa), el descuento se retira del todo en el acto (no espera a que
//     lleguen bastantes reservas nuevas para consumirlo a escalones) — un
//     repunte de verdad ahora mismo pesa más que un descuento acumulado por
//     un silencio de hace días. Es la única regla con memoria entre pasadas
//     (demand_pulse_state) — las demás siempre recalculan desde basePrice sin
//     acordarse de la pasada anterior; esta necesita saber cuántas reservas
//     ya ha "consumido" hacia el próximo escalón de subida, porque en cuanto
//     llega una reserva el reloj de "horas sin reservas" salta a ~0 y se
//     perdería la subida gradual si se recalculase todo desde cero.
//   sold_out_upsell: venta de superiores — dentro del horizonte (30 días),
//     cuando sourceRoomTypeId (p.ej. "Doble") tiene 0 unidades disponibles
//     calculadas ese día, BAJA el precio de ese tipo origen para que
//     targetRoomTypeId (p.ej. "Doble Superior", derivado de él) quede a
//     precio original del origen + adjustValue € — casi regala la subida de
//     categoría en vez de perder la venta al estar la base agotada. El origen
//     está agotado, así que bajarlo no pierde ventas. Ojo: arrastra también a
//     los demás tipos derivados del origen y a las tarifas derivadas.
//     Condición binaria (0 disponibles), no usa thresholdPct.
//   evening_clearance_dip: liquidación nocturna — SOLO para la fecha de HOY
//     (hora local del hotel) y SOLO a partir de las 20:00. Si el precio
//     (basePrice) es mayor que el ADR real de LA SEMANA de hoy
//     (weeklyAdrByDate) y la ocupación de hoy sigue por debajo de
//     thresholdPct (normalmente 100%: "hasta que se llene"), baja el precio
//     ORIGINAL un escalón de adjustValue% por cada hora completa desde las
//     20:00 (20:00→-adjustValue%, 21:00→-2×adjustValue%, ...) — siempre
//     calculado sobre basePrice, no acumulativo sobre el precio ya rebajado.
//     Nunca baja de minAdrFloorPct% (normalmente 100%) del ADR real semanal —
//     si esa semana no tiene ADR real todavía, la regla no actúa (no hay con
//     qué comparar "precio mayor que el ADR"). Sin memoria entre pasadas: el
//     escalón se recalcula cada vez a partir de la hora real transcurrida
//     desde las 20:00, así que autocorrige aunque el motor no pase justo cada
//     hora en punto (corre cada 30 min).
//   booking_surge: reservas seguidas — SUBE el precio de una noche en cuanto
//     se detectan 2 o más reservas hechas (bookedAt) cuya ESTADÍA pase por
//     esa noche (check_in_date <= fecha < check_out_date, no solo las que
//     entran exactamente ese día) dentro de los últimos thresholdPct minutos
//     (aquí thresholdPct no es un %, es la ventana en minutos, reutilizado
//     igual que en otros tipos — por defecto 60). Sube adjustValue% sobre
//     basePrice. Sin memoria entre
//     pasadas (como low_availability/local_min_dip): cada pasada vuelve a
//     contar reservas recientes en vivo, así que se apaga sola en cuanto deja
//     de haber 2+ dentro de la ventana móvil — por tiempo, o porque las
//     reservas que la dispararon ya quedaron fuera de ella.
//
// UNA sola regla por fecha: si varias se cumplen el mismo día, gana la de menor
// pricing_rules.priority (empate → menor id, es decir la más antigua) y esa
// regla decide el precio de todas las celdas de esa fecha; las demás quedan en
// suspenso ese día. Las prioridades iniciales (migración 0113) reproducen el
// orden que tenía antes el código: parada de reservas < liquidación nocturna <
// venta de superiores < lead time < mínimos locales < disponibilidad baja <
// competidores. Configurables desde Tarifas → Reglas.
//
// Siempre parte de rateDailyPrices.basePrice (el precio puesto a mano), nunca
// del price ya ajustado por una pasada anterior — evita que el ajuste se
// acumule sobre sí mismo. Cada aplicación real de una regla (no los reversos,
// que son silenciosos) queda registrada en pricing_rule_applications, que es
// lo que lee la alerta morada en alerts.ts.
//
// Ninguna regla toca tipos de habitación derivados (roomTypes.baseRoomTypeId
// no nulo): su precio siempre se calcula a partir del tipo base vía
// resolvePrice(), así que cualquier fila propia que tengan en
// rate_daily_prices es inerte — tocarla no cambia el precio que ve nadie,
// solo ensucia el historial.

import { db } from '../db'
import {
  pricingRules, pricingRuleApplications, priceChangeLog, rateDailyPrices, rates, roomTypes,
  reservations, demandPulseState, competitorHotels, competitorPrices, rooms, blockedBeds, type PricingRule,
} from '../db/schema'
import { and, eq, gt, gte, lte, isNotNull, isNull, notInArray, inArray, sql } from 'drizzle-orm'
import { avgLeadTimeDays, weeklyAdrByDate } from './occupancyReport'
import { computeCalendarOccupancyPct } from './calendarOccupancy'
import { resolvePrice, rateChainIds, invertRateChainToRoot, invertRoomTypeChainToBase } from './price-resolver'
import { applyAdjust, getRootRateId } from './rootRate'
import { getPropertyId, getProperty, getSetting, forEachActiveProperty } from './property'
import { syncJumboPrices } from './jumbo-push'

// Alias histórico (antes 'Dir AL'): la tarifa raíz ahora es configurable por tenant.
const getDirALRateId = getRootRateId
export { applyAdjust, getRootRateId, getDirALRateId }

const HORIZON_DAYS          = 30  // hasta dónde mira low_availability
const LEAD_TIME_WINDOW_DAYS = 28  // histórico para calcular el lead time medio de Booking.com
const LOCAL_MIN_FROM_DAYS   = 3   // ventana de local_min_dip: hoy+3 ...
const LOCAL_MIN_TO_DAYS     = 60  // ... hasta hoy+60
const SWEEP_INTERVAL_MS     = 30 * 60_000  // cada 30 minutos

const COMPETITOR_FROM_DAYS   = 3     // ventana de competitor_undercut: hoy+3 ...
const COMPETITOR_TO_DAYS     = 21    // ... hasta hoy+21

const PULSE_WINDOW_TO_DAYS   = 3     // ventana de demand_pulse_dip: hoy ... hoy+3
// Minutos sin reservas nuevas para sumar un escalón de bajada — valor por
// defecto/red de seguridad para filas de antes de que existiera
// pricingRules.pulseSilenceMinutes; la regla real siempre usa su propio
// campo (configurable en RatesView), esto solo cubre el caso null/undefined.
const PULSE_SILENCE_MINUTES_DEFAULT = 240
// Igual que arriba pero para evening_clearance_dip — valores por defecto/red
// de seguridad para filas de antes de que existieran estos dos campos.
const EVENING_OVERRIDE_MINUTES_DEFAULT = 60
const EVENING_START_HOUR_DEFAULT = 20
const PULSE_BOOKINGS_PER_STEP = 2    // reservas nuevas necesarias para subir un escalón
const PULSE_STEP_UP_RATIO    = 0.5   // el escalón de subida es la mitad del de bajada
// El límite real de bajada es minAdrFloorPct (configurable por regla, % del
// ADR real de la semana — ver weeklyAdrByDate) aplicado como suelo en €
// sobre el precio final, no un tope fijo sobre el % de descuento. Este 30%
// es solo la red de seguridad para cuando esa semana aún no tiene ADR real
// (sin ninguna noche ocupada todavía) y no hay con qué calcular el suelo real.
const PULSE_FALLBACK_MAX_DISCOUNT_PCT = 30
// Tope de sanidad sobre el % bruto que acumulan los escalones de bajada —
// no es "el límite" (ese es el suelo de ADR de arriba), solo evita que el
// número interno crezca sin sentido en silencios muy largos.
const PULSE_SANITY_MAX_DISCOUNT_PCT = 95

// OJO: antes usaba d.getFullYear()/getMonth()/getDate() — hora LOCAL del
// proceso (normalmente UTC en el servidor), no la del hotel. Durante la
// ventana de medianoche a las 1-2h del hotel (cuando en UTC todavía es el
// día anterior), esto hacía que "hoy" fuera un día antes de lo que
// correspondía — el ancla de todo el horizonte de precios (`from`, línea
// ~743) y por tanto de booking_surge y demand_pulse_dip ("Parada de
// reservas"), que cuentan reservas/silencio desde esa fecha. Mismo criterio
// que ya usaba localToday más abajo (línea ~782).
// Zona horaria del tenant en curso (properties.timezone). Se rellena al inicio de
// cada pasada (applyPricingRules); fuera de una pasada cae a UTC.
const tzByProperty = new Map<number, string>()
function tz(): string {
  return tzByProperty.get(getPropertyId()) ?? 'UTC'
}
function todayISO(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(new Date())
}
function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Estado y diagnóstico de la última pasada (solo lectura) ──────────────────
// Lo consulta el agente de IA (get_pricing_rules_status en ai.ts) para
// contestar "¿están en marcha las reglas?" y "¿por qué no se aplica X esta
// fecha?". Se rellena con lo que el motor decidió DE VERDAD en la última
// pasada (no reimplementa la lógica), así que vive en memoria: tras un
// reinicio se vuelve a llenar en el arranque, que lanza una pasada al momento.
export type RuleDiag = { ruleId: number; ruleType: string; name: string; priority: number; fires: boolean; why: string }
export type DateDiag = {
  date: string; occupancyPct: number; winnerRuleId: number | null; rules: RuleDiag[]
  cells: number; cellsChanged: number; cellsSuppressedByManualOverride: number; notes: string[]
}
export type PassStatus = {
  startedAt: string; finishedAt: string | null; running: boolean
  outcome: 'ok' | 'error' | 'sin_reglas_activas' | 'sin_dir_al' | 'omitida_por_solape' | 'en_curso'
  error?: string; applied: number; cellsProcessed: number
  horizonFrom: string | null; horizonTo: string | null
  warnings: { ruleId: number | null; message: string }[]
}
let schedulerStartedAt: Date | null = null
// Estado por tenant (una pasada por property; las pasadas son secuenciales pero
// el estado de cada hotel no debe pisar al de los demás).
type TenantState = {
  passRunning: boolean
  lastPass: PassStatus | null
  lastDiag: Map<string, DateDiag>
  passWarnings: { ruleId: number | null; message: string }[]
}
const stateByProperty = new Map<number, TenantState>()
function tstate(): TenantState {
  const pid = getPropertyId()
  let st = stateByProperty.get(pid)
  if (!st) { st = { passRunning: false, lastPass: null, lastDiag: new Map(), passWarnings: [] }; stateByProperty.set(pid, st) }
  return st
}

// Aviso de configuración/estado de una regla concreta: al log de siempre y,
// además, al diagnóstico de la pasada (para que el agente pueda explicarlo).
function ruleWarn(ruleId: number | null, message: string) {
  console.error(message)
  tstate().passWarnings.push({ ruleId, message })
}

// Todos los timestamps de este módulo se guardan en UTC (.toISOString(), con
// "Z" al final) — correcto para guardar, pero un humano (o el propio agente
// de IA al explicarlo) puede leer "16:29" y compararlo sin querer contra la
// hora de pared local, pareciendo un desfase de 2h que en realidad no
// existe (16:29 UTC = 18:29 local en verano). Por eso este status añade
// también la hora ya convertida a la zona del hotel, para no tener que hacer esa cuenta
// a mano ni arriesgarse a leerla mal.
function formatLocal(iso: string | null | undefined): string | null {
  if (!iso) return null
  const zone = tz()
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: zone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(iso)) + ` (${zone})`
}

export function getPricingEngineStatus() {
  const { lastPass, passRunning } = tstate()
  const lastStart = lastPass ? new Date(lastPass.startedAt).getTime() : null
  const minutesSinceLastStart = lastStart != null ? Math.round((Date.now() - lastStart) / 60_000) : null
  const intervalMinutes = SWEEP_INTERVAL_MS / 60_000
  const nextExpectedStart = lastStart != null ? new Date(lastStart + SWEEP_INTERVAL_MS).toISOString() : null
  return {
    nowLocal: formatLocal(new Date().toISOString()),
    schedulerStartedAt: schedulerStartedAt?.toISOString() ?? null,
    schedulerStartedAtLocal: formatLocal(schedulerStartedAt?.toISOString()),
    intervalMinutes,
    passRunningNow: passRunning,
    lastPass,
    lastPassStartedAtLocal:  formatLocal(lastPass?.startedAt),
    lastPassFinishedAtLocal: formatLocal(lastPass?.finishedAt),
    minutesSinceLastStart,
    nextExpectedStart,
    nextExpectedStartLocal: formatLocal(nextExpectedStart),
    // Más de 2 intervalos sin arrancar ninguna pasada = el scheduler no está corriendo.
    looksStalled: schedulerStartedAt == null || (minutesSinceLastStart != null && minutesSinceLastStart > intervalMinutes * 2 + 5),
    horizonDays: HORIZON_DAYS,
    diagnosedDates: tstate().lastDiag.size,
  }
}
export function getPricingDateDiagnosis(date: string): DateDiag | null {
  return tstate().lastDiag.get(date) ?? null
}

// Lead time medio (días) de reservas de Booking.com hechas en los últimos
// LEAD_TIME_WINDOW_DAYS días — mismo cálculo compartido que usa el informe
// de Ocupación (avgLeadTimeDays en occupancyReport.ts: bookedAt dentro del
// rango, no fecha de check-in), filtrado solo al canal Booking. Un único
// cálculo con un único criterio en vez de dos versiones que puedan divergir.
async function avgBookingComLeadDays(): Promise<number | null> {
  const to   = todayISO()
  const from = addDaysISO(to, -LEAD_TIME_WINDOW_DAYS)
  return avgLeadTimeDays({ from, to, channelNameLike: 'booking' })
}

// Fechas que son mínimo local discreto de ocupación dentro de
// [from+windowFromDays, from+windowToDays], con ocupación < thresholdPct.
// Incluye mesetas completas: si varios días seguidos comparten el mismo
// valor mínimo, se marcan todos, no solo el primero. Compara cada meseta
// contra un día de margen a cada lado (fuera de la ventana) para saber si
// de verdad es un valle y no un tramo plano dentro de una pendiente.
export function findLocalMinimaDates(
  occByDate: Map<string, number>,
  from: string,
  windowFromDays: number,
  windowToDays: number,
  thresholdPct: number,
): Set<string> {
  const marked = new Set<string>()
  const offsets: number[] = []
  const values:  number[] = []
  for (let o = windowFromDays - 1; o <= windowToDays + 1; o++) {
    const v = occByDate.get(addDaysISO(from, o))
    if (v == null) return marked  // datos incompletos: no arriesgar falsos mínimos
    offsets.push(o)
    values.push(v)
  }

  let i = 0
  while (i < values.length) {
    let j = i
    while (j + 1 < values.length && values[j + 1] === values[i]) j++
    // meseta (posiblemente de un solo día): índices [i, j], mismo valor
    const v        = values[i]!
    const leftVal  = i - 1 >= 0            ? values[i - 1] : null
    const rightVal = j + 1 < values.length ? values[j + 1] : null
    const isLocalMin =
      v < thresholdPct &&
      (leftVal  == null || v <= leftVal) &&
      (rightVal == null || v <= rightVal) &&
      ((leftVal != null && v < leftVal) || (rightVal != null && v < rightVal))
    if (isLocalMin) {
      for (let k = i; k <= j; k++) {
        const o = offsets[k]!
        if (o >= windowFromDays && o <= windowToDays) marked.add(addDaysISO(from, o))
      }
    }
    i = j + 1
  }
  return marked
}

// Calcula el % de descuento vigente de demand_pulse_dip para cada fecha de
// check-in en [from, from+PULSE_WINDOW_TO_DAYS], actualizando (o creando) su
// fila de estado en demand_pulse_state. Devuelve un Map fecha→%descuento
// (solo fechas con descuento > 0 aportan algo al llamador).
async function computeDemandPulseDiscounts(
  rule: PricingRule,
  from: string,
  occByDate: Map<string, number>,
  floorPctByDate: Map<string, number>,
  // Fechas con un repunte de reservas en vivo (booking_surge, si está
  // activa) — un repunte de verdad ahora mismo pesa más que un descuento
  // acumulado por un silencio de hace días, así que cuenta como otra
  // "recuperación inmediata", igual que la ocupación ya recuperada.
  surgeDates: Set<string> = new Set(),
): Promise<Map<string, number>> {
  const to = addDaysISO(from, PULSE_WINDOW_TO_DAYS)
  const stepDownPct = parseFloat(rule.adjustValue)
  const stepUpPct   = stepDownPct * PULSE_STEP_UP_RATIO
  const now         = new Date()

  // Una sola query: nº de reservas activas y fecha de la última, por cada
  // fecha de la ventana — cuenta cualquier reserva cuya ESTADÍA pase por esa
  // noche (check_in_date <= fecha < check_out_date), no solo las que entran
  // exactamente ese día. Una reserva de varias noches es demanda real para
  // TODAS las noches que ocupa, no solo la primera.
  // generate_series(date, date, interval) devuelve timestamp, no date — sin el
  // (::date) intermedio, ::text sale con hora ("2026-09-28 00:00:00") y nunca
  // coincide con las fechas limpias (addDaysISO) que usa el resto del motor
  // para buscar en este mapa: la fecha de hoy podía tener reservas de sobra y
  // aun así no encontrar nunca su entrada, sin lanzar ningún error (ver mismo
  // comentario en reports.ts). Este era el motivo real de "nunca se crea el
  // estado base" en demand_pulse_dip.
  const bookingStatsRaw = await db.execute(sql`
    SELECT (d.date::date)::text AS check_in_date, COUNT(*)::int AS count, MAX(r.booked_at) AS last_booked_at
    FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) AS d(date)
    JOIN reservations r
      ON r.property_id = ${getPropertyId()}
     AND r.status NOT IN ('cancelled', 'no_show')
     AND r.check_in_date <= d.date AND r.check_out_date > d.date
    GROUP BY d.date
  `) as unknown as { check_in_date: string; count: number; last_booked_at: string | null }[]
  const bookingStats = bookingStatsRaw.map(r => ({ checkInDate: r.check_in_date, count: r.count, lastBookedAt: r.last_booked_at }))
  const statsByDate = new Map(bookingStats.map(s => [s.checkInDate, s]))

  const existingStates = await db.select().from(demandPulseState)
    .where(and(eq(demandPulseState.ruleId, rule.id), gte(demandPulseState.date, from), lte(demandPulseState.date, to)))
  const stateByDate = new Map(existingStates.map(s => [s.date, s]))

  // Diagnóstico de por qué una fecha nunca acumula estado (visto en
  // producción: 29 reservas activas, ventana correcta, y aun así sin fila) —
  // sin esto, un fallo aquí era invisible del todo (sin try/catch propio,
  // solo se veía como pass.outcome='error' genérico si tumbaba la pasada
  // entera, y nada si el INSERT simplemente no se ejecutaba por alguna
  // condición no contemplada).
  console.log(`[pricingRules] demand_pulse_dip: ventana ${from}..${to} — fechas con reservas: ${
    bookingStats.length ? bookingStats.map(s => `${s.checkInDate}(${s.count})`).join(', ') : '(ninguna)'
  }; estados existentes: ${existingStates.length ? existingStates.map(s => s.date).join(', ') : '(ninguno)'}`)

  const discountByDate = new Map<string, number>()

  for (let o = 0; o <= PULSE_WINDOW_TO_DAYS; o++) {
    const date  = addDaysISO(from, o)
    const stats = statsByDate.get(date)
    if (!stats || stats.count === 0) continue  // sin ninguna reserva histórica: no hay "pausa" que detectar
    const liveCount = stats.count

    const existing = stateByDate.get(date)
    if (!existing) {
      // Primera vez que se ve esta fecha: solo se registra la foto de
      // partida, no se dispara nada — si no, las reservas ya existentes se
      // contarían como "nuevas" y se pondría a subir un descuento que nunca bajó.
      // Envuelto en try/catch (con ruleWarn, visible vía get_pricing_rules_status)
      // en vez de dejar que un fallo aquí sea invisible o tumbe la pasada entera.
      try {
        await db.insert(demandPulseState).values({
          propertyId: getPropertyId(), ruleId: rule.id, date, bookingsSeenTotal: liveCount,
        })
        console.log(`[pricingRules] demand_pulse_dip: estado base creado para ${date} (bookingsSeenTotal=${liveCount})`)
      } catch (e: any) {
        ruleWarn(rule.id, `[pricingRules] demand_pulse_dip: fallo creando estado base para ${date}: ${e.message}`)
      }
      continue
    }

    let discountPct        = parseFloat(existing.discountPct)
    let bookingsTowardStep = existing.bookingsTowardStep
    let silenceStartAt     = existing.silenceStartAt
    const newBookings      = Math.max(0, liveCount - existing.bookingsSeenTotal)
    const occPct           = occByDate.get(date)

    if (discountPct > 0 && ((occPct != null && occPct >= rule.thresholdPct) || surgeDates.has(date))) {
      // Recuperación inmediata: o bien la ocupación de este día ya está de
      // vuelta por encima del umbral, o bien hay un repunte de reservas en
      // vivo ahora mismo (booking_surge) para esta fecha — en ambos casos se
      // retira el descuento del todo en el acto, sin esperar a que lleguen
      // bastantes reservas nuevas para consumir escalones. Si no, un día
      // podía quedarse con descuento "congelado" pasadas y pasadas mientras
      // la ocupación ya iba bien (o mientras entraban reservas a toda prisa),
      // solo porque no habían entrado 2 reservas nuevas justas desde la
      // última vez.
      discountPct = 0; silenceStartAt = null; bookingsTowardStep = 0
    } else if (newBookings > 0) {
      // Solo cuentan "hacia el próximo escalón" si hay un descuento activo
      // que recuperar — si no, no hay nada que subir y no queremos que se
      // acumule un remanente que luego dispare varios escalones de golpe en
      // cuanto arranque un episodio de bajada futuro.
      if (discountPct > 0) {
        bookingsTowardStep += newBookings
        while (bookingsTowardStep >= PULSE_BOOKINGS_PER_STEP && discountPct > 0) {
          discountPct = Math.max(0, discountPct - stepUpPct)
          bookingsTowardStep -= PULSE_BOOKINGS_PER_STEP
        }
        if (discountPct <= 0.005) { discountPct = 0; silenceStartAt = null; bookingsTowardStep = 0 }
      }
    } else if (occPct != null && occPct < rule.thresholdPct) {
      const anchor = silenceStartAt ?? (stats.lastBookedAt ? new Date(stats.lastBookedAt) : null)
      if (anchor) {
        const minutesSilent  = (now.getTime() - anchor.getTime()) / 60_000
        const silenceMinutes = rule.pulseSilenceMinutes ?? PULSE_SILENCE_MINUTES_DEFAULT
        const targetSteps    = Math.floor(minutesSilent / silenceMinutes)
        // Capado al % que corresponde al suelo de precio (floorPctByDate) —
        // así el % acumulado nunca se pasa de lo que el suelo permite, y la
        // recuperación por reservas nuevas es inmediata en cuanto se toca el
        // suelo (ver comentario en applyPricingRules). El tope de sanidad
        // solo entra si esa fecha no tiene suelo calculado (caso raro).
        const floorPct = floorPctByDate.get(date) ?? PULSE_SANITY_MAX_DISCOUNT_PCT
        const targetDiscount = Math.min(PULSE_SANITY_MAX_DISCOUNT_PCT, floorPct, targetSteps * stepDownPct)
        if (targetDiscount > discountPct) { discountPct = targetDiscount; silenceStartAt = anchor }
      }
    }

    await db.update(demandPulseState)
      .set({ discountPct: discountPct.toFixed(2), silenceStartAt, bookingsSeenTotal: liveCount, bookingsTowardStep, updatedAt: now })
      .where(eq(demandPulseState.id, existing.id))

    if (discountPct > 0) discountByDate.set(date, discountPct)
  }

  return discountByDate
}

// Calcula cuántos escalones de -adjustValue% lleva ya acumulados
// evening_clearance_dip para HOY, con memoria entre pasadas reutilizando la
// misma tabla que demand_pulse_dip (demand_pulse_state) — aquí
// bookingsTowardStep se reaprovecha como "horas de retraso acumuladas por
// reservas nuevas" (no como "reservas hacia el siguiente escalón", ver
// demand_pulse_dip): cada reserva nueva de hoy retrasa una hora el próximo
// escalón, en vez de deshacer descuento ya aplicado — a diferencia de
// demand_pulse_dip, esta regla nunca "sube" el precio de vuelta sola.
// steps = horas completas transcurridas desde las 20:00, menos las horas de
// retraso acumuladas, mínimo 0. Se calcula siempre desde la hora real (no
// desde cuántas veces ha pasado el motor), así autocorrige si el motor no
// pasa justo cada hora en punto.
async function computeEveningClearanceSteps(rule: PricingRule, date: string, localHour: number): Promise<number> {
  const startHour = rule.clearanceStartHour ?? EVENING_START_HOUR_DEFAULT
  if (localHour < startHour) return 0

  // Cuenta reservas cuya ESTADÍA pase por esta noche (check_in_date <= fecha
  // < check_out_date), no solo las que entran exactamente hoy — mismo
  // criterio que demand_pulse_dip/booking_surge (ver comentario de cabecera).
  const [stats] = await db.select({ count: sql<number>`count(*)::int` }).from(reservations)
    .where(and(
      eq(reservations.propertyId, getPropertyId()),
      lte(reservations.checkInDate, date),
      gt(reservations.checkOutDate, date),
      notInArray(reservations.status, ['cancelled', 'no_show']),
    ))
  const liveCount = stats?.count ?? 0

  const existing = await db.query.demandPulseState.findFirst({
    where: and(eq(demandPulseState.ruleId, rule.id), eq(demandPulseState.date, date)),
  })

  let delayHours: number
  if (!existing) {
    delayHours = 0
    await db.insert(demandPulseState).values({
      propertyId: getPropertyId(), ruleId: rule.id, date, bookingsSeenTotal: liveCount, bookingsTowardStep: 0,
    })
  } else {
    const newBookings = Math.max(0, liveCount - existing.bookingsSeenTotal)
    delayHours = existing.bookingsTowardStep + newBookings
    await db.update(demandPulseState)
      .set({ bookingsSeenTotal: liveCount, bookingsTowardStep: delayHours, updatedAt: new Date() })
      .where(eq(demandPulseState.id, existing.id))
  }

  const virtualHour = localHour - delayHours
  return Math.max(0, virtualHour - startHour + 1)
}

// Calcula, para cada fecha hoy+3..hoy+21 en que competitor_undercut se
// dispara, qué precio hay que dejar en la tarifa raíz para que la tarifa de
// referencia (rule.referenceRateId), en su tipo de habitación "Doble" (la
// base de la comparación — mismo criterio que la pestaña Competidores, no la
// más barata entre todos los tipos), resuelva al objetivo — adjustValue% de
// descuento sobre el precio MÁS BARATO de los competidores activos ese día
// (ya en competitor_prices con el divisor propio de cada competidor y el
// filtro de baño privado ya aplicados, ver competitorPricing.ts) — e inserta
// una fila "semilla" en rateDailyPrices para la tarifa raíz cuando esa fecha/tipo de
// habitación aún no tuviera ninguna (para que el bucle principal la vea como
// una celda más). Devuelve un Map "fecha|roomTypeId BASE de la tarifa raíz" → precio
// objetivo; el bucle principal la aplica con la prioridad más baja (después
// de las otras 4 reglas).
// booking_surge: fechas de check-in con 2+ reservas hechas (bookedAt) dentro
// de los últimos `windowMinutes` (thresholdPct reutilizado como minutos, ver
// comentario en src/db/schema/pricing.ts). Sin memoria entre pasadas — se
// recalcula en vivo cada vez, así que se apaga sola en cuanto deja de haber
// 2+ reservas recientes en la ventana móvil (por tiempo, o porque el pico ya
// quedó fuera de ella). Horizonte: mismo que el resto, hoy..to.
async function computeBookingSurgeDates(rule: PricingRule, from: string, to: string): Promise<Set<string>> {
  const windowMinutes = rule.thresholdPct > 0 ? rule.thresholdPct : 60
  // Cuenta cualquier reserva reciente cuya ESTADÍA pase por esa noche
  // (check_in_date <= fecha < check_out_date), no solo las que entran
  // exactamente ese día — un pico de reservas de varias noches que se solapan
  // en una fecha es tan "reservas seguidas" para esa noche como entradas
  // exactas ese día.
  // Mismo gotcha de generate_series+timestamp que en computeDemandPulseDiscounts
  // (ver comentario ahí) — sin el (::date) intermedio, surgeDates.has(date)
  // nunca encontraba nada porque las claves salían con hora.
  const rows = await db.execute(sql`
SELECT (d.date::date)::text AS date, COUNT(*)::int AS n
FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) AS d(date)
JOIN reservations r
  ON r.property_id = ${getPropertyId()}
 AND r.status NOT IN ('cancelled', 'no_show')
 AND r.check_in_date <= d.date AND r.check_out_date > d.date
 AND r.booked_at >= now() - (${windowMinutes} || ' minutes')::interval
GROUP BY d.date
HAVING COUNT(*) >= 2
  `) as unknown as { date: string; n: number }[]
  return new Set(rows.map(r => r.date))
}

async function computeCompetitorUndercutTargets(
  rule: PricingRule,
  dirAlRateId: number,
  occByDate: Map<string, number>,
): Promise<Map<string, number>> {
  const targets = new Map<string, number>()
  if (!rule.referenceRateId) {
    ruleWarn(rule.id, '[pricingRules] competitor_undercut sin tarifa de referencia configurada — se ignora')
    return targets
  }

  const from = addDaysISO(todayISO(), COMPETITOR_FROM_DAYS)
  const to   = addDaysISO(todayISO(), COMPETITOR_TO_DAYS)

  const [allRates, allRoomTypes, activeCompetitors] = await Promise.all([
    db.select().from(rates).where(and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true))),
    db.select().from(roomTypes).where(and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true))),
    db.select({ id: competitorHotels.id }).from(competitorHotels).where(and(eq(competitorHotels.propertyId, getPropertyId()), eq(competitorHotels.active, true))),
  ])
  const ratesById     = new Map(allRates.map(r => [r.id, r]))
  const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
  const referenceRate = ratesById.get(rule.referenceRateId)
  if (!referenceRate) {
    ruleWarn(rule.id, `[pricingRules] competitor_undercut: tarifa de referencia ${rule.referenceRateId} no encontrada — se ignora`)
    return targets
  }
  const competitorIds = new Set(activeCompetitors.map(h => h.id))
  if (competitorIds.size === 0) return targets

  // Comparación siempre sobre "Doble" — es la base de la comparativa (mismo
  // criterio que el tipo de habitación por defecto en la pestaña
  // Competidores), no la más barata de todos los tipos: los precios de
  // competidores ya vienen filtrados a baño privado (ver competitorPricing.ts),
  // que en estos hoteles corresponde a su doble.
  // Tipo de comparación: setting pricing.competitorRoomTypeId; si falta, el tipo
  // base activo (sin baseRoomTypeId) de menor id.
  const cmpRtSetting = Number(await getSetting<number>('pricing.competitorRoomTypeId'))
  const dobleRoomType = Number.isFinite(cmpRtSetting) && cmpRtSetting > 0
    ? roomTypesById.get(cmpRtSetting)
    : [...allRoomTypes].filter(rt => rt.baseRoomTypeId == null).sort((a, b) => a.id - b.id)[0]
  if (!dobleRoomType) {
    ruleWarn(rule.id, '[pricingRules] competitor_undercut: no se encuentra el tipo de habitación de comparación (pricing.competitorRoomTypeId) — se ignora')
    return targets
  }

  const compPrices = await db.select().from(competitorPrices)
    .where(and(gte(competitorPrices.date, from), lte(competitorPrices.date, to)))
  const competitorMinByDate = new Map<string, number>()
  for (const p of compPrices) {
    if (!competitorIds.has(p.competitorId) || p.price == null) continue
    const price = parseFloat(p.price)
    if (price <= 0) continue
    const cur = competitorMinByDate.get(p.date)
    if (cur == null || price < cur) competitorMinByDate.set(p.date, price)
  }
  if (competitorMinByDate.size === 0) return targets

  // Precios de la cadena de la tarifa de referencia, usando basePrice (no
  // price ya ajustado) — mismo principio que el resto del motor: comparar
  // siempre contra el precio "de verdad" nuestro, no contra uno ya rebajado
  // por este mismo mecanismo en una pasada anterior.
  const chainIds = rateChainIds(referenceRate as any, ratesById as any)
  const chainRows = chainIds.length
    ? await db.select().from(rateDailyPrices).where(and(
        inArray(rateDailyPrices.rateId, chainIds),
        gte(rateDailyPrices.date, from), lte(rateDailyPrices.date, to),
      ))
    : []
  const baseRows = chainRows.map(r => ({ ...r, price: r.basePrice ?? r.price }))

  const pct = parseFloat(rule.adjustValue)
  const occupancy = dobleRoomType.maxOccupancy ?? 2
  for (let o = 0; o <= COMPETITOR_TO_DAYS - COMPETITOR_FROM_DAYS; o++) {
    const date = addDaysISO(from, o)
    const competitorMin = competitorMinByDate.get(date)
    const occPct = occByDate.get(date)
    if (competitorMin == null || occPct == null) continue
    const ourPrice = resolvePrice(ratesById as any, roomTypesById as any, baseRows as any, referenceRate.id, dobleRoomType.id, date, occupancy)
    if (ourPrice == null || ourPrice <= competitorMin || occPct >= rule.thresholdPct) continue

    const desired = Math.round(competitorMin * (1 - pct / 100) * 100) / 100

    const rtInv = invertRoomTypeChainToBase(roomTypesById as any, dobleRoomType as any, desired, occupancy)
    if (!rtInv) continue  // tipo de habitación derivado con ajuste 'fixed': no invertible
    const rateInv = invertRateChainToRoot(ratesById as any, referenceRate as any, rtInv.price, occupancy)
    if (!rateInv || rateInv.rootRateId !== dirAlRateId) continue  // 'fixed' en la cadena, o no llega a la tarifa raíz

    targets.set(`${date}|${rtInv.baseRoomTypeId}`, rateInv.price)
  }

  // Semilla: si para alguna fecha/tipo de habitación objetivo la tarifa raíz todavía
  // no tiene fila propia (solo la genérica), se crea una con su precio
  // natural (sin descuento) para que el bucle principal la trate como una
  // celda más — igual que cualquier fila creada por una edición manual.
  await seedMissingDirAlRows(dirAlRateId, from, to, targets, ratesById as any, roomTypesById as any)

  return targets
}

// Para cada "fecha|roomTypeId" en `targets` que la tarifa raíz todavía no tuviera
// como fila propia (solo la genérica, o ninguna), crea una con su precio
// natural (derivado, sin el ajuste de la regla que llama a esto) para que el
// bucle principal la trate como una celda más — igual que si se hubiera
// editado a mano. Compartido entre competitor_undercut y sold_out_upsell,
// las dos reglas que pueden necesitar dirigirse a un tipo de habitación que
// aún no tiene fila propia ese día.
async function seedMissingDirAlRows(
  dirAlRateId: number, from: string, to: string, targets: Map<string, number>,
  ratesById: Map<number, any>, roomTypesById: Map<number, any>,
): Promise<void> {
  if (targets.size === 0) return
  const dirAlRows = await db.select().from(rateDailyPrices)
    .where(and(eq(rateDailyPrices.rateId, dirAlRateId), gte(rateDailyPrices.date, from), lte(rateDailyPrices.date, to)))
  const dirAlBaseRows = dirAlRows.map(r => ({ ...r, price: r.basePrice ?? r.price }))
  const existing = new Set(dirAlRows.map(r => `${r.date}|${r.roomTypeId ?? 'null'}`))
  for (const key of targets.keys()) {
    const [date, roomTypeIdStr] = key.split('|')
    const roomTypeId = Number(roomTypeIdStr)
    if (existing.has(`${date}|${roomTypeId}`)) continue
    const naturalBase = resolvePrice(ratesById as any, roomTypesById as any, dirAlBaseRows as any, dirAlRateId, roomTypeId, date!, roomTypesById.get(roomTypeId)?.maxOccupancy ?? 1)
    if (naturalBase == null) continue  // sin precio base del que partir: no se puede crear la fila
    await db.insert(rateDailyPrices).values({
      propertyId: getPropertyId(), rateId: dirAlRateId, roomTypeId, date: date!,
      basePrice: naturalBase.toFixed(2), price: naturalBase.toFixed(2), closed: false,
    })
  }
}

// Calcula, para cada fecha del horizonte en que sold_out_upsell se dispara
// (sourceRoomTypeId a 0 disponibles calculadas), qué precio hay que dejar en
// la tarifa raíz para el tipo ORIGEN de modo que el tipo DESTINO (derivado de él)
// cueste el precio original del origen + adjustValue €: se baja el origen
// (agotado, no pierde ventas) a inv(destino, origen + adjustValue) usando el
// ajuste configurado del tipo derivado. Devuelve un Map "fecha|sourceRoomTypeId"
// → nuevo precio del origen, mismo formato que computeCompetitorUndercutTargets
// — el bucle principal lo aplica con su propia prioridad.
async function computeSoldOutUpsellTargets(
  rule: PricingRule,
  dirAlRateId: number,
  from: string,
  to: string,
): Promise<Map<string, number>> {
  const targets = new Map<string, number>()
  if (!rule.sourceRoomTypeId || !rule.targetRoomTypeId) {
    ruleWarn(rule.id, '[pricingRules] sold_out_upsell sin tipo de habitación origen/destino configurado — se ignora')
    return targets
  }

  const [allRoomTypes, allRates] = await Promise.all([
    db.select().from(roomTypes).where(and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true))),
    db.select().from(rates).where(and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true))),
  ])
  const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
  const ratesById     = new Map(allRates.map(r => [r.id, r]))
  const sourceRt = roomTypesById.get(rule.sourceRoomTypeId)
  const targetRt = roomTypesById.get(rule.targetRoomTypeId)
  if (!sourceRt || !targetRt) {
    ruleWarn(rule.id, '[pricingRules] sold_out_upsell: tipo de habitación origen o destino no encontrado — se ignora')
    return targets
  }
  // Lo que se toca es el precio del ORIGEN (que sí tiene fila propia editable
  // en la tarifa raíz); el destino lo sigue solo porque deriva de él. Por eso el
  // origen no puede ser derivado y el destino tiene que derivar del origen
  // (directamente o a través de otros tipos derivados).
  if (sourceRt.baseRoomTypeId) {
    ruleWarn(rule.id, `[pricingRules] sold_out_upsell: el tipo origen "${sourceRt.name}" es derivado, no tiene precio propio que bajar — se ignora`)
    return targets
  }
  const probe = invertRoomTypeChainToBase(roomTypesById as any, targetRt as any, 1, 1)
  if (!targetRt.baseRoomTypeId || !probe || probe.baseRoomTypeId !== sourceRt.id) {
    ruleWarn(rule.id, `[pricingRules] sold_out_upsell: "${targetRt.name}" no deriva de "${sourceRt.name}" (o su ajuste es fijo y no invertible) — se ignora`)
    return targets
  }

  const [totalRow] = await db.select({ n: sql<number>`count(*)::int` }).from(rooms)
    .where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.roomTypeId, sourceRt.id), eq(rooms.active, true)))
  const totalSource = totalRow?.n ?? 0
  if (totalSource === 0) return targets  // sin habitaciones de ese tipo: nada que agotar

  // Ocupadas por día del tipo origen — misma unión (reserva principal +
  // extra_room_ids + bloqueos) que usa el resto de la app (fdm.ts, catalog.ts).
  const occupiedRaw = await db.execute(sql`
    WITH dr AS (
      SELECT generate_series(${from}::date, ${to}::date, '1 day'::interval)::date AS date
    )
    SELECT date, COUNT(DISTINCT room_id)::int AS occupied
    FROM (
      SELECT d.date::text AS date, r.room_id
      FROM ${reservations} r
      JOIN ${rooms} ro ON ro.id = r.room_id
      CROSS JOIN dr d
      WHERE r.room_id IS NOT NULL
        AND r.property_id = ${getPropertyId()}
        AND r.status NOT IN ('cancelled', 'no_show')
        AND ro.room_type_id = ${sourceRt.id}
        AND r.check_in_date  <= d.date AND r.check_out_date > d.date
      UNION
      SELECT d.date::text AS date, eid::int AS room_id
      FROM ${reservations} r
      CROSS JOIN jsonb_array_elements_text(r.extra_room_ids) eid
      JOIN ${rooms} ro2 ON ro2.id = eid::int
      CROSS JOIN dr d
      WHERE r.property_id = ${getPropertyId()}
        AND r.status NOT IN ('cancelled', 'no_show')
        AND ro2.room_type_id = ${sourceRt.id}
        AND r.check_in_date  <= d.date AND r.check_out_date > d.date
      UNION
      SELECT bb.block_date::text AS date, bb.room_id
      FROM ${blockedBeds} bb
      WHERE bb.property_id = ${getPropertyId()} AND bb.room_type_id = ${sourceRt.id}
        AND bb.block_date BETWEEN ${from}::date AND ${to}::date
    ) sub
    GROUP BY date
  `) as unknown as { date: string; occupied: number }[]
  const occupiedByDate = new Map(occupiedRaw.map(r => [r.date, r.occupied]))

  // Precio de la tarifa raíz para el tipo origen, usando basePrice (no price ya
  // ajustado) — mismo principio que el resto del motor: partir siempre del
  // precio "de verdad", no de uno ya rebajado por esta misma regla antes.
  const dirAlRows = await db.select().from(rateDailyPrices)
    .where(and(eq(rateDailyPrices.rateId, dirAlRateId), gte(rateDailyPrices.date, from), lte(rateDailyPrices.date, to)))
  const dirAlBaseRows = dirAlRows.map(r => ({ ...r, price: r.basePrice ?? r.price }))

  const addOn = parseFloat(rule.adjustValue)
  const dates: string[] = []
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10))
  }
  for (const date of dates) {
    const occupied  = occupiedByDate.get(date) ?? 0
    const available = totalSource - occupied
    if (available > 0) continue  // el tipo origen aún tiene disponibilidad: no se dispara

    const sourcePrice = resolvePrice(ratesById as any, roomTypesById as any, dirAlBaseRows as any, dirAlRateId, sourceRt.id, date, sourceRt.maxOccupancy ?? 1)
    if (sourcePrice == null) continue  // sin precio base del que partir ese día

    // Queremos que el destino cueste precio original del origen + addOn. Como
    // el destino deriva del origen, se consigue BAJANDO el precio del origen
    // (que está agotado, así que no pierde ventas) al valor que, tras aplicar
    // el ajuste configurado del destino, dé justo ese precio.
    const desiredTarget = sourcePrice + addOn
    const inv = invertRoomTypeChainToBase(roomTypesById as any, targetRt as any, desiredTarget, targetRt.maxOccupancy ?? 1)
    if (!inv || inv.baseRoomTypeId !== sourceRt.id) continue
    if (inv.price >= sourcePrice) continue  // solo baja: si el importe deja el destino por encima de su precio normal, no hay nada que rebajar
    targets.set(`${date}|${sourceRt.id}`, inv.price)
  }

  await seedMissingDirAlRows(dirAlRateId, from, to, targets, ratesById as any, roomTypesById as any)
  return targets
}

export async function applyPricingRules(): Promise<void> {
  const st = tstate()
  if (st.passRunning) { console.error('[pricingRules] pasada anterior aún en curso — se omite esta'); return }
  st.passRunning = true
  st.passWarnings = []
  tzByProperty.set(getPropertyId(), (await getProperty()).timezone)
  const passDiag = new Map<string, DateDiag>()
  const pass: PassStatus = {
    startedAt: new Date().toISOString(), finishedAt: null, running: true, outcome: 'en_curso',
    applied: 0, cellsProcessed: 0, horizonFrom: null, horizonTo: null, warnings: [],
  }
  st.lastPass = pass
  try {
    const activeRules = await db.select().from(pricingRules)
      .where(and(eq(pricingRules.propertyId, getPropertyId()), eq(pricingRules.active, true)))
    if (activeRules.length === 0) { pass.outcome = 'sin_reglas_activas'; return }

    const lowAvailRule   = activeRules.find(r => r.ruleType === 'low_availability')
    const leadTimeRule   = activeRules.find(r => r.ruleType === 'lead_time_dip')
    const localMinRule   = activeRules.find(r => r.ruleType === 'local_min_dip')
    const pulseRule      = activeRules.find(r => r.ruleType === 'demand_pulse_dip')
    const competitorRule = activeRules.find(r => r.ruleType === 'competitor_undercut')
    const upsellRule     = activeRules.find(r => r.ruleType === 'sold_out_upsell')
    const eveningRule    = activeRules.find(r => r.ruleType === 'evening_clearance_dip')
    const surgeRule      = activeRules.find(r => r.ruleType === 'booking_surge')
    if (!lowAvailRule && !leadTimeRule && !localMinRule && !pulseRule && !competitorRule && !upsellRule && !eveningRule && !surgeRule) { pass.outcome = 'sin_reglas_activas'; return }

    const rateId = await getDirALRateId()
    if (!rateId) { ruleWarn(null, '[pricingRules] tarifa raíz no encontrada (pricing.rootRateId) — nada que ajustar'); pass.outcome = 'sin_dir_al'; return }

    const from = todayISO()
    // local_min_dip mira hasta hoy+60 — si está activa, el horizonte de
    // precios (y de datos de ocupación) se amplía para cubrirla.
    const priceHorizonDays = localMinRule ? Math.max(HORIZON_DAYS, LOCAL_MIN_TO_DAYS) : HORIZON_DAYS
    const to = addDaysISO(from, priceHorizonDays)
    pass.horizonFrom = from; pass.horizonTo = to
    // +1 día extra de ocupación al final, solo para poder juzgar si el
    // último día de la ventana de local_min_dip es de verdad un valle.
    const occTo = localMinRule ? addDaysISO(from, LOCAL_MIN_TO_DAYS + 1) : to

    // Ocupación día a día del horizonte — mismo cálculo que la fila resumen
    // del calendario de Precios (habitaciones físicas + extras + bloqueos +
    // overrides manuales), NO el de Informes → Ocupación (que cuenta reservas,
    // no habitaciones, y no ve bloqueos ni overrides) — así "ocupación" para
    // las reglas significa lo mismo que ve el usuario en esa fila.
    const occByDate = await computeCalendarOccupancyPct(from, occTo)

    let leadTargetDate: string | null = null
    if (leadTimeRule) {
      const avgLead = await avgBookingComLeadDays()
      if (avgLead != null) leadTargetDate = addDaysISO(from, Math.round(avgLead))
    }

    const localMinDates = localMinRule
      ? findLocalMinimaDates(occByDate, from, LOCAL_MIN_FROM_DAYS, LOCAL_MIN_TO_DAYS, localMinRule.thresholdPct)
      : new Set<string>()

    // Suelo de precio de demand_pulse_dip: % (minAdrFloorPct) del ADR real de
    // LA SEMANA de cada fecha — mismo dato que colorea el calendario de
    // precios. Solo hace falta pedirlo si la regla está activa.
    const pulseAdrByDate = pulseRule
      ? await weeklyAdrByDate(from, addDaysISO(from, PULSE_WINDOW_TO_DAYS))
      : {}

    // evening_clearance_dip: hora y fecha de HOY en la zona horaria del hotel (no la del
    // servidor, que puede ir en otro huso) — y el ADR real de LA SEMANA de
    // hoy, mismo dato/cálculo que el suelo de demand_pulse_dip.
    const localNow   = new Date()
    const localHour  = parseInt(new Intl.DateTimeFormat('es-ES', { timeZone: tz(), hour: 'numeric', hour12: false }).format(localNow), 10)
    const localToday = new Intl.DateTimeFormat('en-CA', { timeZone: tz() }).format(localNow)
    // weeklyAdrByDate solo cuenta las noches dentro de [from, to] que le pasas
    // (no toda la semana ISO) — se pide lunes..domingo de la semana de hoy para
    // que sea de verdad el ADR SEMANAL, no el de hoy solo.
    const localDow    = new Date(`${localToday}T12:00:00Z`).getUTCDay() || 7
    const weekMonday   = addDaysISO(localToday, -(localDow - 1))
    const weekSunday   = addDaysISO(weekMonday, 6)
    const eveningAdrByDate = eveningRule
      ? await weeklyAdrByDate(weekMonday, weekSunday)
      : {}
    const eveningSteps = eveningRule && localHour >= (eveningRule.clearanceStartHour ?? EVENING_START_HOUR_DEFAULT)
      ? await computeEveningClearanceSteps(eveningRule, localToday, localHour)
      : 0

    // Ese mismo suelo, convertido a un % de descuento equivalente sobre el
    // basePrice de la fila RAÍZ (roomTypeId IS NULL) de cada fecha — sirve
    // para capar el % ACUMULADO en demand_pulse_state a lo que el suelo
    // necesita. Sin este cap, el % podía seguir subiendo por horas de
    // silencio aunque el precio final ya estuviera clavado en el suelo, y la
    // recuperación (2 reservas → medio escalón) tardaba varios pasos "de
    // más" en notarse en el precio visible. Con el cap, en cuanto el precio
    // toca el suelo el % acumulado también se queda ahí, así que las 2
    // primeras reservas nuevas ya suben el precio de verdad, sin retraso.
    const pulseFloorPctByDate = new Map<string, number>()
    if (pulseRule) {
      const pulseTo = addDaysISO(from, PULSE_WINDOW_TO_DAYS)
      const rootRows = await db.select({ date: rateDailyPrices.date, basePrice: rateDailyPrices.basePrice })
        .from(rateDailyPrices)
        .where(and(
          eq(rateDailyPrices.rateId, rateId), isNull(rateDailyPrices.roomTypeId),
          gte(rateDailyPrices.date, from), lte(rateDailyPrices.date, pulseTo),
        ))
      for (const r of rootRows) {
        if (r.basePrice == null) continue
        const rootBase = parseFloat(r.basePrice)
        if (rootBase <= 0) continue
        const weekAdr = pulseAdrByDate[r.date]
        const floor = weekAdr != null
          ? weekAdr * (pulseRule.minAdrFloorPct / 100)
          : rootBase * (1 - PULSE_FALLBACK_MAX_DISCOUNT_PCT / 100)
        pulseFloorPctByDate.set(r.date, Math.max(0, (1 - floor / rootBase) * 100))
      }
    }

    // booking_surge se calcula ANTES que demand_pulse_dip: un repunte de
    // reservas en vivo ahora mismo es una señal más fuerte que un descuento
    // acumulado por un silencio de hace días, así que demand_pulse_dip lo usa
    // como otra "recuperación inmediata" (igual que cuando la ocupación ya
    // supera el umbral) — ver dentro de computeDemandPulseDiscounts.
    const surgeDates = surgeRule
      ? await computeBookingSurgeDates(surgeRule, from, to)
      : new Set<string>()

    const pulseDiscountByDate = pulseRule
      ? await computeDemandPulseDiscounts(pulseRule, from, occByDate, pulseFloorPctByDate, surgeDates)
      : new Map<string, number>()

    // competitor_undercut: se calcula (y, si hace falta, siembra filas nuevas
    // en la tarifa raíz) ANTES de leer `cells` más abajo, para que el bucle principal
    // ya las vea como una celda más y decida su prioridad frente al resto de
    // reglas igual que con cualquier otra.
    const competitorTargets = competitorRule
      ? await computeCompetitorUndercutTargets(competitorRule, rateId, occByDate)
      : new Map<string, number>()

    // sold_out_upsell: mismo principio — se calcula (y siembra si hace
    // falta) antes de leer `cells`, dentro del horizonte normal de 30 días
    // (no el ampliado a 60 de local_min_dip: no tiene sentido bajar el
    // precio de una habitación superior por algo que pasará dentro de 2 meses).
    const upsellTargets = upsellRule
      ? await computeSoldOutUpsellTargets(upsellRule, rateId, from, addDaysISO(from, HORIZON_DAYS))
      : new Map<string, number>()

    // Tipos de habitación derivados (roomTypes.baseRoomTypeId no nulo): su
    // precio real se calcula siempre a partir del tipo base vía
    // resolvePrice(), así que cualquier fila propia que tengan en
    // rate_daily_prices es inerte — el motor no debe tocarlas (ver comentario
    // de cabecera).
    const derivedRoomTypeIds = new Set(
      (await db.select({ id: roomTypes.id }).from(roomTypes).where(and(eq(roomTypes.propertyId, getPropertyId()), isNotNull(roomTypes.baseRoomTypeId))))
        .map(r => r.id)
    )

    const cells = await db.select().from(rateDailyPrices)
      .where(and(eq(rateDailyPrices.rateId, rateId), gte(rateDailyPrices.date, from), lte(rateDailyPrices.date, to)))

    // Un batchId por pasada del motor — agrupa en el historial (price_change_log)
    // todo lo que toque esta ejecución, dispare regla o revierta en silencio.
    const batchId = crypto.randomUUID()
    let applied = 0

    // Ganadora por fecha: entre las reglas activas cuya condición se cumple
    // ESA fecha, la de menor `priority` (empate → la más antigua, por id).
    const upsellDates     = new Set([...upsellTargets.keys()].map(k => k.split('|')[0]!))
    const competitorDates = new Set([...competitorTargets.keys()].map(k => k.split('|')[0]!))
    const rulesInUse = [pulseRule, eveningRule, surgeRule, upsellRule, leadTimeRule, localMinRule, lowAvailRule, competitorRule]
      .filter((r): r is PricingRule => !!r)
      .sort((a, b) => a.priority - b.priority || a.id - b.id)
    const winnerByDate = new Map<string, PricingRule | null>()
    const winnerFor = (date: string, occPct: number): PricingRule | null => {
      if (winnerByDate.has(date)) return winnerByDate.get(date)!
      const availPct = 100 - occPct
      const check = (r: PricingRule): { ok: boolean; why: string } => {
        switch (r.ruleType) {
          case 'demand_pulse_dip': {
            const d = pulseDiscountByDate.get(date) ?? 0
            if (d > 0) return { ok: true, why: `descuento acumulado del ${d}%` }
            // Antes esto era una sola frase con las 3 causas juntas
            // ("fuera de ventana, sin estado, o umbral") — ambiguo tanto
            // para un humano como para el agente de IA al resumirlo (podía
            // elegir la causa equivocada). Se distingue aquí cuál de las 3
            // es la real.
            const outOfWindow = date < from || date > addDaysISO(from, PULSE_WINDOW_TO_DAYS)
            if (outOfWindow) return { ok: false, why: `fuera de la ventana de análisis (solo actúa hoy..hoy+${PULSE_WINDOW_TO_DAYS})` }
            if (occPct >= r.thresholdPct) return { ok: false, why: `la ocupación ${occPct}% ya está por encima del umbral ${r.thresholdPct}% — no hay "parada" que detectar` }
            return { ok: false, why: 'dentro de ventana y por debajo del umbral, pero todavía sin estado guardado para esta fecha (se crea la foto de partida en la próxima pasada, sin disparar nada la primera vez)' }
          }
          case 'evening_clearance_dip': {
            const startHour = r.clearanceStartHour ?? EVENING_START_HOUR_DEFAULT
            if (date !== localToday) return { ok: false, why: 'solo actúa sobre la fecha de HOY' }
            if (localHour < startHour) return { ok: false, why: `todavía no son las ${startHour}:00 (son las ${localHour}h)` }
            if (eveningSteps <= 0) return { ok: false, why: 'los escalones de hoy están retrasados por reservas nuevas (0 escalones por ahora)' }
            if (occPct >= r.thresholdPct) return { ok: false, why: `la ocupación ${occPct}% ya alcanza el tope ${r.thresholdPct}%` }
            if (eveningAdrByDate[date] == null) return { ok: false, why: 'esta semana no tiene ADR real todavía (sin noches ocupadas) — no hay con qué comparar' }
            return { ok: true, why: `${eveningSteps} escalón(es) de -${r.adjustValue}%` }
          }
          case 'sold_out_upsell':
            return upsellDates.has(date) ? { ok: true, why: 'el tipo origen está agotado' }
              : { ok: false, why: 'el tipo origen aún tiene disponibilidad ese día (o la regla está mal configurada: mira los avisos)' }
          case 'lead_time_dip':
            if (!leadTargetDate) return { ok: false, why: 'sin lead time medio de Booking.com calculable' }
            if (date !== leadTargetDate) return { ok: false, why: `solo actúa el día ${leadTargetDate} (hoy + lead time medio), no este` }
            return occPct < r.thresholdPct ? { ok: true, why: `es el día objetivo y la ocupación ${occPct}% < ${r.thresholdPct}%` }
              : { ok: false, why: `es el día objetivo pero la ocupación ${occPct}% >= umbral ${r.thresholdPct}%` }
          case 'local_min_dip':
            return localMinDates.has(date) ? { ok: true, why: 'es un mínimo local de ocupación' }
              : { ok: false, why: `no es un mínimo local de ocupación < ${r.thresholdPct}% (ventana hoy+3..hoy+60)` }
          case 'low_availability':
            return availPct < r.thresholdPct ? { ok: true, why: `disponibilidad ${availPct}% < umbral ${r.thresholdPct}%` }
              : { ok: false, why: `disponibilidad ${availPct}% >= umbral ${r.thresholdPct}%` }
          case 'competitor_undercut':
            return competitorDates.has(date) ? { ok: true, why: 'somos más caros que el competidor más barato y la ocupación está por debajo del umbral' }
              : { ok: false, why: 'no se dispara: no somos más caros que el competidor, no hay precios de competidores, está fuera de hoy+3..hoy+21, la ocupación >= umbral, o la regla está mal configurada (mira los avisos)' }
          case 'booking_surge':
            return surgeDates.has(date) ? { ok: true, why: `2 o más reservas cuya estadía pasa por esta noche, hechas en los últimos ${r.thresholdPct || 60} min` }
              : { ok: false, why: `menos de 2 reservas cuya estadía pasa por esta noche en los últimos ${r.thresholdPct || 60} min` }
          default: return { ok: false, why: 'tipo de regla desconocido' }
        }
      }
      const checks = rulesInUse.map(r => ({ r, c: check(r) }))
      const w = checks.find(x => x.c.ok)?.r ?? null
      winnerByDate.set(date, w)
      passDiag.set(date, {
        date, occupancyPct: occPct, winnerRuleId: w?.id ?? null,
        rules: checks.map(x => ({ ruleId: x.r.id, ruleType: x.r.ruleType, name: x.r.name, priority: x.r.priority, fires: x.c.ok, why: x.c.why })),
        cells: 0, cellsChanged: 0, cellsSuppressedByManualOverride: 0, notes: [],
      })
      return w
    }

    for (const cell of cells) {
      if (cell.basePrice == null) continue  // sin base configurada: no hay de dónde partir, se ignora
      if (cell.roomTypeId != null && derivedRoomTypeIds.has(cell.roomTypeId)) continue
      const base    = parseFloat(cell.basePrice)
      const oldPrice = parseFloat(cell.price)
      const occPct  = occByDate.get(cell.date)
      if (occPct == null) continue

      let firingRule: PricingRule | undefined
      let targetPrice = base  // por defecto, revierte a la base si ninguna regla aplica

      // Una sola regla por FECHA (la de mayor prioridad — número menor — entre
      // las que se disparan ese día, ver pricing_rules.priority): esa misma
      // regla decide el precio de TODAS las celdas de la fecha; las demás
      // reglas quedan en suspenso esa fecha aunque también se cumplieran.
      const winner = winnerFor(cell.date, occPct)
      const dd = passDiag.get(cell.date)
      if (dd) dd.cells++
      pass.cellsProcessed++
      if (winner) {
        switch (winner.ruleType) {
          case 'demand_pulse_dip': {
            const pulseDiscount = pulseDiscountByDate.get(cell.date) ?? 0
            firingRule  = winner
            targetPrice = applyAdjust(base, 'percentage', pulseDiscount, -1)
            // Suelo de precio: nunca por debajo de minAdrFloorPct% del ADR real
            // de la semana de esta fecha. Sin ADR real todavía (semana sin
            // ninguna noche ocupada), cae al tope fijo de seguridad del 30%.
            const weekAdr = pulseAdrByDate[cell.date]
            const floor   = weekAdr != null
              ? weekAdr * (winner.minAdrFloorPct / 100)
              : base * (1 - PULSE_FALLBACK_MAX_DISCOUNT_PCT / 100)
            targetPrice = Math.max(targetPrice, Math.round(floor * 100) / 100)
            break
          }
          case 'evening_clearance_dip': {
            const weekAdr = eveningAdrByDate[cell.date]
            if (weekAdr != null && base > weekAdr) {  // el precio de ESTA celda tiene que superar el ADR
              firingRule = winner
              const rawTarget = applyAdjust(base, 'percentage', eveningSteps * parseFloat(winner.adjustValue), -1)
              targetPrice = Math.max(rawTarget, Math.round(weekAdr * (winner.minAdrFloorPct / 100) * 100) / 100)
            }
            break
          }
          case 'sold_out_upsell': {
            const t = upsellTargets.get(`${cell.date}|${cell.roomTypeId}`)
            if (t != null) { firingRule = winner; targetPrice = t }
            break
          }
          case 'lead_time_dip':
            firingRule  = winner
            targetPrice = applyAdjust(base, winner.adjustType, parseFloat(winner.adjustValue), -1)
            break
          case 'local_min_dip':
            firingRule  = winner
            targetPrice = applyAdjust(base, winner.adjustType, parseFloat(winner.adjustValue), -1)
            break
          case 'low_availability':
            firingRule  = winner
            targetPrice = applyAdjust(base, winner.adjustType, parseFloat(winner.adjustValue), 1)
            break
          case 'competitor_undercut': {
            const t = competitorTargets.get(`${cell.date}|${cell.roomTypeId}`)
            if (t != null) {
              firingRule = winner
              // t se calcula siempre desde basePrice (estable entre pasadas,
              // para no depender del propio resultado de esta regla — ver
              // computeCompetitorUndercutTargets). Si otra regla con más
              // prioridad (p.ej. Parada de reservas) tenía esta fecha con un
              // descuento más profundo que el de aquí, t podría salir por
              // ENCIMA del precio vivo actual — nunca se aplica eso: esta
              // regla es "BAJA el precio", nunca lo sube. Se queda como
              // estaba hasta que esa otra regla libere la fecha de verdad
              // (su propio descuento llegue a 0), momento en que t sí quedará
              // por debajo del precio (que para entonces habrá vuelto a base).
              targetPrice = Math.min(t, oldPrice)
            }
            break
          }
          case 'booking_surge':
            firingRule  = winner
            targetPrice = applyAdjust(base, winner.adjustType, parseFloat(winner.adjustValue), 1)
            break
        }
      }

      // Bloqueo por override manual: si el precio se editó a mano MIENTRAS
      // esta regla ya se estaba disparando, se respeta y no se vuelve a
      // aplicar aunque la condición se siga cumpliendo — hasta que la
      // condición se resuelva del todo (episodio nuevo). "Parada de
      // reservas", "Reservas seguidas" y "Liquidación nocturna" son la
      // excepción: cada una solo respeta el override MIENTRAS sea más
      // reciente que su propia ventana (pulseSilenceMinutes / thresholdPct /
      // clearanceOverrideMinutes — las tres configurables en RatesView) —
      // pasada esa ventana sin actividad nueva, el override se da por
      // caducado y la regla vuelve a mandar sobre esa celda como si no lo
      // hubiera. El resto de reglas lo respetan siempre, sin límite de tiempo.
      const conditionFired = !!firingRule
      if (firingRule && cell.manualOverrideAt != null) {
        const overrideAgeMs = Date.now() - cell.manualOverrideAt.getTime()
        const overrideStillFresh =
          firingRule === pulseRule
            ? overrideAgeMs < (pulseRule!.pulseSilenceMinutes ?? PULSE_SILENCE_MINUTES_DEFAULT) * 60_000
          : firingRule === surgeRule
            ? overrideAgeMs < (surgeRule!.thresholdPct || 60) * 60_000
          : firingRule === eveningRule
            ? overrideAgeMs < (eveningRule!.clearanceOverrideMinutes ?? EVENING_OVERRIDE_MINUTES_DEFAULT) * 60_000
          : true
        if (overrideStillFresh) {
          firingRule  = undefined
          targetPrice = base
        }
      }

      if (dd && conditionFired && !firingRule) dd.cellsSuppressedByManualOverride++
      const priceChanged = Math.abs(targetPrice - oldPrice) >= 0.005
      if (dd && priceChanged) dd.cellsChanged++
      // Ninguna regla se dispara ya (ni siquiera la suprimida arriba) → el
      // episodio que causó el override ha terminado del todo, se limpia la
      // marca para que el próximo disparo actúe con normalidad.
      const clearOverrideMark = !conditionFired && cell.manualOverrideAt != null
      if (!priceChanged && !clearOverrideMark) continue  // nada que hacer

      await db.update(rateDailyPrices)
        .set({
          price: targetPrice.toFixed(2), updatedAt: new Date(),
          ...(clearOverrideMark ? { manualOverrideAt: null } : {}),
        })
        .where(eq(rateDailyPrices.id, cell.id))

      if (!priceChanged) continue  // solo se limpiaba la marca — sin cambio de precio que registrar

      // Historial completo (price_change_log): TODO cambio real de precio,
      // dispare regla o sea un reverso silencioso a la base — para que la
      // pestaña Historial no oculte nada. La alerta morada, en cambio, solo
      // se entera cuando una regla realmente se dispara (firingRule abajo).
      await db.insert(priceChangeLog).values({
        propertyId: getPropertyId(), rateId, roomTypeId: cell.roomTypeId, date: cell.date,
        oldPrice: oldPrice.toFixed(2), newPrice: targetPrice.toFixed(2), closed: cell.closed,
        source: 'auto', changedByUserId: null, ruleId: firingRule?.id ?? null,
        batchId,
      })

      // pricing_rule_applications (alerta): solo se registra cuando una
      // regla realmente se dispara — los reversos a la base son silenciosos.
      if (firingRule) {
        await db.insert(pricingRuleApplications).values({
          ruleId:     firingRule.id,
          date:       cell.date,
          roomTypeId: cell.roomTypeId,
          oldPrice:   oldPrice.toFixed(2),
          newPrice:   targetPrice.toFixed(2),
          batchId,
        })
        applied++
      }
    }

    pass.applied = applied
    pass.outcome = 'ok'
    if (applied > 0) console.log(`[pricingRules] ${applied} precio(s) ajustado(s) por regla automática`)

    // Empuje automático a Jumbo (precio y disponibilidad) — se pasa TODO el
    // horizonte de precios (from..to, ya calculado arriba), no una lista de
    // fechas "cambiadas": syncJumboPrices ya compara por valor contra el
    // último precio/disponibilidad empujado (jumbo_push_state) y descarta
    // solo él las que de verdad coinciden, así que pasar el horizonte entero
    // no reenvía nada sin cambios — y es la única forma de detectar también
    // cambios de disponibilidad, que no dependen de que el motor de precios
    // haya tocado nada (una reserva/cancelación/bloqueo puede cambiarla sin
    // que ninguna regla de precio se dispare). Nunca debe tumbar la pasada de
    // precios locales si Jumbo falla/está caído.
    try {
      const datesInHorizon: string[] = []
      for (let d = from; d <= to; d = addDaysISO(d, 1)) datesInHorizon.push(d)
      const jr = await syncJumboPrices(datesInHorizon)
      if (!jr.skipped) {
        console.log(`[pricingRules] Jumbo: ${jr.verified}/${jr.pushed} verificado(s) de ${datesInHorizon.length} fecha(s) en el horizonte`)
        if (jr.errorList.length > 0) console.error('[pricingRules] Jumbo errores:', jr.errorList)
      }
    } catch (e) {
      console.error('[pricingRules] error empujando a Jumbo:', e)
    }
  } catch (e) {
    console.error('[pricingRules] error aplicando reglas', e)
    pass.outcome = 'error'
    pass.error = e instanceof Error ? e.message : String(e)
  } finally {
    pass.running = false
    pass.finishedAt = new Date().toISOString()
    pass.warnings = st.passWarnings
    if (pass.outcome !== 'error') st.lastDiag = passDiag
    st.passRunning = false
  }
}

export function startPricingRulesScheduler() {
  schedulerStartedAt = new Date()
  const sweep = () => forEachActiveProperty('pricingRules', applyPricingRules, { feature: 'pricingRules' })
    .catch(e => console.error('[pricingRules] error en sweep:', e))
  sweep()
  setInterval(sweep, SWEEP_INTERVAL_MS)
  console.log('[pricingRules] scheduler iniciado — cada 30 minutos')
}
