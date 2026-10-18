import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import {
  reservations, rooms, roomTypes, rates, rateDailyPrices, bookingChannels, housekeepingTasks, breakfastNoService,
  laundryDeliveries, laundryProcessBatches, laundryProcessItems, users, abandonedCarts, cancellationRecoveries,
  paymentDateCorrections, financialTransactions, reservationSaleItems,
} from '../db/schema'
import { eq, and, lte, gte, or, inArray, desc, sql as drizzleSql } from 'drizzle-orm'
import { serverError } from '../lib/errors'
import { getPropertyId, getSetting, getBranding } from '../lib/property'
import { isAdmin } from '../middleware/auth'
import { isoWeek, periodKey, periodLabel, computeOccupancyReport } from '../lib/occupancyReport'
import { resolvePrice, rateChainIds, roomTypeChainIds } from '../lib/price-resolver'

const app = new Hono()

// Subconsultas de ids del tenant para tablas hijas sin property_id propio
const tenantTxIds = () => db.select({ id: financialTransactions.id }).from(financialTransactions).where(eq(financialTransactions.propertyId, getPropertyId()))

// ─── GET /api/reports/occupancy ───────────────────────────────────────────────
// Cálculo compartido con el tool de IA get_occupancy_report (src/lib/occupancyReport.ts)
// — así los dos sitios siempre devuelven exactamente los mismos números.

