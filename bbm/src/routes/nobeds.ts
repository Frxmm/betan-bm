import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { rooms, roomTypes, reservations, guests, rates, rateDailyPrices, currencies } from '../db/schema'
import { eq, and, gte, lte, inArray, isNotNull, sql } from 'drizzle-orm'
import { isAdmin } from '../middleware/auth'
import { getPropertyId, getBranding, getSetting, hasFeature } from '../lib/property'
import { serverError } from '../lib/errors'
import {
  isConfigured, listBookings, listRentals,
  blockDates, unblockDates, pushAvailability,
} from '../lib/nobeds'

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('nobeds')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// GET /api/nobeds/status
app.get('/status', async (c) => {
  return c.json({ configured: await isConfigured() })
})

// GET /api/nobeds/rentals — listar alojamientos de Nobeds para mapear habitaciones
app.get('/rentals', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    if (!await isConfigured()) return c.json({ error: 'NOBEDS_API_TOKEN no configurado' }, 400)
    const rentals = await listRentals()
    return c.json({ data: rentals })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/nobeds/sync — importar reservas desde Nobeds
app.post('/sync', zValidator('json', z.object({
  fromdate: z.string().date().optional(),
  todate:   z.string().date().optional(),
})), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    if (!await isConfigured()) return c.json({ error: 'NOBEDS_API_TOKEN no configurado' }, 400)

    const now  = new Date()
    const from = c.req.valid('json').fromdate
      ?? new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10)
    const to   = c.req.valid('json').todate
      ?? new Date(now.getFullYear(), now.getMonth() + 6, 0).toISOString().slice(0, 10)

    const bookings = await listBookings({ fromdate: from, todate: to })

    // Moneda local del tenant (properties.currencyCode → currencies.id)
    const cur = await db.query.currencies.findFirst({ where: eq(currencies.code, (await getBranding()).currencyCode), columns: { id: true } })
    if (!cur) return c.json({ error: 'La moneda del hotel no existe en currencies' }, 400)
    const currencyId = cur.id

    let created = 0, updated = 0, skipped = 0, errors = 0
    const errorList: string[] = []

    for (const b of bookings) {
      try {
        // Buscar tipo de habitación por nobeds_room_id
        const roomType = await db.query.roomTypes.findFirst({
          where: and(eq(roomTypes.nobedsRoomId, b.room_id), eq(roomTypes.propertyId, getPropertyId())),
          columns: { id: true },
        })
        if (!roomType) { skipped++; continue }

        // Elegir la primera habitación activa de ese tipo
        const room = await db.query.rooms.findFirst({
          where: and(eq(rooms.roomTypeId, roomType.id), eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)),
          columns: { id: true },
        })
        if (!room) { skipped++; continue }

        const isCancelled = !!(b.canceled || b.deleted)
        const checkIn  = b.checkin.slice(0, 10)
        const checkOut = b.checkout.slice(0, 10)
        const nights   = Math.max(1, Math.round(
          (new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000
        ))

        // Buscar o crear huésped
        let guestId: number
        const existingGuest = b.email
          ? await db.query.guests.findFirst({
              where: and(eq(guests.email, b.email), eq(guests.propertyId, getPropertyId())),
              columns: { id: true },
            })
          : null

        if (existingGuest) {
          guestId = existingGuest.id
        } else {
          const parts     = (b.name || 'Nobeds').trim().split(/\s+/)
          const firstName = parts[0] ?? 'Nobeds'
          const lastName  = parts.slice(1).join(' ') || '-'
          const inserted = await db.insert(guests).values({
            propertyId:  getPropertyId(),
            firstName,
            lastName,
            email:       b.email    ?? undefined,
            phone:       b.phone    ?? undefined,
            address1:    b.address  ?? undefined,
            nationality: b.country  ?? undefined,
          }).returning({ id: guests.id })
          guestId = inserted[0]!.id
        }

        // Upsert por nobeds_order_id
        const existing = await db.query.reservations.findFirst({
          where: and(eq(reservations.nobedsOrderId, b.order_id), eq(reservations.propertyId, getPropertyId())),
          columns: { id: true, status: true, checkInDate: true, checkOutDate: true },
        })

        if (existing) {
          const wantedStatus = isCancelled ? 'cancelled' : existing.status
          const needsUpdate  = existing.status !== wantedStatus
            || existing.checkInDate  !== checkIn
            || existing.checkOutDate !== checkOut
          if (needsUpdate) {
            await db.update(reservations)
              .set({ status: wantedStatus, checkInDate: checkIn, checkOutDate: checkOut, nights, updatedAt: new Date() })
              .where(and(eq(reservations.id, existing.id), eq(reservations.propertyId, getPropertyId())))
          }
          updated++
        } else if (!isCancelled) {
          await db.insert(reservations).values({
            propertyId:    getPropertyId(),
            guestId,
            roomId:        room.id,
            checkInDate:   checkIn,
            checkOutDate:  checkOut,
            nights,
            people:        b.guests || 1,
            total:         String(b.total ?? b.price ?? 0),
            status:        'confirmed',
            externalCode:  String(b.order_id),
            nobedsOrderId: b.order_id,
            source:        'nobeds',
            isFromPortal:  true,
            currencyId,
          })
          created++
        } else {
          skipped++
        }
      } catch (e: any) {
        errors++
        errorList.push(`order ${(b as any).order_id ?? '?'}: ${e.message}`)
      }
    }

    return c.json({
      data: {
        total: bookings.length,
        created,
        updated,
        skipped,
        errors,
        errorList,
        range: { from, to },
        syncedAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/nobeds/room-types/:id/mapping — asignar nobeds_room_id a un tipo de habitación
app.patch('/room-types/:id/mapping', zValidator('json', z.object({
  nobedsRoomId: z.number().int().nullable(),
})), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const id = Number(c.req.param('id'))
    const { nobedsRoomId } = c.req.valid('json')
    const [updated] = await db.update(roomTypes)
      .set({ nobedsRoomId, updatedAt: new Date() })
      .where(and(eq(roomTypes.id, id), eq(roomTypes.propertyId, getPropertyId())))
      .returning()
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/nobeds/push-availability/:id — empujar disponibilidad de una reserva concreta
app.post('/push-availability/:id', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    if (!await isConfigured()) return c.json({ error: 'NOBEDS_API_TOKEN no configurado' }, 400)
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { room: true },
    })
    if (!res) return c.json({ error: 'Reserva no encontrada' }, 404)
    const nobedsRoomId = (res.room as any)?.nobedsRoomId
    if (!nobedsRoomId) return c.json({ error: 'Habitación sin nobedsRoomId mapeado' }, 400)

    if (res.status === 'cancelled' || res.status === 'checked_out') {
      await unblockDates(nobedsRoomId, res.checkInDate, res.checkOutDate)
    } else {
      await blockDates(nobedsRoomId, res.checkInDate, res.checkOutDate)
    }
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/nobeds/push-prices — envía tarifas + disponibilidad a Nobeds para una tarifa y rango
app.post('/push-prices', zValidator('json', z.object({
  from:     z.string().date(),
  to:       z.string().date(),
  rateCode: z.string().optional(),   // por defecto setting nobeds.rateCode del tenant
})), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    if (!await isConfigured()) return c.json({ error: 'NOBEDS_API_TOKEN no configurado' }, 400)
    const { from, to } = c.req.valid('json')
    const rateCode = c.req.valid('json').rateCode ?? await getSetting<string>('nobeds.rateCode')
    if (!rateCode) return c.json({ error: 'Falta la tarifa a publicar (rateCode o setting nobeds.rateCode)' }, 400)

    // 1. Tarifa por código
    const rate = await db.query.rates.findFirst({ where: and(eq(rates.code, rateCode), eq(rates.propertyId, getPropertyId())) })
    if (!rate) return c.json({ error: `Tarifa "${rateCode}" no encontrada` }, 404)

    // 2. Tipos de habitación mapeados en Nobeds
    const mappedTypes = await db.select().from(roomTypes)
      .where(and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true), isNotNull(roomTypes.nobedsRoomId)))
    if (!mappedTypes.length) return c.json({ error: 'No hay tipos de habitación mapeados en Nobeds' }, 400)

    // 3. Precios para esos tipos en el rango
    const typeIds = mappedTypes.map(rt => rt.id)
    const prices = await db.select().from(rateDailyPrices).where(and(
      eq(rateDailyPrices.rateId, rate.id),
      inArray(rateDailyPrices.roomTypeId, typeIds),
      gte(rateDailyPrices.date, from),
      lte(rateDailyPrices.date, to),
    ))

    // priceByTypeDate[roomTypeId][date] = { price, closed }
    const priceByTypeDate: Record<number, Record<string, { price: string; closed: boolean }>> = {}
    for (const p of prices) {
      if (p.roomTypeId == null) continue
      ;(priceByTypeDate[p.roomTypeId] ??= {})[p.date] = { price: p.price, closed: p.closed }
    }

    // 4. Noches ocupadas por tipo de habitación y fecha
    // IN (...) con sql.join en vez de ANY(${typeIds}): pasando por db.execute,
    // drizzle-orm sobre postgres-js no serializa un array JS como array de
    // Postgres ahí — "op ANY/ALL (array) requires array on right side".
    const typeIdsList = sql.join(typeIds.map(id => sql`${id}`), sql`,`)
    const occupiedRaw = await db.execute(sql`
      SELECT rn.room_type_id, rn.date::text AS date, COUNT(*)::int AS count
      FROM reservation_nights rn
      INNER JOIN reservations res ON res.id = rn.reservation_id
      WHERE rn.cancelled = false
        AND res.property_id = ${getPropertyId()}
        AND res.status NOT IN ('cancelled', 'no_show')
        AND rn.room_type_id IN (${typeIdsList})
        AND rn.date BETWEEN ${from}::date AND ${to}::date
      GROUP BY rn.room_type_id, rn.date
    `) as unknown as { room_type_id: number; date: string; count: number }[]

    // occupiedByType[roomTypeId][date] = número de habitaciones ocupadas
    const occupiedByType: Record<number, Record<string, number>> = {}
    for (const r of occupiedRaw) {
      ;(occupiedByType[r.room_type_id] ??= {})[r.date] = r.count
    }

    // Total de habitaciones por tipo (para calcular disponibilidad)
    const roomCountRaw = await db.execute(sql`
      SELECT room_type_id, COUNT(*)::int AS total
      FROM rooms
      WHERE property_id = ${getPropertyId()} AND active = true AND room_type_id IN (${typeIdsList})
      GROUP BY room_type_id
    `) as unknown as { room_type_id: number; total: number }[]
    const roomCountByType: Record<number, number> = {}
    for (const r of roomCountRaw) roomCountByType[r.room_type_id] = r.total

    // 5. Generar rango de fechas
    const dates: string[] = []
    const cur = new Date(from + 'T12:00:00')
    const end = new Date(to   + 'T12:00:00')
    while (cur <= end) {
      const iso = cur.toISOString().slice(0, 10); dates.push(iso)
      cur.setDate(cur.getDate() + 1)
    }

    // 6. Push a Nobeds por tipo de habitación
    let pushed = 0, skipped = 0, errors = 0
    const errorList: string[] = []

    for (const rt of mappedTypes) {
      const byDate   = priceByTypeDate[rt.id] ?? {}
      const occupied = occupiedByType[rt.id]  ?? {}
      const total    = roomCountByType[rt.id] ?? 0

      for (const date of dates) {
        const entry = byDate[date]
        if (!entry) { skipped++; continue }

        const occ      = occupied[date] ?? 0
        const avail    = entry.closed ? 0 : Math.max(0, total - occ)
        const price    = parseFloat(entry.price)

        try {
          await pushAvailability(rt.nobedsRoomId!, date, avail, isNaN(price) ? undefined : price)
          pushed++
        } catch (e: any) {
          errors++
          errorList.push(`tipo ${rt.name} ${date}: ${e.message}`)
          if (errorList.length >= 20) break
        }
      }
      if (errorList.length >= 20) break
    }

    return c.json({ data: { pushed, skipped, errors, errorList, from, to, rateCode } })
  } catch (err) { return serverError(c, err) }
})

export { blockDates, unblockDates }
export default app
