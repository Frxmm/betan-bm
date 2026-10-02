// ─── Informe de ocupación — lógica compartida ──────────────────────────────────
// Extraído de src/routes/reports.ts (GET /occupancy) para que el agente de IA
// (src/routes/ai.ts, tool get_occupancy_report) devuelva EXACTAMENTE los mismos
// números que ve el usuario en Informes → Ocupación, en vez de reimplementar el
// cálculo por su cuenta y arriesgarse a que las dos versiones diverjan (el mismo
// motivo por el que existe price-resolver.ts).

import { db } from '../db'
import { reservations, rooms, rates, rateDailyPrices, bookingChannels } from '../db/schema'
import { eq, and, lte, gte, or, ilike } from 'drizzle-orm'
import { getPropertyId } from './property'

export type OccupancyGroup = 'day' | 'week' | 'month' | 'year'

export function isoWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7))
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}

export function periodKey(date: string, group: string): string {
  if (group === 'year')  return date.slice(0, 4)
  if (group === 'month') return date.slice(0, 7)
  if (group === 'week')  return isoWeek(date)
  return date
}

export function periodLabel(key: string, group: string): string {
  if (group === 'year') return key
  if (group === 'month') {
    const [y, m] = key.split('-')
    return new Date(`${y}-${m}-01T12:00:00`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })
  }
  if (group === 'week') {
    const [year, week] = key.split('-W')
    const jan4 = new Date(`${year}-01-04T12:00:00`)
    const dayOfWeek = jan4.getDay() || 7
    const monday = new Date(jan4)
    monday.setDate(jan4.getDate() - dayOfWeek + 1 + (Number(week) - 1) * 7)
    return monday.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
  }
  return new Date(key + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
}

export type OccupancyPeriodRow = {
  period: string; label: string; daysInPeriod: number
  roomNightsAvailable: number; roomNightsOccupied: number
  occupancyPct: number
  revenue: number; adr: number; revpar: number
  arrivals: number
  avgPrice: number | null
}

export type OccupancyReportResult = {
  data: OccupancyPeriodRow[]
  totals: {
    roomNightsAvailable: number; roomNightsOccupied: number
    occupancyPct: number
    revenue: number; adr: number; revpar: number
    arrivals: number
    avgLeadDays: number | null
  }
  meta: { totalRooms: number; dateFrom: string; dateTo: string; group: OccupancyGroup; includeCancelled: boolean }
}

// Lead time medio (días, redondeado a 1 decimal) de las reservas cuya fecha
// de RESERVA (bookedAt) cae dentro de [from, to] — OJO: no son las reservas
// cuya estancia cae en ese rango (eso es lo que filtra el resto de este
// informe), sino las que SE HICIERON en ese rango, igual que Informes →
// Lead time (reports.ts) y no como get_booking_patterns (ai.ts), que filtra
// por fecha de check-in y por eso da un número distinto para el mismo rango.
// channelNameLike filtra por canal (ILIKE, ej. 'booking'); sin él cuenta todos.
export async function avgLeadTimeDays(opts: { from: string; to: string; channelNameLike?: string }): Promise<number | null> {
  const { from, to, channelNameLike } = opts
  const baseConds = [
    eq(reservations.propertyId, getPropertyId()),
    gte(reservations.bookedAt, new Date(from + 'T00:00:00Z')),
    lte(reservations.bookedAt, new Date(to   + 'T23:59:59Z')),
    or(
      eq(reservations.status, 'confirmed'),
      eq(reservations.status, 'checked_in'),
      eq(reservations.status, 'checked_out'),
    )!,
  ]

  const rows = channelNameLike
    ? await db.select({ checkInDate: reservations.checkInDate, bookedAt: reservations.bookedAt })
        .from(reservations)
        .innerJoin(bookingChannels, eq(bookingChannels.id, reservations.bookingChannelId))
        .where(and(...baseConds, ilike(bookingChannels.name, `%${channelNameLike}%`)))
    : await db.select({ checkInDate: reservations.checkInDate, bookedAt: reservations.bookedAt })
        .from(reservations)
        .where(and(...baseConds))

  let sum = 0, n = 0
  for (const r of rows) {
    if (!r.bookedAt) continue
    const lead = Math.round((new Date(r.checkInDate + 'T12:00:00Z').getTime() - r.bookedAt.getTime()) / 86_400_000)
    if (lead < 0) continue
    sum += lead; n++
  }
  return n > 0 ? Math.round(sum / n * 10) / 10 : null
}