app.get('/occupancy', zValidator('query', z.object({
  from:             z.string().date(),
  to:               z.string().date(),
  group:            z.enum(['day', 'week', 'month', 'year']).default('day'),
  rateId:           z.coerce.number().int().positive().optional(),
  includeCancelled: z.coerce.boolean().optional(),
})), async (c) => {
  try {
    const { from, to, group, rateId, includeCancelled } = c.req.valid('query')
    const { data, totals, meta } = await computeOccupancyReport({ from, to, group, rateId, includeCancelled })
    return c.json({ data, totals, meta })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── GET /api/reports/abandoned-carts ─────────────────────────────────────────
// Registro diario de carritos web abandonados (data/meta, para el widget de
// Ocupación) MÁS el detalle carrito a carrito (carts) para la pestaña propia
// de Informes — email intentado, motivo de fallo si el envío falló, estado de
// WhatsApp y el estado ACTUAL de la reserva ligada (tentative/cancelled/...)
// para poder acceder a ella con un clic.

app.get('/abandoned-carts', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const detail = await db.select({
      id:              abandonedCarts.id,
      reservationId:   abandonedCarts.reservationId,
      createdAt:       abandonedCarts.createdAt,
      email:           abandonedCarts.email,
      phone:           abandonedCarts.phone,
      guestName:       abandonedCarts.guestName,
      amount:          abandonedCarts.amount,
      checkIn:         abandonedCarts.checkIn,
      checkOut:        abandonedCarts.checkOut,
      discountPct:     abandonedCarts.discountPct,
      emailSentAt:     abandonedCarts.emailSentAt,
      emailError:      abandonedCarts.emailError,
      emailSkipReason: abandonedCarts.emailSkipReason,
      whatsappSentAt:  abandonedCarts.whatsappSentAt,
      whatsappError:   abandonedCarts.whatsappError,
      recoveredAt:     abandonedCarts.recoveredAt,
      recoveredAmount: abandonedCarts.recoveredAmount,
      reservationStatus: reservations.status,
    }).from(abandonedCarts)
      .innerJoin(reservations, eq(reservations.id, abandonedCarts.reservationId))
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        gte(drizzleSql<string>`${abandonedCarts.createdAt}::date`, from),
        lte(drizzleSql<string>`${abandonedCarts.createdAt}::date`, to),
      ))
      .orderBy(drizzleSql`${abandonedCarts.createdAt} DESC`)

    const byDay: Record<string, { carts: number; amount: number; emailsSent: number; recovered: number; recoveredAmount: number }> = {}
    for (const r of detail) {
      const day = r.createdAt.toISOString().slice(0, 10)
      const d = byDay[day] ??= { carts: 0, amount: 0, emailsSent: 0, recovered: 0, recoveredAmount: 0 }
      d.carts++
      d.amount += parseFloat(r.amount)
      if (r.emailSentAt) d.emailsSent++
      if (r.recoveredAt) { d.recovered++; d.recoveredAmount += parseFloat(r.recoveredAmount ?? '0') }
    }
    const data = Object.entries(byDay)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([day, v]) => ({
        day, carts: v.carts, amount: v.amount.toFixed(2),
        emails_sent: v.emailsSent, recovered: v.recovered, recovered_amount: v.recoveredAmount.toFixed(2),
      }))

    const totals = detail.reduce((acc, r) => ({
      carts:            acc.carts + 1,
      amount:           acc.amount + parseFloat(r.amount),
      emailsSent:       acc.emailsSent + (r.emailSentAt ? 1 : 0),
      recovered:        acc.recovered + (r.recoveredAt ? 1 : 0),
      recoveredAmount:  acc.recoveredAmount + parseFloat(r.recoveredAmount ?? '0'),
    }), { carts: 0, amount: 0, emailsSent: 0, recovered: 0, recoveredAmount: 0 })

    return c.json({ data, meta: totals, carts: detail })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/room-access-visits ─────────────────────────────────────
// Uso del QR de habitación por los huéspedes: una visita = una carga con éxito
// de la página de su estancia (ver room_access_visits, registrada en
// src/routes/room-access.ts GET /reservation) — total por día, sea cual sea
// la habitación. Solo cuenta días con al menos una visita (sin rellenar los
// días a 0, igual que abandoned-carts).

app.get('/room-access-visits', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const rows = await db.execute(drizzleSql`
      SELECT (visited_at::date)::text AS day, COUNT(*)::int AS visits
      FROM room_access_visits
      WHERE property_id = ${getPropertyId()} AND visited_at::date >= ${from}::date AND visited_at::date <= ${to}::date
      GROUP BY visited_at::date
      ORDER BY visited_at::date DESC
    `) as unknown as { day: string; visits: number }[]

    const totalVisits    = rows.reduce((s, r) => s + r.visits, 0)
    const daysWithVisits = rows.length
    const spanDays       = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1
    const avgPerDay      = spanDays > 0 ? Math.round((totalVisits / spanDays) * 10) / 10 : 0
    const busiestDay     = rows.reduce((best, r) => (!best || r.visits > best.visits ? r : best), null as { day: string; visits: number } | null)

    // Horas punta — a qué hora del día (zona horaria del tenant) se usa más el QR.
    const tz = (await getBranding()).timezone
    const byHour = await db.execute(drizzleSql`
      SELECT EXTRACT(HOUR FROM visited_at AT TIME ZONE ${tz})::int AS hour, COUNT(*)::int AS visits
      FROM room_access_visits
      WHERE property_id = ${getPropertyId()} AND visited_at::date >= ${from}::date AND visited_at::date <= ${to}::date
      GROUP BY hour ORDER BY hour
    `) as unknown as { hour: number; visits: number }[]

    // Ranking de habitaciones más escaneadas.
    const byRoom = await db.execute(drizzleSql`
      SELECT v.room_id AS "roomId", r.code AS "roomCode", COUNT(*)::int AS visits
      FROM room_access_visits v
      LEFT JOIN rooms r ON r.id = v.room_id
      WHERE v.property_id = ${getPropertyId()} AND v.visited_at::date >= ${from}::date AND v.visited_at::date <= ${to}::date
      GROUP BY v.room_id, r.code
      ORDER BY visits DESC
    `) as unknown as { roomId: number | null; roomCode: string | null; visits: number }[]

    // Qué reservas en concreto usaron la web, con sus habitaciones, nº de
    // visitas y primera/última visita.
    const byReservationRaw = await db.execute(drizzleSql`
      SELECT v.reservation_id AS "reservationId",
             g.first_name AS "firstName", g.last_name AS "lastName",
             string_agg(DISTINCT r.code, ', ' ORDER BY r.code) AS "roomCodes",
             COUNT(*)::int AS visits,
             MIN(v.visited_at) AS "firstVisit", MAX(v.visited_at) AS "lastVisit"
      FROM room_access_visits v
      LEFT JOIN rooms r         ON r.id = v.room_id
      LEFT JOIN reservations res ON res.id = v.reservation_id AND res.property_id = ${getPropertyId()}
      LEFT JOIN guests g         ON g.id = res.guest_id
      WHERE v.property_id = ${getPropertyId()} AND v.visited_at::date >= ${from}::date AND v.visited_at::date <= ${to}::date
        AND v.reservation_id IS NOT NULL
      GROUP BY v.reservation_id, g.first_name, g.last_name
      ORDER BY visits DESC
    `) as unknown as {
      reservationId: number; firstName: string | null; lastName: string | null
      roomCodes: string | null; visits: number; firstVisit: string; lastVisit: string
    }[]

    const resIds = byReservationRaw.map(r => r.reservationId)

    // Extras comprados por esas reservas — no se puede saber si fue desde el
    // QR de habitación o desde el portal por email (ninguno de los dos
    // guarda el origen), así que es "compró algún extra", no "lo compró
    // desde aquí".
    const extrasByRes = new Map<number, { lines: number; total: number }>()
    if (resIds.length > 0) {
      const extraRows = await db.execute(drizzleSql`
        SELECT reservation_id AS "reservationId", COUNT(*)::int AS lines,
               COALESCE(SUM(quantity * unit_price), 0)::float AS total
        FROM reservation_sale_items
        WHERE reservation_id IN ${resIds}
          AND reservation_id IN (SELECT id FROM reservations WHERE property_id = ${getPropertyId()})
        GROUP BY reservation_id
      `) as unknown as { reservationId: number; lines: number; total: number }[]
      for (const e of extraRows) extrasByRes.set(e.reservationId, { lines: e.lines, total: e.total })
    }

    // Peticiones de housekeeping (no molestar / solo toallas / limpieza
    // normal) hechas desde la misma página — quedan como nota de texto en
    // housekeeping_tasks (ver POST /api/room-access/housekeeping-request),
    // así que se cuentan por coincidencia del texto que se guarda ahí.
    const hkByRes = new Map<number, { dnd: number; towelsOnly: number; clean: number }>()
    if (resIds.length > 0) {
      const hkRows = await db.execute(drizzleSql`
        SELECT res.id AS "reservationId", ht.notes
        FROM reservations res
        JOIN housekeeping_tasks ht
          ON ht.room_id = ANY (
               array_cat(
                 ARRAY[res.room_id]::int[],
                 COALESCE((SELECT array_agg(x::int) FROM jsonb_array_elements_text(COALESCE(res.extra_room_ids, '[]'::jsonb)) x), ARRAY[]::int[])
               )
             )
         AND ht.date >= res.check_in_date::text AND ht.date < res.check_out_date::text
        WHERE res.id IN ${resIds} AND res.property_id = ${getPropertyId()}
          AND ht.notes ILIKE '%Petición del huésped%'
      `) as unknown as { reservationId: number; notes: string }[]
      for (const h of hkRows) {
        const cur = hkByRes.get(h.reservationId) ?? { dnd: 0, towelsOnly: 0, clean: 0 }
        cur.dnd        += (h.notes.match(/No molestar/g)       ?? []).length
        cur.towelsOnly += (h.notes.match(/Solo toallas/g)      ?? []).length
        cur.clean      += (h.notes.match(/Limpieza normal/g)   ?? []).length
        hkByRes.set(h.reservationId, cur)
      }
    }

    const byReservation = byReservationRaw.map(r => ({
      reservationId: r.reservationId,
      guestName:     [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
      roomCodes:     r.roomCodes ?? '—',
      visits:        r.visits,
      firstVisit:    r.firstVisit,
      lastVisit:     r.lastVisit,
      extras:        extrasByRes.get(r.reservationId) ?? { lines: 0, total: 0 },
      housekeeping:  hkByRes.get(r.reservationId) ?? { dnd: 0, towelsOnly: 0, clean: 0 },
    }))

    return c.json({
      data: rows,
      meta: { totalVisits, daysWithVisits, avgPerDay, busiestDay },
      byHour, byRoom, byReservation,
    })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/channel-sales ──────────────────────────────────────────
// Ventas directas vs OTA por período. Los canales se clasifican por nombre parcial
// (directNames / otaNames: listas separadas por coma, case-insensitive).

app.get('/channel-sales', zValidator('query', z.object({
  from:        z.string().date(),
  to:          z.string().date(),
  group:       z.enum(['day', 'week', 'month']).default('month'),
  directNames: z.string().optional(),
  otaNames:    z.string().optional(),
})), async (c) => {
  try {
    const { from, to, group, directNames, otaNames } = c.req.valid('query')

    const directParts = (directNames ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const otaParts    = (otaNames    ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

    const channels = await db.select({ id: bookingChannels.id, name: bookingChannels.name })
      .from(bookingChannels).where(eq(bookingChannels.propertyId, getPropertyId()))

    const classifyChannel = (name: string | null): 'direct' | 'ota' | 'other' => {
      if (!name) return 'other'
      const lower = name.toLowerCase()
      if (directParts.length > 0 && directParts.some(p => lower.includes(p))) return 'direct'
      if (otaParts.length    > 0 && otaParts.some(p    => lower.includes(p))) return 'ota'
      return 'other'
    }

    const channelClass: Record<number, 'direct' | 'ota' | 'other'> = {}
    for (const ch of channels) channelClass[ch.id] = classifyChannel(ch.name)

    const resList = await db.select({
      id:               reservations.id,
      checkInDate:      reservations.checkInDate,
      bookedAt:         reservations.bookedAt,
      total:            reservations.total,
      bookingChannelId: reservations.bookingChannelId,
    }).from(reservations).where(and(
      eq(reservations.propertyId, getPropertyId()),
      gte(reservations.bookedAt, new Date(from + 'T00:00:00Z')),
      lte(reservations.bookedAt, new Date(to   + 'T23:59:59Z')),
      or(
        eq(reservations.status, 'confirmed'),
        eq(reservations.status, 'checked_in'),
        eq(reservations.status, 'checked_out'),
      )!,
    ))

    type PeriodData = { direct_count: number; direct_revenue: number; ota_count: number; ota_revenue: number; other_count: number; other_revenue: number }
    const grouped: Record<string, PeriodData> = {}

    for (const res of resList) {
      const key = periodKey(res.bookedAt!.toISOString().slice(0, 10), group)
      if (!grouped[key]) grouped[key] = { direct_count: 0, direct_revenue: 0, ota_count: 0, ota_revenue: 0, other_count: 0, other_revenue: 0 }
      const g = grouped[key]!
      const rev = parseFloat(res.total ?? '0')
      const cls = res.bookingChannelId ? (channelClass[res.bookingChannelId] ?? 'other') : 'other'
      if (cls === 'direct')       { g.direct_count++; g.direct_revenue += rev }
      else if (cls === 'ota')     { g.ota_count++;    g.ota_revenue    += rev }
      else                        { g.other_count++;  g.other_revenue  += rev }
    }

    const data = Object.keys(grouped).sort().map(k => ({
      period:          k,
      label:           periodLabel(k, group),
      direct_count:    grouped[k]!.direct_count,
      direct_revenue:  Math.round(grouped[k]!.direct_revenue * 100) / 100,
      ota_count:       grouped[k]!.ota_count,
      ota_revenue:     Math.round(grouped[k]!.ota_revenue * 100) / 100,
      other_count:     grouped[k]!.other_count,
      other_revenue:   Math.round(grouped[k]!.other_revenue * 100) / 100,
    }))

    const meta = {
      totalDirectCount:   data.reduce((s, d) => s + d.direct_count, 0),
      totalDirectRevenue: Math.round(data.reduce((s, d) => s + d.direct_revenue, 0) * 100) / 100,
      totalOtaCount:      data.reduce((s, d) => s + d.ota_count, 0),
      totalOtaRevenue:    Math.round(data.reduce((s, d) => s + d.ota_revenue, 0) * 100) / 100,
    }

    return c.json({ data, meta })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/cancellations ──────────────────────────────────────────
// Ratio de cancelación por canal en un período (bookedAt dentro del rango), MÁS
// dos series por fecha para ver dónde se concentran las cancelaciones:
//   - byCancelDate:  fecha en la que se canceló cada reserva (cuándo cancela la gente)
//   - byStayDate:    fecha de check-in de la estancia cancelada (qué fechas se
//                     quedan huecas — la que de verdad importa para repricing/overbooking)
// Se excluyen los carritos del motor de reservas que nunca llegaron a pagarse
// (tentative sin habitación asignada ni cobro, canceladas automáticamente por
// syncStatuses() en autoStatus.ts tras caducar) — no son cancelaciones reales,
// son intentos de reserva abandonados antes de pagar, y contarlas infla mucho
// la tasa de "web directa" frente a canales que no pasan por ese flujo.
//
// La fecha de cancelación real sale de reservation_status_logs (to_status =
// 'cancelled'), que es el log de auditoría de cambios de estado — mucho más
// preciso que updatedAt, que se pisa con cualquier otro cambio posterior a la
// reserva. Si una reserva quedó cancelada antes de que existiera ese log
// (migración 0035), se cae a updatedAt como aproximación.

app.get('/cancellations', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const channels = await db.select({ id: bookingChannels.id, name: bookingChannels.name })
      .from(bookingChannels).where(eq(bookingChannels.propertyId, getPropertyId()))
    const channelName: Record<number, string> = {}
    for (const ch of channels) channelName[ch.id] = ch.name

    const resList = await db.select({
      id:                reservations.id,
      bookingChannelId:  reservations.bookingChannelId,
      status:            reservations.status,
      isFromPortal:      reservations.isFromPortal,
      roomId:            reservations.roomId,
      amountPaid:        reservations.amountPaid,
      checkInDate:       reservations.checkInDate,
      updatedAt:         reservations.updatedAt,
    }).from(reservations).where(and(
      eq(reservations.propertyId, getPropertyId()),
      gte(reservations.bookedAt, new Date(from + 'T00:00:00Z')),
      lte(reservations.bookedAt, new Date(to   + 'T23:59:59Z')),
    ))

    type ChannelData = { total: number; cancelled: number }
    const byChannel: Record<string, ChannelData> = {}
    const cancelled: typeof resList = []

    for (const res of resList) {
      // Carrito web nunca pagado: mismo criterio que el auto-cancelado de
      // autoStatus.ts (isFromPortal + sin habitación + 0 € cobrados).
      const abandonedCart = res.isFromPortal && res.roomId == null && parseFloat(res.amountPaid ?? '0') === 0
      if (abandonedCart) continue

      const key = res.bookingChannelId ? (channelName[res.bookingChannelId] ?? `Canal ${res.bookingChannelId}`) : 'Sin canal'
      if (!byChannel[key]) byChannel[key] = { total: 0, cancelled: 0 }
      byChannel[key]!.total++
      if (res.status === 'cancelled') { byChannel[key]!.cancelled++; cancelled.push(res) }
    }

    const data = Object.entries(byChannel)
      .map(([channel, d]) => ({
        channel,
        total:             d.total,
        cancelled:         d.cancelled,
        cancellation_rate: d.total > 0 ? Math.round(d.cancelled / d.total * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.total - a.total)

    // Fecha real de cancelación por reserva (la más reciente si se canceló
    // varias veces, ej. tras un revert) — DISTINCT ON usa el índice existente
    // (reservation_id, changed_at DESC).
    const cancelledAt: Record<number, Date> = {}
    if (cancelled.length > 0) {
      const ids = cancelled.map(r => r.id)
      // ANY(${array}) no funciona a través de db.execute (drizzle-orm sobre
      // postgres-js no serializa el parámetro como array de Postgres ahí —
      // "op ANY/ALL (array) requires array on right side"); IN (...) con
      // sql.join sí, mismo patrón que ya usa fdm.ts.
      const logRows = await db.execute(drizzleSql`
        SELECT DISTINCT ON (reservation_id) reservation_id, changed_at
        FROM reservation_status_logs
        WHERE reservation_id IN (${drizzleSql.join(ids.map(id => drizzleSql`${id}`), drizzleSql`,`)}) AND to_status = 'cancelled'  -- ids ya filtrados por tenant
        ORDER BY reservation_id, changed_at DESC
      `) as unknown as { reservation_id: number; changed_at: Date }[]
      for (const row of logRows) cancelledAt[row.reservation_id] = new Date(row.changed_at)
    }

    const byCancelDateMap: Record<string, number> = {}
    const byStayDateMap:   Record<string, number> = {}
    for (const res of cancelled) {
      const cancelDate = (cancelledAt[res.id] ?? res.updatedAt!).toISOString().slice(0, 10)
      byCancelDateMap[cancelDate] = (byCancelDateMap[cancelDate] ?? 0) + 1
      byStayDateMap[res.checkInDate] = (byStayDateMap[res.checkInDate] ?? 0) + 1
    }

    const dayLabel = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
    const byCancelDate = Object.keys(byCancelDateMap).sort()
      .map(d => ({ date: d, label: dayLabel(d), cancelled: byCancelDateMap[d]! }))
    const byStayDate = Object.keys(byStayDateMap).sort()
      .map(d => ({ date: d, label: dayLabel(d), cancelled: byStayDateMap[d]! }))

    return c.json({ data, byCancelDate, byStayDate })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/cancellations/detail ────────────────────────────────────
// Detalle de las reservas canceladas de una barra concreta del gráfico (por
// fecha de cancelación o de estancia) — nombre, email, teléfono, importe
// original y lo que costaría HOY esa misma estancia con las tarifas actuales
// (mismo repricing que /reservations/calc-price), para ver de un vistazo si
// merece la pena intentar reenganchar al huésped con un descuento.
// from/to: mismo rango (por bookedAt) que ya tiene aplicado el informe padre.

app.get('/cancellations/detail', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
  date: z.string().date(),
  by:   z.enum(['cancel', 'stay']),
})), async (c) => {
  try {
    const { from, to, date, by } = c.req.valid('query')

    const resList = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        eq(reservations.status, 'cancelled'),
        gte(reservations.bookedAt, new Date(from + 'T00:00:00Z')),
        lte(reservations.bookedAt, new Date(to   + 'T23:59:59Z')),
      ),
      with: { guest: true },
    })

    // Mismo criterio de exclusión que el informe padre: carritos web nunca pagados.
    const real = resList.filter(res => {
      const abandonedCart = res.isFromPortal && res.roomId == null && parseFloat(res.amountPaid ?? '0') === 0
      return !abandonedCart
    })

    let matched: typeof real

    if (by === 'stay') {
      matched = real.filter(res => res.checkInDate === date)
    } else {
      const ids = real.map(r => r.id)
      const cancelledAt: Record<number, Date> = {}
      if (ids.length > 0) {
        const logRows = await db.execute(drizzleSql`
          SELECT DISTINCT ON (reservation_id) reservation_id, changed_at
          FROM reservation_status_logs
          WHERE reservation_id IN (${drizzleSql.join(ids.map(id => drizzleSql`${id}`), drizzleSql`,`)}) AND to_status = 'cancelled'
          ORDER BY reservation_id, changed_at DESC
        `) as unknown as { reservation_id: number; changed_at: Date }[]
        for (const row of logRows) cancelledAt[row.reservation_id] = new Date(row.changed_at)
      }
      matched = real.filter(res => (cancelledAt[res.id] ?? res.updatedAt!).toISOString().slice(0, 10) === date)
    }

    // Repricing a tarifas de hoy — igual que /reservations/calc-price, pero en
    // bloque para todas las reservas de esta barra a la vez.
    const roomIds = [...new Set(matched.map(r => r.roomId).filter((x): x is number => x != null))]
    const roomsRows = roomIds.length > 0
      ? await db.select({ id: rooms.id, roomTypeId: rooms.roomTypeId }).from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, roomIds)))
      : []
    const roomTypeIdByRoom: Record<number, number> = {}
    for (const r of roomsRows) roomTypeIdByRoom[r.id] = r.roomTypeId

    const [allRates, allRoomTypes] = await Promise.all([
      db.query.rates.findMany({ where: eq(rates.propertyId, getPropertyId()) }),
      db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, getPropertyId()) }),
    ])
    const ratesById     = new Map(allRates.map(r => [r.id, r]))
    const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))

    // Rango de fechas y tarifas/tipos de habitación a cubrir en una sola query
    // de precios diarios, en vez de una por reserva.
    let minDate: string | null = null, maxDate: string | null = null
    const rateIdsToFetch     = new Set<number>()
    const roomTypeIdsToFetch = new Set<number>()
    for (const res of matched) {
      if (!minDate || res.checkInDate < minDate)  minDate = res.checkInDate
      if (!maxDate || res.checkOutDate > maxDate) maxDate = res.checkOutDate
      if (res.rateId) for (const id of rateChainIds(ratesById.get(res.rateId)!, ratesById)) rateIdsToFetch.add(id)
      const roomTypeId = res.roomId ? roomTypeIdByRoom[res.roomId] : undefined
      if (roomTypeId && roomTypesById.has(roomTypeId)) {
        for (const id of roomTypeChainIds(roomTypesById.get(roomTypeId)!, roomTypesById)) roomTypeIdsToFetch.add(id)
      }
    }

    const priceRows = (minDate && maxDate && rateIdsToFetch.size > 0)
      ? await db.select({
          rateId:     rateDailyPrices.rateId,
          date:       rateDailyPrices.date,
          price:      rateDailyPrices.price,
          roomTypeId: rateDailyPrices.roomTypeId,
        }).from(rateDailyPrices).where(and(
          inArray(rateDailyPrices.rateId, [...rateIdsToFetch]),
          gte(rateDailyPrices.date, minDate),
          lte(rateDailyPrices.date, maxDate),
          or(
            inArray(rateDailyPrices.roomTypeId, [...roomTypeIdsToFetch]),
            drizzleSql`${rateDailyPrices.roomTypeId} IS NULL`,
          ),
        ))
      : []

    const data = matched.map(res => {
      const g = res.guest as any
      const roomTypeId = res.roomId ? roomTypeIdByRoom[res.roomId] : undefined
      let currentAmount: number | null = null
      if (res.rateId && roomTypeId && roomTypesById.has(roomTypeId) && ratesById.has(res.rateId)) {
        const nights: string[] = []
        const cur = new Date(res.checkInDate + 'T00:00:00Z')
        const end = new Date(res.checkOutDate + 'T00:00:00Z')
        while (cur < end) { nights.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1) }
        const occupancy = roomTypesById.get(roomTypeId)!.maxOccupancy ?? 1
        const prices = nights.map(d => resolvePrice(ratesById, roomTypesById, priceRows, res.rateId!, roomTypeId, d, occupancy))
        if (prices.every(p => p != null)) currentAmount = Math.round(prices.reduce((s, p) => s + p!, 0) * 100) / 100
      }
      return {
        id:              res.id,
        name:            g ? `${g.firstName} ${g.lastName}`.trim() : null,
        email:           g?.email ?? null,
        phone:           g?.phone ?? null,
        checkInDate:     res.checkInDate,
        checkOutDate:    res.checkOutDate,
        originalAmount:  parseFloat(res.total ?? '0'),
        currentAmount,
      }
    })

    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/cancellation-recoveries ─────────────────────────────────
