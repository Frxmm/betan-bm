import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import QRCode from 'qrcode'
import { db } from '../db'
import { rooms, roomTypes, blockedBeds, reservationNights, reservations } from '../db/schema'
import { eq, and, between, notInArray, sql, lt, gt, ne, inArray } from 'drizzle-orm'
import { notFound, serverError } from '../lib/errors'
import { isAdmin } from '../middleware/auth'
import { env } from '../lib/env'
import { ensureRoomQrToken } from '../lib/roomAccess'
import { getPropertyId } from '../lib/property'

// Ids de habitaciones del tenant (reservation_nights no lleva property_id: se acota por habitación)
const tenantRoomIds = () => db.select({ id: rooms.id }).from(rooms).where(eq(rooms.propertyId, getPropertyId()))
const ownRoom = async (id: number) => !!(await db.query.rooms.findFirst({ where: and(eq(rooms.id, id), eq(rooms.propertyId, getPropertyId())), columns: { id: true } }))
const ownRoomType = async (id: number) => !!(await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, id), eq(roomTypes.propertyId, getPropertyId())), columns: { id: true } }))
const jwtUserId = (c: any): number | null => { const n = Number((c.get('jwtPayload') as any)?.sub); return Number.isFinite(n) && n > 0 ? n : null }

const app = new Hono()