export async function computeOccupancyReport(opts: {
  from: string; to: string; group?: OccupancyGroup; rateId?: number
  // Si true, las reservas canceladas se cuentan igual que confirmed/checked_in/
  // checked_out — útil para ver la ocupación/ingresos "brutos" que hubiera
  // habido sin las cancelaciones (demanda vs. ocupación real). Por defecto las
  // canceladas quedan fuera, como siempre.
  includeCancelled?: boolean
}): Promise<OccupancyReportResult> {
  const { from, to, rateId, includeCancelled } = opts
  const group = opts.group ?? 'day'

  const roomsList = await db.select({ id: rooms.id })
    .from(rooms)
    .where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)))
  const totalRooms = roomsList.length

  // arriving ("Por llegar", día de check-in aún sin marcar) y checking_out
  // ("Saliendo", día de check-out aún sin marcar) también son reservas
  // vigentes y ocupan habitación — antes quedaban fuera y el día de hoy salía
  // por debajo de la realidad.
  const activeStatuses = ['confirmed', 'arriving', 'checked_in', 'checking_out', 'checked_out'] as const
  const statusFilter = includeCancelled
    ? or(...activeStatuses.map(st => eq(reservations.status, st)), eq(reservations.status, 'cancelled'))!
    : or(...activeStatuses.map(st => eq(reservations.status, st)))!

  const resList = await db.select({
    id:           reservations.id,
    checkInDate:  reservations.checkInDate,
    checkOutDate: reservations.checkOutDate,
    total:        reservations.total,
    nights:       reservations.nights,
    extraRoomIds: reservations.extraRoomIds,
  }).from(reservations).where(and(
    eq(reservations.propertyId, getPropertyId()),
    lte(reservations.checkInDate, to),
    gte(reservations.checkOutDate, from),
    statusFilter,
  ))

  const allDays: string[] = []
  const cur = new Date(from + 'T12:00:00')
  const endDate = new Date(to + 'T12:00:00')
  while (cur <= endDate) {
    allDays.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }

  type DayData = { occupied: number; revenue: number }
  const dailyMap: Record<string, DayData> = {}
  for (const d of allDays) dailyMap[d] = { occupied: 0, revenue: 0 }

  for (const res of resList) {
    const nights   = Math.max(1, res.nights ?? 1)
    const dailyRev = parseFloat(res.total ?? '0') / nights
    // Habitaciones físicas ocupadas por esta reserva: la principal + las
    // extra (extra_room_ids) — igual que cuenta el resumen del calendario de
    // Precios (buildSummaryRow) y el resto de la app (fdm.ts, housekeeping.ts,
    // catalog.ts). Antes contaba +1 por reserva sin importar cuántas
    // habitaciones ocupara de verdad.
    const roomCount = 1 + ((res.extraRoomIds as number[] | null)?.length ?? 0)
    const d = new Date(res.checkInDate + 'T12:00:00')
    const e = new Date(res.checkOutDate + 'T12:00:00')
    while (d < e) {
      const ds = d.toISOString().slice(0, 10)
      if (dailyMap[ds]) { dailyMap[ds]!.occupied += roomCount; dailyMap[ds]!.revenue += dailyRev }
      d.setDate(d.getDate() + 1)
    }
  }

  const priceMap: Record<string, number> = {}
  // La tarifa debe ser del tenant (evita leer precios de otro hotel por id)
  const rateOk = rateId
    ? (await db.select({ id: rates.id }).from(rates).where(and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId()))).limit(1)).length > 0
    : false
  if (rateId && rateOk) {
    const prices = await db.select({ date: rateDailyPrices.date, price: rateDailyPrices.price })
      .from(rateDailyPrices)
      .where(and(
        eq(rateDailyPrices.rateId, rateId),
        gte(rateDailyPrices.date, from),
        lte(rateDailyPrices.date, to),
      ))
    for (const p of prices) priceMap[p.date] = parseFloat(p.price)
  }

  const periodResIds: Record<string, Set<number>> = {}
  for (const res of resList) {
    if (res.checkInDate >= from && res.checkInDate <= to) {
      const key = periodKey(res.checkInDate, group)
      if (!periodResIds[key]) periodResIds[key] = new Set()
      periodResIds[key]!.add(res.id)
    }
  }

  type PeriodAgg = {
    period: string; days: number
    occupied: number; revenue: number
    priceSum: number; priceCount: number
  }
  const grouped: Record<string, PeriodAgg> = {}

  for (const day of allDays) {
    const key = periodKey(day, group)
    if (!grouped[key]) grouped[key] = { period: key, days: 0, occupied: 0, revenue: 0, priceSum: 0, priceCount: 0 }
    const g = grouped[key]!
    const dd = dailyMap[day]!
    g.days++
    g.occupied += dd.occupied
    g.revenue  += dd.revenue
    if (priceMap[day] !== undefined) { g.priceSum += priceMap[day]!; g.priceCount++ }
  }

  const data: OccupancyPeriodRow[] = Object.values(grouped).map(g => {
    const available    = totalRooms * g.days
    const occupancyPct = available > 0 ? Math.round(g.occupied / available * 100 * 10) / 10 : 0
    const adr          = g.occupied > 0 ? g.revenue / g.occupied : 0
    const revpar       = available > 0  ? g.revenue / available  : 0
    const arrivals     = periodResIds[g.period]?.size ?? 0
    return {
      period:              g.period,
      label:               periodLabel(g.period, group),
      daysInPeriod:        g.days,
      roomNightsAvailable: available,
      roomNightsOccupied:  g.occupied,
      occupancyPct,
      revenue:  Math.round(g.revenue * 100) / 100,
      adr:      Math.round(adr * 100) / 100,
      revpar:   Math.round(revpar * 100) / 100,
      arrivals,
      avgPrice: g.priceCount > 0 ? Math.round(g.priceSum / g.priceCount * 100) / 100 : null,
    }
  }).sort((a, b) => a.period.localeCompare(b.period))

  // Totales agregados de todo el rango — para no obligar a sumar N filas cuando
  // solo hace falta el número global (ej. "ocupación de todo 2025").
  const totalAvailable = totalRooms * allDays.length
  const totalOccupied  = data.reduce((s, d) => s + d.roomNightsOccupied, 0)
  const totalRevenue   = Math.round(data.reduce((s, d) => s + d.revenue, 0) * 100) / 100
  const totalArrivals  = Object.values(periodResIds).reduce((s, set) => s + set.size, 0)
  const avgLeadDays    = await avgLeadTimeDays({ from, to })
  const totals = {
    roomNightsAvailable: totalAvailable,
    roomNightsOccupied:  totalOccupied,
    occupancyPct:        totalAvailable > 0 ? Math.round(totalOccupied / totalAvailable * 100 * 10) / 10 : 0,
    revenue:             totalRevenue,
    adr:                 totalOccupied > 0 ? Math.round(totalRevenue / totalOccupied * 100) / 100 : 0,
    revpar:              totalAvailable > 0 ? Math.round(totalRevenue / totalAvailable * 100) / 100 : 0,
    arrivals:            totalArrivals,
    avgLeadDays,
  }

  return { data, totals, meta: { totalRooms, dateFrom: from, dateTo: to, group, includeCancelled: !!includeCancelled } }
}

// ADR real por fecha, usando el ADR de SU semana ISO completa (ingresos ÷
// noches ocupadas de esa semana) — null si esa semana no tiene ninguna noche
// ocupada todavía (evita tratar un adr=0 por falta de datos como un "precio
// real de referencia" válido). Compartido entre el calendario de precios
// (colorea qué precios listados quedan por encima/debajo) y el motor de
// reglas dinámicas (demand_pulse_dip: suelo de precio = X% de este valor).
export async function weeklyAdrByDate(from: string, to: string): Promise<Record<string, number | null>> {
  const { data } = await computeOccupancyReport({ from, to, group: 'week' })
  const adrByWeek = new Map(data.map(w => [w.period, w.roomNightsOccupied > 0 ? w.adr : null]))
  const result: Record<string, number | null> = {}
  const cur = new Date(from + 'T12:00:00Z')
  const end = new Date(to   + 'T12:00:00Z')
  while (cur <= end) {
    const d = cur.toISOString().slice(0, 10)
    result[d] = adrByWeek.get(isoWeek(d)) ?? null
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return result
}