// Detalle del reenganche de cancelaciones (src/lib/cancellationRecovery.ts) en
// el período — email intentado/enviado, WhatsApp, y si se recuperó (con la
// reserva nueva creada). Filtra por createdAt del registro de reenganche, no
// por bookedAt de la reserva — es cuándo se detectó/ofreció, no cuándo se
// hizo la reserva original.

app.get('/cancellation-recoveries', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const detail = await db.select().from(cancellationRecoveries).where(and(
      inArray(cancellationRecoveries.reservationId, db.select({ id: reservations.id }).from(reservations).where(eq(reservations.propertyId, getPropertyId()))),
      gte(drizzleSql<string>`${cancellationRecoveries.createdAt}::date`, from),
      lte(drizzleSql<string>`${cancellationRecoveries.createdAt}::date`, to),
    )).orderBy(drizzleSql`${cancellationRecoveries.createdAt} DESC`)

    const totals = detail.reduce((acc, r) => ({
      count:            acc.count + 1,
      emailsSent:       acc.emailsSent + (r.emailSentAt ? 1 : 0),
      recovered:        acc.recovered + (r.recoveredAt ? 1 : 0),
      recoveredAmount:  acc.recoveredAmount + parseFloat(r.recoveredAmount ?? '0'),
    }), { count: 0, emailsSent: 0, recovered: 0, recoveredAmount: 0 })

    return c.json({ data: detail, meta: totals })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/lead-time ───────────────────────────────────────────────
// Lead time (días entre bookedAt y checkInDate) por canal.

app.get('/lead-time', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const channels = await db.select({ id: bookingChannels.id, name: bookingChannels.name })
      .from(bookingChannels).where(eq(bookingChannels.propertyId, getPropertyId()))
    const channelName: Record<number, string> = {}
    for (const ch of channels) channelName[ch.id] = ch.name

    const resList = await db.select({
      bookingChannelId: reservations.bookingChannelId,
      checkInDate:      reservations.checkInDate,
      bookedAt:         reservations.bookedAt,
    }).from(reservations).where(and(
      eq(reservations.propertyId, getPropertyId()),
      gte(reservations.bookedAt, new Date(from + 'T00:00:00Z')),
      lte(reservations.bookedAt, new Date(to   + 'T23:59:59Z')),
      or(
        eq(reservations.status, 'confirmed'),
        eq(reservations.status, 'checked_in'),
        eq(reservations.status, 'checked_out'),
      )!,
    ))

    type ChannelData = { sum: number; count: number; min: number; max: number }
    const byChannel: Record<string, ChannelData> = {}

    for (const res of resList) {
      if (!res.bookedAt) continue
      const key = res.bookingChannelId ? (channelName[res.bookingChannelId] ?? `Canal ${res.bookingChannelId}`) : 'Sin canal'
      const lead = Math.round((new Date(res.checkInDate + 'T12:00:00Z').getTime() - res.bookedAt.getTime()) / 86400000)
      if (lead < 0) continue
      if (!byChannel[key]) byChannel[key] = { sum: 0, count: 0, min: Infinity, max: -Infinity }
      byChannel[key]!.sum   += lead
      byChannel[key]!.count++
      if (lead < byChannel[key]!.min) byChannel[key]!.min = lead
      if (lead > byChannel[key]!.max) byChannel[key]!.max = lead
    }

    const data = Object.entries(byChannel)
      .map(([channel, d]) => ({
        channel,
        count:   d.count,
        avg:     d.count > 0 ? Math.round(d.sum / d.count * 10) / 10 : 0,
        min:     d.min === Infinity ? 0 : d.min,
        max:     d.max === -Infinity ? 0 : d.max,
      }))
      .sort((a, b) => b.count - a.count)

    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/payment-corrections ─────────────────────────────────────
// Errores de registro de pagos corregidos ("Cobrado en otra fecha" en la
// pestaña Pagos de ReservationDetailView) — cada fila de payment_date_corrections
// es un error ya corregido: quién lo registró mal originalmente (empleado),
// cuál era la fecha/usuario equivocados, la fecha/hora real y quién cobró de
// verdad, y quién aplicó la corrección. Filtra por fixedAt (cuándo se detectó
// y corrigió el error), no por la fecha equivocada ni por la corregida — es
// el momento en que el error "existe" a efectos de este informe.

app.get('/payment-corrections', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const rows = await db.select().from(paymentDateCorrections)
      .where(and(
        inArray(paymentDateCorrections.transactionId, tenantTxIds()),
        gte(drizzleSql<string>`${paymentDateCorrections.fixedAt}::date`, from),
        lte(drizzleSql<string>`${paymentDateCorrections.fixedAt}::date`, to),
      ))
      .orderBy(desc(paymentDateCorrections.fixedAt))

    const userIds = new Set<number>()
    for (const r of rows) {
      if (r.previousCreatedBy) userIds.add(r.previousCreatedBy)
      if (r.paidByUserId)      userIds.add(r.paidByUserId)
      if (r.fixedBy)           userIds.add(r.fixedBy)
    }
    const nameById: Record<number, string> = {}
    if (userIds.size > 0) {
      const userRows = await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
        .from(users).where(and(eq(users.propertyId, getPropertyId()), inArray(users.id, [...userIds])))
      for (const u of userRows) nameById[u.id] = `${u.firstName} ${u.lastName}`
    }
    const nameOf = (id: number | null) => id ? (nameById[id] ?? `Usuario ${id}`) : null

    const data = rows.map(r => ({
      id:              r.id,
      transactionId:   r.transactionId,
      reservationId:   r.reservationId,
      description:     r.description,
      previousDate:    r.previousTransactionDate,
      correctedAt:     r.correctedAt,
      fixedAt:         r.fixedAt,
      employeeId:      r.previousCreatedBy,
      employeeName:    nameOf(r.previousCreatedBy) ?? 'Desconocido',
      paidByName:      nameOf(r.paidByUserId),
      fixedByName:     nameOf(r.fixedBy),
    }))

    // Por empleado que cometió el error — cuántos y quién se los ha corregido.
    type EmpAgg = { employeeId: number | null; employeeName: string; errors: number; correctors: Map<string, number> }
    const byEmployeeMap = new Map<string, EmpAgg>()
    for (const d of data) {
      const key = String(d.employeeId ?? 'desconocido')
      let agg = byEmployeeMap.get(key)
      if (!agg) { agg = { employeeId: d.employeeId, employeeName: d.employeeName, errors: 0, correctors: new Map() }; byEmployeeMap.set(key, agg) }
      agg.errors++
      const correctorName = d.fixedByName ?? 'Desconocido'
      agg.correctors.set(correctorName, (agg.correctors.get(correctorName) ?? 0) + 1)
    }
    const byEmployee = [...byEmployeeMap.values()]
      .map(e => ({
        employeeId: e.employeeId, employeeName: e.employeeName, errors: e.errors,
        correctors: [...e.correctors.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.errors - a.errors)

    // Serie por día (fixedAt) para el gráfico.
    const byDayRows = await db.select({
      day:   drizzleSql<string>`${paymentDateCorrections.fixedAt}::date`,
      count: drizzleSql<number>`count(*)::int`,
    }).from(paymentDateCorrections)
      .where(and(
        inArray(paymentDateCorrections.transactionId, tenantTxIds()),
        gte(drizzleSql<string>`${paymentDateCorrections.fixedAt}::date`, from),
        lte(drizzleSql<string>`${paymentDateCorrections.fixedAt}::date`, to),
      ))
      .groupBy(drizzleSql`${paymentDateCorrections.fixedAt}::date`)
    const dayLabel = (d: string) => new Date(d + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })
    const byDay = byDayRows
      .sort((a, b) => a.day.localeCompare(b.day))
      .map(r => ({ date: r.day, label: dayLabel(r.day), count: r.count }))

    return c.json({ data, byEmployee, byDay, meta: { total: data.length } })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/checkin-time ───────────────────────────────────────────
// Tiempo promedio de procesamiento de check-in (checkinStartedAt → checkedInAt).

// Umbrales para filtrar tiempos de check-in atípicos:
// < 10 s → apertura accidental / doble clic; > 2400 s (40 min) → pantalla abandonada abierta
const CHECKIN_MIN_SECONDS = 10
const CHECKIN_MAX_SECONDS = 2400

app.get('/checkin-time', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')

    const allRows = await db.execute(drizzleSql`
      SELECT
        EXTRACT(EPOCH FROM (checked_in_at - checkin_started_at))::int AS duration_seconds,
        checkin_started_at::date AS day,
        checked_in_by AS employee_id,
        u.first_name || ' ' || u.last_name AS employee_name,
        r.checkin_had_contract,
        r.checkin_zkteco_enrolled,
        r.checkin_ses_sent
      FROM reservations r
      LEFT JOIN users u ON u.id = r.checked_in_by
      WHERE r.property_id = ${getPropertyId()}
        AND r.checkin_started_at IS NOT NULL
        AND r.checked_in_at IS NOT NULL
        AND r.checked_in_at > r.checkin_started_at
        AND r.checkin_started_at::date >= ${from}::date
        AND r.checkin_started_at::date <= ${to}::date
      ORDER BY r.checkin_started_at
    `) as unknown as {
      duration_seconds: number; day: string
      employee_id: number | null; employee_name: string | null
      checkin_had_contract: boolean | null; checkin_zkteco_enrolled: boolean | null; checkin_ses_sent: boolean | null
    }[]

    // Pasos omitidos — sobre todos los check-ins del período (no solo los no atípicos)
    const totalCheckins   = allRows.length
    const skippedContract = allRows.filter(r => r.checkin_had_contract === false).length
    const skippedZkteco   = allRows.filter(r => r.checkin_zkteco_enrolled === false).length
    const skippedSes      = allRows.filter(r => r.checkin_ses_sent === false).length

    // Filtrar outliers para el cálculo de tiempos
    const rows = allRows.filter(r => {
      const d = Number(r.duration_seconds)
      return d >= CHECKIN_MIN_SECONDS && d <= CHECKIN_MAX_SECONDS
    })
    const excludedShort = allRows.filter(r => Number(r.duration_seconds) < CHECKIN_MIN_SECONDS).length
    const excludedLong  = allRows.filter(r => Number(r.duration_seconds) > CHECKIN_MAX_SECONDS).length
    const excluded      = excludedShort + excludedLong

    if (rows.length === 0) {
      return c.json({
        data: [], byEmployee: [],
        meta: { count: 0, avg_seconds: 0, min_seconds: 0, max_seconds: 0, excluded, excludedShort, excludedLong, totalCheckins, skippedContract, skippedZkteco, skippedSes },
      })
    }

    const durations = rows.map(r => Number(r.duration_seconds)).sort((a, b) => a - b)
    const sum = durations.reduce((s, d) => s + d, 0)
    const avg = Math.round(sum / durations.length)
    const min = durations[0]!
    const max = durations[durations.length - 1]!

    const byDay: Record<string, { sum: number; count: number }> = {}
    for (const r of rows) {
      if (!byDay[r.day]) byDay[r.day] = { sum: 0, count: 0 }
      byDay[r.day]!.sum += Number(r.duration_seconds)
      byDay[r.day]!.count++
    }

    const data = Object.keys(byDay).sort().map(day => ({
      day,
      label:   new Date(day + 'T12:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }),
      count:   byDay[day]!.count,
      avg:     Math.round(byDay[day]!.sum / byDay[day]!.count),
    }))

    const empMap: Record<string, { name: string; sum: number; count: number; min: number; max: number }> = {}
    for (const r of rows) {
      const key  = String(r.employee_id ?? 'unknown')
      const name = r.employee_name?.trim() || 'Sin asignar'
      const d    = Number(r.duration_seconds)
      if (!empMap[key]) empMap[key] = { name, sum: 0, count: 0, min: d, max: d }
      empMap[key]!.sum   += d
      empMap[key]!.count += 1
      empMap[key]!.min    = Math.min(empMap[key]!.min, d)
      empMap[key]!.max    = Math.max(empMap[key]!.max, d)
    }

    // Pasos omitidos por empleado — del total de check-ins (incluidos outliers de duración)
    const skipEmpMap: Record<string, { name: string; total: number; skipContract: number; skipZkteco: number; skipSes: number }> = {}
    for (const r of allRows) {
      const key = String(r.employee_id ?? 'unknown')
      if (!skipEmpMap[key]) skipEmpMap[key] = { name: r.employee_name?.trim() || 'Sin asignar', total: 0, skipContract: 0, skipZkteco: 0, skipSes: 0 }
      skipEmpMap[key]!.total += 1
      if (r.checkin_had_contract === false) skipEmpMap[key]!.skipContract += 1
      if (r.checkin_zkteco_enrolled === false) skipEmpMap[key]!.skipZkteco += 1
      if (r.checkin_ses_sent === false) skipEmpMap[key]!.skipSes += 1
    }

    // Unión: empleados con tiempos válidos + empleados con solo fallos de pasos
    const allEmpKeys = new Set([
      ...Object.keys(empMap),
      ...Object.keys(skipEmpMap).filter(k => {
        const s = skipEmpMap[k]!
        return s.skipContract > 0 || s.skipZkteco > 0 || s.skipSes > 0
      }),
    ])

    const byEmployee = [...allEmpKeys].map(id => {
      const e = empMap[id]
      const s = skipEmpMap[id]
      return {
        name:            e?.name ?? s?.name ?? 'Sin asignar',
        count:           e?.count ?? 0,
        avg:             e ? Math.round(e.sum / e.count) : null,
        min:             e?.min ?? null,
        max:             e?.max ?? null,
        totalCheckins:   s?.total ?? e?.count ?? 0,
        skippedContract: s?.skipContract ?? 0,
        skippedZkteco:   s?.skipZkteco ?? 0,
        skippedSes:      s?.skipSes ?? 0,
      }
    }).sort((a, b) => {
      if (a.avg === null && b.avg === null) return a.name.localeCompare(b.name)
      if (a.avg === null) return 1
      if (b.avg === null) return -1
      return a.avg - b.avg
    })

    return c.json({ data, byEmployee, meta: { count: rows.length, avg_seconds: avg, min_seconds: min, max_seconds: max, excluded, totalCheckins, skippedContract, skippedZkteco, skippedSes } })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/commissions ─────────────────────────────────────────────
// Comisión de OTAs (Booking.com y otras) por canal y período, sobre las reservas
// con CHECK-OUT en el rango (no check-in) — así el período representa estancias
// ya cerradas dentro de ese rango. % configurable por canal (ver PATCH más
// abajo) — por defecto null = 0%, no se inventa ningún porcentaje.
// Solo cuentan las reservas con algo cobrado (amountPaid > 0) — una reserva sin
// ningún cobro registrado no genera comisión real todavía, así que ni suma al
// conteo ni al importe.

app.get('/commissions', zValidator('query', z.object({
  from:  z.string().date(),
  to:    z.string().date(),
  group: z.enum(['month', 'year']).default('month'),
})), async (c) => {
  try {
    const { from, to, group } = c.req.valid('query')

    const channels = await db.select({
      id: bookingChannels.id, name: bookingChannels.name, commissionPct: bookingChannels.commissionPct,
    }).from(bookingChannels).where(and(eq(bookingChannels.propertyId, getPropertyId()), eq(bookingChannels.active, true)))

    const resList = await db.select({
      checkOutDate:      reservations.checkOutDate,
      total:            reservations.total,
      originalTotal:    reservations.originalTotal,
      bmCommission:     reservations.bmCommission,
      bookingChannelId: reservations.bookingChannelId,
      amountPaid:       reservations.amountPaid,
    }).from(reservations).where(and(
      eq(reservations.propertyId, getPropertyId()),
      gte(reservations.checkOutDate, from),
      lte(reservations.checkOutDate, to),
      or(
        eq(reservations.status, 'confirmed'),
        eq(reservations.status, 'checked_in'),
        eq(reservations.status, 'checking_out'),
        eq(reservations.status, 'checked_out'),
      )!,
    ))

    // Base de la comisión: el precio ORIGINAL de la reserva (antes de extras o
    // ampliaciones, que no llevan comisión) — reservations.originalTotal, que
    // solo se rellena al importar desde FDM. Reservas más antiguas (o de otras
    // vías) no lo tienen: se cae a `total` como aproximación.
    // Comisión: si FDM ya mandó bm_commission (el importe real que calcula el
    // canal) se usa tal cual — más preciso que un % nuestro. Si no, se aplica
    // el % configurado del canal sobre esa base.
    // grouped[período][canalId] = { count, revenue, commission }
    type Cell = { count: number; revenue: number; commission: number }
    const grouped: Record<string, Record<number, Cell>> = {}
    const pctByChannel = new Map(channels.map(ch => [ch.id, parseFloat(ch.commissionPct ?? '0')]))
    for (const r of resList) {
      if (!r.bookingChannelId) continue
      if (parseFloat(r.amountPaid ?? '0') <= 0) continue  // nada cobrado todavía → no cuenta
      const key    = periodKey(r.checkOutDate, group)
      const period = (grouped[key] ??= {})
      const cell   = (period[r.bookingChannelId] ??= { count: 0, revenue: 0, commission: 0 })
      const basis  = parseFloat(r.originalTotal ?? r.total ?? '0')
      const bm     = parseFloat(r.bmCommission ?? '0')
      const pct    = pctByChannel.get(r.bookingChannelId) ?? 0
      cell.count++
      cell.revenue    += basis
      cell.commission += bm > 0 ? bm : (basis * pct / 100)
    }

    const round2 = (n: number) => Math.round(n * 100) / 100

    const data = Object.keys(grouped).sort().map(key => {
      const row: Record<string, unknown> = { period: key, label: periodLabel(key, group) }
      let periodRevenue = 0, periodCommission = 0
      for (const ch of channels) {
        const cell = grouped[key]![ch.id]
        row[`ch_${ch.id}_count`]      = cell?.count ?? 0
        row[`ch_${ch.id}_revenue`]    = round2(cell?.revenue ?? 0)
        row[`ch_${ch.id}_commission`] = round2(cell?.commission ?? 0)
        periodRevenue    += cell?.revenue ?? 0
        periodCommission += cell?.commission ?? 0
      }
      row.total_revenue    = round2(periodRevenue)
      row.total_commission = round2(periodCommission)
      return row
    })

    const meta = {
      totalRevenue:    round2(data.reduce((s, d) => s + (d.total_revenue as number), 0)),
      totalCommission: round2(data.reduce((s, d) => s + (d.total_commission as number), 0)),
    }

    return c.json({ data, channels, meta })
  } catch (err) { return serverError(c, err) }
})

// ─── PATCH /api/reports/commissions/:channelId ────────────────────────────────
// Ajusta el % de comisión de un canal concreto. Solo dirección.

app.patch('/commissions/:channelId', zValidator('json', z.object({
  commissionPct: z.number().min(0).max(100).nullable(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const channelId = Number(c.req.param('channelId'))
    if (!channelId) return c.json({ error: 'Canal inválido' }, 400)

    const { commissionPct } = c.req.valid('json')
    await db.update(bookingChannels)
      .set({ commissionPct: commissionPct == null ? null : commissionPct.toFixed(2) })
      .where(and(eq(bookingChannels.id, channelId), eq(bookingChannels.propertyId, getPropertyId())))

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/breakfast ───────────────────────────────────────────────
// Desayunos servidos día a día (mismo criterio que la pestaña de desayunos de
// housekeeping, ver src/routes/housekeeping.ts GET /breakfast) y, para
// dirección, el movimiento del inventario de desayunos del sistema externo de
// piscina/mantenimiento en el mismo período. Ese inventario no tiene precio en
// €, solo cantidades por producto — por eso "repuesto"/"consumido" van en
// unidades del producto (cajas, paquetes, kg…), no en euros.
const BREAKFAST_REPORT_MAX_DAYS = 366

app.get('/breakfast', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')
    const spanDays = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) + 1
    if (spanDays <= 0) return c.json({ error: 'Rango de fechas inválido' }, 400)
    if (spanDays > BREAKFAST_REPORT_MAX_DAYS) return c.json({ error: `El rango máximo es de ${BREAKFAST_REPORT_MAX_DAYS} días.` }, 400)

    // generate_series(date, date, interval) devuelve timestamp, no date — hay que
    // volver a castear a date antes de pasar a texto, si no el texto sale con hora
    // ("2026-08-01 00:00:00") y periodLabel() en el frontend lo parsea como fecha
    // inválida ("Invalid date").
    // Desayunos incluidos en tarifa (HD/HyD/Desayuno): una fila por (día, reserva)
    const pid = getPropertyId()
    const bfPatterns = ((await getSetting<string[]>('breakfast.rateTitlePatterns')) ?? ['HD', 'HyD', 'desayuno']).map(p => `%${p}%`)
    const bfPatternsSql = drizzleSql`ARRAY[${drizzleSql.join(bfPatterns.map(p => drizzleSql`${p}`), drizzleSql`, `)}]::text[]`
    const rateRows = await db.execute(drizzleSql`
      SELECT (d.day::date)::text AS day,
        GREATEST(
          r.people,
          1 + (SELECT COUNT(DISTINCT rn.guest_id)::int FROM reservation_nights rn WHERE rn.reservation_id = r.id AND rn.guest_id != r.guest_id)
        ) AS people,
        (bl.reservation_id IS NOT NULL) AS served
      FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) AS d(day)
      JOIN reservations r  ON r.property_id = ${pid} AND r.check_in_date < d.day::date AND r.check_out_date >= d.day::date AND r.status NOT IN ('cancelled', 'no_show')
      JOIN rates rt        ON rt.id = r.rate_id AND rt.title ILIKE ANY(${bfPatternsSql})
      LEFT JOIN breakfast_logs bl ON bl.reservation_id = r.id AND bl.date = d.day::date AND bl.extra_id IS NULL
    `) as unknown as { day: string; people: number; served: boolean }[]

    // Desayunos comprados como extra (reservation_sale_items): una fila por (día, extra).
    // times_served se cuenta SOLO hasta ese día (bl2.date <= d.day) — a diferencia del
    // cálculo del día actual (housekeeping.ts, get_breakfast_summary), aquí sí importa
    // porque se reconstruye el pasado: contar los servidos de días futuros habría hecho
    // que "lo que quedaba pendiente" en un día antiguo saliera artificialmente bajo.
    const extraRows = await db.execute(drizzleSql`
      SELECT (d.day::date)::text AS day, rsi.id AS extra_id, rsi.quantity,
        GREATEST(
          r.people,
          1 + (SELECT COUNT(DISTINCT rn.guest_id)::int FROM reservation_nights rn WHERE rn.reservation_id = r.id AND rn.guest_id != r.guest_id)
        ) AS people,
        (SELECT COUNT(*) FROM breakfast_logs bl2 WHERE bl2.extra_id = rsi.id AND bl2.date <= d.day::date) AS times_served,
        (bl.reservation_id IS NOT NULL) AS served
      FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) AS d(day)
      JOIN reservations r          ON r.property_id = ${pid} AND r.check_in_date <= d.day::date AND r.check_out_date >= d.day::date AND r.status NOT IN ('cancelled', 'no_show')
      JOIN reservation_sale_items rsi ON rsi.reservation_id = r.id
      JOIN sale_items si           ON si.id = rsi.sale_item_id AND si.title ILIKE '%desayuno%'
      LEFT JOIN breakfast_logs bl  ON bl.reservation_id = rsi.reservation_id AND bl.date = d.day::date AND bl.extra_id = rsi.id
    `) as unknown as { day: string; extra_id: number; quantity: number; people: number; times_served: number; served: boolean }[]

    const noServiceRows = await db.select({ date: breakfastNoService.date })
      .from(breakfastNoService)
      .where(and(eq(breakfastNoService.propertyId, pid), gte(breakfastNoService.date, from), lte(breakfastNoService.date, to)))
    const noServiceDays = new Set(noServiceRows.map(r => r.date))

    type DayAgg = { fromRate: number; rateServed: number; fromExtras: number; extrasServed: number }
    const byDay: Record<string, DayAgg> = {}
    const dayAgg = (day: string): DayAgg => byDay[day] ??= { fromRate: 0, rateServed: 0, fromExtras: 0, extrasServed: 0 }

    for (const r of rateRows) {
      const people = Number(r.people ?? 1)
      const agg = dayAgg(r.day)
      agg.fromRate += people
      if (r.served) agg.rateServed += people
    }
    for (const e of extraRows) {
      const people    = Math.max(1, Number(e.people ?? 1))
      const remaining = Math.max(0, Number(e.quantity) - Number(e.times_served) * people)
      if (remaining <= 0 && !e.served) continue
      const agg  = dayAgg(e.day)
      const units = e.served ? people : remaining
      agg.fromExtras += units
      if (e.served) agg.extrasServed += units
    }

    const data = Object.keys(byDay).sort().map(day => {
      const a = byDay[day]!
      return {
        date:              day,
        label:             periodLabel(day, 'day'),
        from_rate:         a.fromRate,
        from_extras:       a.fromExtras,
        served:            a.rateServed + a.extrasServed,
        pending_rate:      Math.max(0, a.fromRate - a.rateServed),
        no_service_marked: noServiceDays.has(day),
      }
    })

    const totalServed   = data.reduce((s, d) => s + d.served, 0)
    const totalRateDue  = data.reduce((s, d) => s + d.from_rate, 0)
    const daysNoService = data.filter(d => d.no_service_marked).length

    return c.json({
      data,
      totals: { total_served: totalServed, total_rate_due: totalRateDue, avg_served_per_day: data.length ? Math.round((totalServed / data.length) * 10) / 10 : 0, days_no_service: daysNoService },
    })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/laundry ──────────────────────────────────────────────────
// Trabajo de lavandería: prendas entregadas (enviadas sucias) y procesadas
// (devueltas y clasificadas), en total y por trabajador.

app.get('/laundry', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')
    if (from > to) return c.json({ error: 'Rango de fechas inválido' }, 400)

    const delivRows = await db.select({
      id: laundryDeliveries.id, date: laundryDeliveries.date, deliveredById: laundryDeliveries.deliveredById,
      showerTowels: laundryDeliveries.showerTowels, handTowels: laundryDeliveries.handTowels,
      sheetSets: laundryDeliveries.sheetSets, footTowels: laundryDeliveries.footTowels,
      recipientStatus: laundryDeliveries.recipientStatus,
    }).from(laundryDeliveries)
      .where(and(eq(laundryDeliveries.propertyId, getPropertyId()), gte(laundryDeliveries.date, from), lte(laundryDeliveries.date, to)))

    const batchRows = await db.select({
      id: laundryProcessBatches.id, date: laundryProcessBatches.date, processedById: laundryProcessBatches.processedById,
    }).from(laundryProcessBatches)
      .where(and(eq(laundryProcessBatches.propertyId, getPropertyId()), gte(laundryProcessBatches.date, from), lte(laundryProcessBatches.date, to)))

    const batchIds = batchRows.map(b => b.id)
    const itemRows = batchIds.length > 0
      ? await db.select({
          batchId: laundryProcessItems.batchId, itemType: laundryProcessItems.itemType,
          status: laundryProcessItems.status, count: laundryProcessItems.count,
        }).from(laundryProcessItems).where(inArray(laundryProcessItems.batchId, batchIds))
      : []

    const userIds = [...new Set([...delivRows.map(d => d.deliveredById), ...batchRows.map(b => b.processedById)])]
    const userRows = userIds.length > 0
      ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(and(eq(users.propertyId, getPropertyId()), inArray(users.id, userIds)))
      : []
    const nameById = new Map(userRows.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]))

    // Entregas: por día y por empleado
    type DelivAgg = { showerTowels: number; handTowels: number; sheetSets: number; footTowels: number; count: number; discrepancies: number }
    const newDelivAgg = (): DelivAgg => ({ showerTowels: 0, handTowels: 0, sheetSets: 0, footTowels: 0, count: 0, discrepancies: 0 })
    const byDayDeliv: Record<string, DelivAgg> = {}
    const byEmpDeliv: Record<number, DelivAgg> = {}
    for (const d of delivRows) {
      for (const bucket of [byDayDeliv[d.date] ??= newDelivAgg(), byEmpDeliv[d.deliveredById] ??= newDelivAgg()]) {
        bucket.showerTowels += d.showerTowels; bucket.handTowels += d.handTowels
        bucket.sheetSets    += d.sheetSets;    bucket.footTowels += d.footTowels
        bucket.count++
        if (d.recipientStatus === 'discrepancy') bucket.discrepancies++
      }
    }

    // Procesado: por empleado y totales por estado/tipo de prenda
    const batchEmpById = new Map(batchRows.map(b => [b.id, b.processedById]))
    type ProcAgg = { total: number; listas: number; tendidas: number; en_agua: number; sucias: number; rotas: number; batches: Set<number> }
    const newProcAgg = (): ProcAgg => ({ total: 0, listas: 0, tendidas: 0, en_agua: 0, sucias: 0, rotas: 0, batches: new Set() })
    const byEmpProc: Record<number, ProcAgg> = {}
    const byStatus: Record<string, number> = { listas: 0, tendidas: 0, en_agua: 0, sucias: 0, rotas: 0 }
    const byType:   Record<string, number> = { shower: 0, manos: 0, sabanas: 0, pies: 0 }
    for (const it of itemRows) {
      const empId = batchEmpById.get(it.batchId)
      if (empId != null) {
        const agg = byEmpProc[empId] ??= newProcAgg()
        agg.total += it.count
        if (it.status in agg) (agg as any)[it.status] += it.count
        agg.batches.add(it.batchId)
      }
      byStatus[it.status] = (byStatus[it.status] ?? 0) + it.count
      byType[it.itemType]  = (byType[it.itemType] ?? 0) + it.count
    }

    const deliveredByDay = Object.entries(byDayDeliv).sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, label: periodLabel(date, 'day'), ...v, total: v.showerTowels + v.handTowels + v.sheetSets + v.footTowels }))

    const deliveredByEmployee = Object.entries(byEmpDeliv).map(([id, v]) => ({
      name: nameById.get(Number(id)) ?? 'Sin asignar', deliveries: v.count, discrepancies: v.discrepancies,
      showerTowels: v.showerTowels, handTowels: v.handTowels, sheetSets: v.sheetSets, footTowels: v.footTowels,
      total: v.showerTowels + v.handTowels + v.sheetSets + v.footTowels,
    })).sort((a, b) => b.total - a.total)

    const processedByEmployee = Object.entries(byEmpProc).map(([id, v]) => ({
      name: nameById.get(Number(id)) ?? 'Sin asignar', batches: v.batches.size, total: v.total,
      listas: v.listas, tendidas: v.tendidas, en_agua: v.en_agua, sucias: v.sucias, rotas: v.rotas,
    })).sort((a, b) => b.total - a.total)

    const totalDelivered = deliveredByEmployee.reduce((s, e) => s + e.total, 0)
    const totalProcessed = Object.values(byStatus).reduce((s, n) => s + n, 0)

    return c.json({
      deliveredByDay, deliveredByEmployee, processedByEmployee, byStatus, byType,
      meta: {
        totalDelivered, totalProcessed,
        deliveriesCount: delivRows.length, batchesCount: batchRows.length,
        discrepancies: delivRows.filter(d => d.recipientStatus === 'discrepancy').length,
      },
    })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/reports/housekeeping-staff ──────────────────────────────────────
// Cuánto trabajo de limpieza se genera (tareas por día) y cómo responde cada
// trabajador: tareas asignadas/completadas, % de finalización y tiempo medio
// desde que se generó la tarea hasta que se marcó hecha (no es tiempo real de
// limpieza — la tarea puede generarse antes de que el trabajador la empiece —
// pero sí refleja la carga y la rapidez de respuesta de cada uno).

app.get('/housekeeping-staff', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    const { from, to } = c.req.valid('query')
    if (from > to) return c.json({ error: 'Rango de fechas inválido' }, 400)

    const rows = await db.select({
      id: housekeepingTasks.id, date: housekeepingTasks.date, taskType: housekeepingTasks.taskType,
      status: housekeepingTasks.status, assignedTo: housekeepingTasks.assignedTo,
      completedAt: housekeepingTasks.completedAt, completedBy: housekeepingTasks.completedBy,
      assignedAt: housekeepingTasks.assignedAt,
    }).from(housekeepingTasks)
      .where(and(eq(housekeepingTasks.propertyId, getPropertyId()), gte(housekeepingTasks.date, from), lte(housekeepingTasks.date, to)))

    const userIds = [...new Set(rows.flatMap(r => [r.assignedTo, r.completedBy]).filter((x): x is number => x != null))]
    const userRows = userIds.length > 0
      ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName }).from(users).where(and(eq(users.propertyId, getPropertyId()), inArray(users.id, userIds)))
      : []
    const nameById = new Map(userRows.map(u => [u.id, `${u.firstName} ${u.lastName}`.trim()]))

    type DayAgg = { generated: number; completed: number; pending: number; dnd: number; departure: number; stay: number }
    const byDay: Record<string, DayAgg> = {}
    for (const r of rows) {
      const agg = byDay[r.date] ??= { generated: 0, completed: 0, pending: 0, dnd: 0, departure: 0, stay: 0 }
      agg.generated++
      if (r.status === 'done') agg.completed++
      else if (r.status === 'dnd') agg.dnd++
      else agg.pending++
      if (r.taskType === 'departure') agg.departure++; else agg.stay++
    }
    const data = Object.keys(byDay).sort().map(date => ({ date, label: periodLabel(date, 'day'), ...byDay[date]! }))

    // Por empleado: una completada se atribuye a quien la completó; si sigue
    // pendiente, a quien la tiene asignada (así la carga pendiente también se ve).
    type EmpAgg = { assigned: number; completed: number; pending: number; dnd: number; departure: number; stay: number; totalSeconds: number; withDuration: number }
    const byEmp: Record<number, EmpAgg> = {}
    for (const r of rows) {
      const empId = r.status === 'done' ? (r.completedBy ?? r.assignedTo) : r.assignedTo
      if (empId == null) continue
      const agg = byEmp[empId] ??= { assigned: 0, completed: 0, pending: 0, dnd: 0, departure: 0, stay: 0, totalSeconds: 0, withDuration: 0 }
      agg.assigned++
      if (r.status === 'done') {
        agg.completed++
        // Tiempo de respuesta: desde que se ASIGNA (no desde que se genera la
        // tarea) hasta que se completa. Si no hay assignedAt (tarea de antes de
        // este cambio, o completada sin haber pasado por una asignación propia)
        // no se puede medir, se deja fuera del promedio. Por debajo de 1 minuto
        // se considera que asignación y finalización fueron el mismo gesto
        // (p.ej. autoasignación al completar una tarea sin asignar) y tampoco cuenta.
        if (r.completedAt && r.assignedAt) {
          const secs = Math.round((new Date(r.completedAt).getTime() - new Date(r.assignedAt).getTime()) / 1000)
          if (secs >= 60) { agg.totalSeconds += secs; agg.withDuration++ }
        }
      } else if (r.status === 'dnd') agg.dnd++
      else agg.pending++
      if (r.taskType === 'departure') agg.departure++; else agg.stay++
    }

    const byEmployee = Object.entries(byEmp).map(([id, v]) => ({
      name: nameById.get(Number(id)) ?? 'Sin asignar',
      assigned: v.assigned, completed: v.completed, pending: v.pending, dnd: v.dnd,
      departure: v.departure, stay: v.stay,
      completionRate: v.assigned > 0 ? Math.round((v.completed / v.assigned) * 100) : 0,
      avgSeconds: v.withDuration > 0 ? Math.round(v.totalSeconds / v.withDuration) : null,
    })).sort((a, b) => b.assigned - a.assigned)

    const total          = rows.length
    const totalCompleted = rows.filter(r => r.status === 'done').length
    const totalDnd       = rows.filter(r => r.status === 'dnd').length

    return c.json({
      data, byEmployee,
      meta: {
        total, completed: totalCompleted, dnd: totalDnd, pending: total - totalCompleted - totalDnd,
        completionRate: total > 0 ? Math.round((totalCompleted / total) * 100) : 0,
      },
    })
  } catch (err) { return serverError(c, err) }
})

export default app