// GET /api/rooms — lista de habitaciones (con tipo)
app.get('/', async (c) => {
  try {
    const list = await db.query.rooms.findMany({
      where: and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)),
      with: { roomType: true },
    })
    list.sort((a, b) => {
      const na = parseInt(a.code), nb = parseInt(b.code)
      if (!isNaN(na) && !isNaN(nb)) return na - nb
      if (!isNaN(na)) return -1
      if (!isNaN(nb)) return  1
      return a.code.localeCompare(b.code)
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/availability?dateFrom=&dateTo= — disponibilidad por fechas
// Devuelve habitaciones libres (sin reservation_nights en ese rango)
app.get('/availability', zValidator('query', z.object({
  dateFrom: z.string().date(),
  dateTo:   z.string().date(),
})), async (c) => {
  try {
    const { dateFrom, dateTo } = c.req.valid('query')

    // IDs de habitaciones ocupadas en ese rango
    const occupied = await db.selectDistinct({ roomId: reservationNights.roomId })
      .from(reservationNights)
      .where(and(
        between(reservationNights.date, dateFrom, dateTo),
        eq(reservationNights.cancelled, false),
        inArray(reservationNights.roomId, tenantRoomIds()),
      ))

    const occupiedIds = occupied.map(r => r.roomId)

    const available = await db.query.rooms.findMany({
      where: and(
        eq(rooms.propertyId, getPropertyId()),
        eq(rooms.active, true),
        occupiedIds.length > 0 ? notInArray(rooms.id, occupiedIds) : undefined,
      ),
      with: { roomType: true },
      orderBy: rooms.orderIndex,
    })

    return c.json({ data: available })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/available-for-reservation?checkIn=&checkOut=&excludeRoomId=&includeVirtual=
// Habitaciones disponibles para crear/mover reserva: activas, sin reserva solapada, sin bloqueo
app.get('/available-for-reservation', zValidator('query', z.object({
  checkIn:        z.string().date(),
  checkOut:       z.string().date(),
  excludeRoomId:  z.string().optional(),
  includeVirtual: z.string().optional(),
})), async (c) => {
  try {
    const { checkIn, checkOut, excludeRoomId, includeVirtual } = c.req.valid('query')

    // Habitaciones con reserva (no cancelada) que solapa el rango.
    // Cuentan tanto la habitación principal como las adicionales (extraRoomIds).
    const busyRows = await db
      .select({ roomId: reservations.roomId, extraRoomIds: reservations.extraRoomIds })
      .from(reservations)
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        lt(reservations.checkInDate,  checkOut),
        gt(reservations.checkOutDate, checkIn),
        ne(reservations.status, 'cancelled'),
      ))
    const busyIds = [...new Set(
      busyRows.flatMap(r => [r.roomId, ...(r.extraRoomIds ?? [])]).filter(Boolean)
    )] as number[]

    // Habitaciones con camas bloqueadas en alguna de las fechas del rango
    const dates: string[] = []
    for (let d = new Date(checkIn + 'T12:00:00Z'); d < new Date(checkOut + 'T12:00:00Z'); d.setDate(d.getDate() + 1)) {
      dates.push(d.toISOString().slice(0, 10))
    }
    let blockedIds: number[] = []
    if (dates.length > 0) {
      const blockedRows = await db
        .selectDistinct({ roomId: blockedBeds.roomId })
        .from(blockedBeds)
        .where(and(eq(blockedBeds.propertyId, getPropertyId()), inArray(blockedBeds.blockDate, dates)))
      blockedIds = blockedRows.map(r => r.roomId)
    }

    const excludedIds = [...new Set([...busyIds, ...blockedIds])]
    if (excludeRoomId) excludedIds.push(Number(excludeRoomId))

    const available = await db.query.rooms.findMany({
      where: and(
        eq(rooms.propertyId, getPropertyId()),
        eq(rooms.active, true),
        excludedIds.length > 0 ? notInArray(rooms.id, excludedIds) : undefined,
      ),
      with: { roomType: { columns: { id: true, name: true, isVirtual: true, maxOccupancy: true } } },
    })

    const result = available
      .filter(r => includeVirtual === 'true' || !(r.roomType as any)?.isVirtual)
      .sort((a, b) => {
        const na = parseInt(a.code), nb = parseInt(b.code)
        if (!isNaN(na) && !isNaN(nb)) return na - nb
        if (!isNaN(na)) return -1
        if (!isNaN(nb)) return  1
        return a.code.localeCompare(b.code)
      })

    return c.json({ data: result })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/bed-view?dateFrom=&dateTo= — vista de camas (planning)
app.get('/bed-view', zValidator('query', z.object({
  dateFrom: z.string().date(),
  dateTo:   z.string().date(),
})), async (c) => {
  try {
    const { dateFrom, dateTo } = c.req.valid('query')

    const nights = await db.query.reservationNights.findMany({
      where: and(
        between(reservationNights.date, dateFrom, dateTo),
        eq(reservationNights.cancelled, false),
        inArray(reservationNights.roomId, tenantRoomIds()),
      ),
      with: {
        room: true,
        guest: true,
        reservation: { columns: { id: true, status: true, checkInDate: true, checkOutDate: true, people: true } },
      },
      orderBy: [reservationNights.date, reservationNights.roomId],
    })

    return c.json({ data: nights })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/room-types — lista de tipos de habitación
app.get('/types', async (c) => {
  try {
    const list = await db.query.roomTypes.findMany({
      where: and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true)),
      orderBy: roomTypes.orderIndex,
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/blocked-beds — camas bloqueadas
app.get('/blocked-beds', async (c) => {
  try {
    const list = await db.query.blockedBeds.findMany({
      where: eq(blockedBeds.propertyId, getPropertyId()),
      with: { room: true },
      orderBy: blockedBeds.blockDate,
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/rooms/blocked-beds — bloquear una cama
app.post('/blocked-beds', zValidator('json', z.object({
  roomId:     z.number().int().positive(),
  roomTypeId: z.number().int().positive(),
  bedNumber:  z.string(),
  blockDate:  z.string().date(),
  reason:     z.string().optional(),
  lockedByDirection: z.boolean().optional(),
})), async (c) => {
  try {
    const body = c.req.valid('json')
    if (body.lockedByDirection && !isAdmin(c)) return c.json({ error: 'Solo Dirección puede crear un bloqueo de Dirección' }, 403)
    const createdBy = jwtUserId(c)
    if (!createdBy) return c.json({ error: 'Sesión sin usuario' }, 401)
    if (!(await ownRoom(body.roomId))) return notFound(c, 'Habitación')
    if (!(await ownRoomType(body.roomTypeId))) return notFound(c, 'Tipo de habitación')
    const [created] = await db.insert(blockedBeds).values({
      ...body,
      propertyId: getPropertyId(),
      createdBy,
    }).returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/rooms/blocked-beds/:id — desbloquear cama
app.delete('/blocked-beds/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const [existing] = await db.select({ locked: blockedBeds.lockedByDirection }).from(blockedBeds).where(and(eq(blockedBeds.id, id), eq(blockedBeds.propertyId, getPropertyId())))
    if (existing?.locked && !isAdmin(c)) return c.json({ error: 'Bloqueo de Dirección: solo Dirección puede quitarlo' }, 403)
    const [deleted] = await db.delete(blockedBeds).where(and(eq(blockedBeds.id, id), eq(blockedBeds.propertyId, getPropertyId()))).returning()
    if (!deleted) return notFound(c, 'Bloqueo')
    return c.body(null, 204)
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/:id — detalle de habitación
app.get('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const room = await db.query.rooms.findFirst({
      where: and(eq(rooms.id, id), eq(rooms.propertyId, getPropertyId())),
      with: { roomType: true },
    })
    if (!room) return notFound(c, 'Habitación')
    return c.json({ data: room })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/rooms/:id/qr — QR de acceso del huésped a esta habitación (dirección)
// El token se genera la primera vez que se pide (rooms.qrToken empieza null)
// y luego es estable — el mismo QR físico sirve para siempre en esa
// habitación, ver src/lib/roomAccess.ts y src/routes/room-access.ts.
app.get('/:id/qr', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, id), eq(rooms.propertyId, getPropertyId())), columns: { id: true, code: true } })
    if (!room) return notFound(c, 'Habitación')

    const token = await ensureRoomQrToken(room.id)
    const url = `${env.PUBLIC_URL}/room?t=${token}`
    const qrDataUrl = await QRCode.toDataURL(url, { width: 320, margin: 1 })

    return c.json({ url, qrDataUrl, roomCode: room.code })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── ROOM CRUD ────────────────────────────────────────────────────────────────

const roomSchema = z.object({
  roomTypeId:         z.number().int().positive(),
  code:               z.string().min(1),
  active:             z.boolean().default(true),
  orderIndex:         z.number().int().default(0),
  startingBedNumber:  z.number().int().default(1),
  // Características físicas
  bathroom:           z.enum(['shower','bathtub','both']).optional().nullable(),
  terrace:            z.enum(['private','shared','none']).optional().nullable(),
  balcony:            z.boolean().optional(),
  bedSize:            z.enum(['single','twin','double','queen','king','bunk']).optional().nullable(),
  roomSizeSqm:        z.number().positive().optional().nullable(),
  view:               z.enum(['sea','pool','interior','lateral','street']).optional().nullable(),
  acBrand:            z.string().optional().nullable(),
  tvBrand:            z.string().optional().nullable(),
  lockType:           z.string().optional().nullable(),
  ttlockId:           z.string().optional().nullable(),
  // Override de color (hereda del room type si es null)
  color:              z.string().length(7).optional().nullable(),
  backgroundColor:    z.string().length(7).optional().nullable(),
  fontColor:          z.string().length(7).optional().nullable(),
})

// POST /api/rooms — crear habitación
app.post('/', zValidator('json', roomSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    if (!(await ownRoomType(body.roomTypeId))) return notFound(c, 'Tipo de habitación')
    const [created] = await db.insert(rooms).values({ ...body, propertyId: getPropertyId() } as any).returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/rooms/:id — actualizar habitación
app.patch('/:id', zValidator('json', roomSchema.partial()), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    if (body.roomTypeId && !(await ownRoomType(body.roomTypeId))) return notFound(c, 'Tipo de habitación')
    const [updated] = await db.update(rooms)
      .set({ ...body, updatedAt: new Date() } as any)
      .where(and(eq(rooms.id, id), eq(rooms.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Habitación')
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/rooms/:id — desactivar habitación (soft delete)
app.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(rooms)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(rooms.id, id), eq(rooms.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Habitación')
    return c.body(null, 204)
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── ROOM TYPES CRUD ──────────────────────────────────────────────────────────

const roomTypeSchema = z.object({
  name:           z.string().min(1),
  description:    z.string().optional().nullable(),
  prefix:         z.string().optional().nullable(),
  roomClass:      z.number().int().optional().nullable(),
  maxOccupancy:   z.number().int().min(1).default(2),
  ensuite:        z.boolean().default(true),
  allowExtraBeds: z.number().int().min(0).default(0),
  extraBedPrice:  z.number().min(0).default(0),
  defaultPrice:   z.number().min(0).default(0),
  orderIndex:          z.number().int().default(0),
  bookingEngineLabel:         z.string().optional().nullable(),
  maxOccupancyBookingEngine:  z.number().int().min(1).optional().nullable(),
  isVirtual:                  z.boolean().default(false),
  color:               z.string().length(7).optional().nullable(),
  backgroundColor:     z.string().length(7).optional().nullable(),
  fontColor:           z.string().length(7).optional().nullable(),
  active:              z.boolean().default(true),
  baseRoomTypeId:      z.number().int().positive().optional().nullable(),
  adjustType:          z.enum(['fixed', 'percentage', 'amount']).optional().nullable(),
  adjustValue:         z.number().optional().nullable(),
})

// POST /api/rooms/types — crear tipo de habitación
app.post('/types', zValidator('json', roomTypeSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    if (body.baseRoomTypeId && !(await ownRoomType(body.baseRoomTypeId))) return notFound(c, 'Tipo de habitación base')
    const [created] = await db.insert(roomTypes).values({ ...body, propertyId: getPropertyId() } as any).returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/rooms/types/:id — actualizar tipo
app.patch('/types/:id', zValidator('json', roomTypeSchema.partial()), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    if (body.baseRoomTypeId && !(await ownRoomType(body.baseRoomTypeId))) return notFound(c, 'Tipo de habitación base')
    const [updated] = await db.update(roomTypes)
      .set({ ...body, updatedAt: new Date() } as any)
      .where(and(eq(roomTypes.id, id), eq(roomTypes.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Tipo de habitación')
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/rooms/types/:id — desactivar tipo
app.delete('/types/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(roomTypes)
      .set({ active: false, updatedAt: new Date() })
      .where(and(eq(roomTypes.id, id), eq(roomTypes.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Tipo de habitación')
    return c.body(null, 204)
  } catch (err) {
    return serverError(c, err)
  }
})

export default app
