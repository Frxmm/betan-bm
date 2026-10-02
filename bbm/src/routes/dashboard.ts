import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, rooms } from '../db/schema'
import { eq, and, or, count, sum, gte, lte, gt, sql, ne, notInArray, isNotNull, countDistinct } from 'drizzle-orm'
import { serverError } from '../lib/errors'
import { getPropertyId, getBranding } from '../lib/property'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'

const app = new Hono()

const dateQuery = z.object({ date: z.string().date().optional() })

// Añade pendingBalance (saldo real, sin contar depósitos retenidos sin
// cobrar — ver src/lib/paymentAggregate.ts) a una lista de reservas.
async function withPendingBalance<T extends { id: number; total: string | null }>(list: T[]): Promise<(T & { realPaid: number; pendingBalance: number })[]> {
  const realPaidById = await realPaidByReservation(list.map(r => r.id))
  return list.map(r => {
    const realPaid = realPaidById.get(r.id) ?? 0
    return { ...r, realPaid, pendingBalance: calcPendingBalance(r.total, realPaid) }
  })
}

// Hoy en la zona horaria del tenant (YYYY-MM-DD)
async function todayStr_(): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
}

// GET /api/dashboard
// Resumen del día: llegadas, salidas, ocupación, estadísticas
app.get('/', async (c) => {
  try {
    const today = await todayStr_()
    const pid = getPropertyId()

    const [arrivals, departures, inHouse, newRes] = await Promise.all([
      db.select({ count: count() }).from(reservations)
        .where(and(
          eq(reservations.propertyId, pid),
          eq(reservations.checkInDate, today),
          or(eq(reservations.status, 'tentative'), eq(reservations.status, 'arriving'), eq(reservations.status, 'confirmed')),
        )),
      db.select({ count: count() }).from(reservations)
        .where(and(
          eq(reservations.propertyId, pid),
          eq(reservations.checkOutDate, today),
          or(
            eq(reservations.status, 'confirmed'),
            eq(reservations.status, 'checked_in'),
            eq(reservations.status, 'checking_out'),
          ),
        )),
      db.select({ count: count() }).from(reservations)
        .where(and(eq(reservations.propertyId, pid), eq(reservations.status, 'checked_in'))),
      db.select({ count: count() }).from(reservations)
        .where(and(eq(reservations.propertyId, pid), sql`${reservations.bookedAt}::date = ${today}::date`)),
    ])

    return c.json({
      data: {
        date: today,
        arrivals:   arrivals[0]?.count ?? 0,
        departures: departures[0]?.count ?? 0,
        inHouse:    inHouse[0]?.count ?? 0,
        newReservations: newRes[0]?.count ?? 0,
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/arrivals?date=YYYY-MM-DD
// Llegadas del día: confirmed (por llegar) + checked_in que llegaron ese día
app.get('/arrivals', zValidator('query', dateQuery), async (c) => {
  try {
    const date = c.req.valid('query').date ?? await todayStr_()
    const list = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        eq(reservations.checkInDate, date),
        or(
          eq(reservations.status, 'tentative'),
          eq(reservations.status, 'arriving'),
          eq(reservations.status, 'confirmed'),
          eq(reservations.status, 'checked_in'),
          eq(reservations.status, 'checking_out'),
          eq(reservations.status, 'checked_out'),
        ),
      ),
      with: { guest: true, room: { with: { roomType: true } }, bookingChannel: true },
      orderBy: reservations.checkInDate,
      limit: 200,
    })
    return c.json({ data: await withPendingBalance(list), meta: { date } })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/departures?date=YYYY-MM-DD
// Salidas del día: checked_in (por salir) + checked_out que salieron ese día
app.get('/departures', zValidator('query', dateQuery), async (c) => {
  try {
    const date = c.req.valid('query').date ?? await todayStr_()
    const list = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        eq(reservations.checkOutDate, date),
        or(
          eq(reservations.status, 'confirmed'),
          eq(reservations.status, 'checked_in'),
          eq(reservations.status, 'checking_out'),
          eq(reservations.status, 'checked_out'),
        ),
      ),
      with: { guest: true, room: { with: { roomType: true } }, bookingChannel: true },
      orderBy: reservations.checkInDate,
      limit: 200,
    })
    return c.json({ data: await withPendingBalance(list), meta: { date } })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/in-house
// Lista de huéspedes en casa ahora mismo
app.get('/in-house', async (c) => {
  try {
    const list = await db.query.reservations.findMany({
      where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'checked_in')),
      with: { guest: true, room: true },
      orderBy: reservations.checkOutDate,
      limit: 200,
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/billing?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
// Resumen financiero del período: totales cobrados, pendientes, por canal
app.get('/billing', zValidator('query', z.object({
  dateFrom: z.string().date().optional(),
  dateTo:   z.string().date().optional(),
})), async (c) => {
  try {
    const today = await todayStr_()
    const { dateFrom = today, dateTo = today } = c.req.valid('query')

    // Reservas cuyo check-in cae dentro del período
    const list = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        gte(reservations.checkInDate, dateFrom),
        lte(reservations.checkInDate, dateTo),
        or(
          eq(reservations.status, 'tentative'),
          eq(reservations.status, 'arriving'),
          eq(reservations.status, 'confirmed'),
          eq(reservations.status, 'checked_in'),
          eq(reservations.status, 'checked_out'),
          eq(reservations.status, 'no_show'),
        ),
      ),
      with: { guest: true, room: true, bookingChannel: true, rate: true },
      orderBy: reservations.checkInDate,
    })

    // Pagado real: no cuenta los depósitos retenidos sin cobrar como si
    // pagaran la estancia (ver src/lib/paymentAggregate.ts) — mismo criterio
    // que "Pendiente" en el listado de Reservas.
    const realPaidById = await realPaidByReservation(list.map(r => r.id))
    const dataWithBalance = list.map(r => {
      const realPaid = realPaidById.get(r.id) ?? 0
      return { ...r, realPaid, pendingBalance: calcPendingBalance(r.total, realPaid) }
    })

    // Totales aggregados
    const totalRevenue = dataWithBalance.reduce((s, r) => s + parseFloat(r.total ?? '0'), 0)
    const totalPaid    = dataWithBalance.reduce((s, r) => s + r.realPaid, 0)
    const totalDue     = dataWithBalance.reduce((s, r) => s + r.pendingBalance, 0)

    // Desglose por canal
    const byChannel: Record<string, { count: number; revenue: number; paid: number }> = {}
    for (const r of dataWithBalance) {
      const ch = r.bookingChannel?.name ?? 'Sin canal'
      byChannel[ch] ??= { count: 0, revenue: 0, paid: 0 }
      byChannel[ch].count++
      byChannel[ch].revenue += parseFloat(r.total ?? '0')
      byChannel[ch].paid    += r.realPaid
    }

    return c.json({
      data: dataWithBalance,
      meta: {
        dateFrom, dateTo,
        count: dataWithBalance.length,
        totalRevenue: totalRevenue.toFixed(2),
        totalPaid:    totalPaid.toFixed(2),
        totalDue:     totalDue.toFixed(2),
        byChannel,
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/occupancy
// Ocupación hoy y semana actual (lunes–domingo)
app.get('/occupancy', async (c) => {
  try {
    // Hoy en la zona horaria del tenant; el resto es aritmética de fechas (UTC al mediodía, sin saltos de DST)
    const todayStr = await todayStr_()
    const todayD = new Date(`${todayStr}T12:00:00Z`)
    const fmt    = (d: Date) => d.toISOString().slice(0, 10)

    // Semana: lunes → domingo de la semana actual
    const dow = todayD.getUTCDay() // 0=Dom
    const diffMon = dow === 0 ? -6 : 1 - dow
    const weekStart = new Date(todayD); weekStart.setUTCDate(todayD.getUTCDate() + diffMon)
    const weekEnd   = new Date(weekStart); weekEnd.setUTCDate(weekStart.getUTCDate() + 6)
    const weekStartStr = fmt(weekStart)
    const weekEndStr   = fmt(weekEnd)

    // Total habitaciones activas (excluye VIRTUAL)
    const [roomRow] = await db
      .select({ total: count() })
      .from(rooms)
      .where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true), ne(rooms.code, 'VIRTUAL')))
    const totalRooms = Number(roomRow?.total ?? 0)

    const INACTIVE = ['cancelled', 'no_show'] as const

    // Hoy: habitaciones distintas ocupadas
    const [todayRow] = await db
      .select({ occupied: countDistinct(reservations.roomId) })
      .from(reservations)
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        lte(reservations.checkInDate, todayStr),
        gt(reservations.checkOutDate, todayStr),
        notInArray(reservations.status, [...INACTIVE]),
        isNotNull(reservations.roomId),
      ))
    const todayOccupied = Number(todayRow?.occupied ?? 0)

    // Semana: reservas que se solapan con la semana, calculamos room-nights en JS
    const weekRes = await db
      .select({
        checkInDate:  reservations.checkInDate,
        checkOutDate: reservations.checkOutDate,
        roomId:       reservations.roomId,
      })
      .from(reservations)
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        lte(reservations.checkInDate, weekEndStr),
        gt(reservations.checkOutDate, weekStartStr),
        notInArray(reservations.status, [...INACTIVE]),
        isNotNull(reservations.roomId),
      ))

    // Para cada día de la semana, contamos habitaciones distintas ocupadas y sumamos
    const weekDays: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart); d.setUTCDate(weekStart.getUTCDate() + i)
      weekDays.push(fmt(d))
    }
    let weekOccupiedNights = 0
    for (const day of weekDays) {
      const occupied = new Set<number>()
      for (const r of weekRes) {
        if (r.checkInDate <= day && r.checkOutDate > day && r.roomId) {
          occupied.add(r.roomId)
        }
      }
      weekOccupiedNights += occupied.size
    }
    const weekTotal = totalRooms * 7

    return c.json({
      data: {
        totalRooms,
        today: {
          date:     todayStr,
          occupied: todayOccupied,
          total:    totalRooms,
          pct:      totalRooms > 0 ? Math.round(todayOccupied / totalRooms * 100) : 0,
        },
        week: {
          from:     weekStartStr,
          to:       weekEndStr,
          occupiedNights: weekOccupiedNights,
          totalNights:    weekTotal,
          pct:      weekTotal > 0 ? Math.round(weekOccupiedNights / weekTotal * 100) : 0,
        },
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/dashboard/recent?limit=N
// Últimas reservas ordenadas por fecha de creación (feed)
app.get('/recent', zValidator('query', z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) })), async (c) => {
  try {
    const { limit } = c.req.valid('query')
    const list = await db.query.reservations.findMany({
      where: and(eq(reservations.propertyId, getPropertyId()), sql`NOT (${reservations.amountPaid} = 0 AND ${reservations.isFromPortal} = true)`),
      with: { guest: true, room: { with: { roomType: true } }, bookingChannel: true, rate: true },
      orderBy: (r, { desc }) => desc(r.bookedAt),
      limit,
    })
    return c.json({ data: await withPendingBalance(list) })
  } catch (err) {
    return serverError(c, err)
  }
})

export default app
