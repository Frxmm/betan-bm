// ─── Integración directa con Jumbo (sin pasar por el channel manager) ─────────
// Llamado por un proceso externo que lee los emails de Jumbo/JumboBeds por Gmail
// y, en vez de crear/cancelar la reserva en FDM, llama aquí para escribirla
// directo en nuestra base de datos.
//
// Auth: token estático por cabecera (no JWT, no login). El token identifica al
// TENANT: secreto JUMBO_INTEGRATION_TOKEN del tenant (settings secrets.*; admite
// varios separados por coma) y requiere el módulo 'jumbo'. Mismo patrón que
// src/routes/voice-brief.ts. Montado ANTES de requireAuth en index.ts, así que
// resuelve el tenant aquí.
// Settings por tenant: jumbo.channelId (canal de reserva; si falta, canal cuyo
// nombre contiene "jumbo").
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { timingSafeEqual } from 'node:crypto'
import { db } from '../db'
import { reservations, guests, reservationNights, reservationNotes, rooms, roomTypes, bookingChannels, rates, blockedBeds, properties } from '../db/schema'
import { eq, and, gte, ilike, inArray } from 'drizzle-orm'
import { env } from '../lib/env'
import { notFound, serverError } from '../lib/errors'
import { runWithProperty, getPropertyId, hasFeature, getSetting, settingOf } from '../lib/property'
import { hasRoomOverlap, tenantCurrencyId } from './reservations'

const app = new Hono()

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function resolveJumboTenant(token: string | undefined): Promise<number | null> {
  if (!token) return null
  const rows = await db.select().from(properties).where(eq(properties.active, true))
  for (const p of rows) {
    const tokens = (settingOf<string>(p, 'secrets.JUMBO_INTEGRATION_TOKEN') ?? '').split(',').map(t => t.trim()).filter(Boolean)
    if (tokens.some(t => safeEq(t, token))) return p.id
  }
  if (process.env.ALLOW_ENV_SECRET_FALLBACK === '1' && env.JUMBO_INTEGRATION_TOKEN && safeEq(env.JUMBO_INTEGRATION_TOKEN, token) && rows.length === 1) {
    return rows[0]!.id
  }
  return null
}

app.use('*', async (c, next) => {
  const pid = await resolveJumboTenant(c.req.header('Authorization')?.replace('Bearer ', ''))
  if (!pid) return c.json({ error: 'No autorizado' }, 401)
  return runWithProperty(pid, async () => {
    if (!await hasFeature('jumbo')) return c.json({ error: 'Módulo no activado' }, 404)
    return next()
  })
})

// Misma regla que STANDARD_RATE en jumbo_integration.py — si la tarifa
// original era "Standard rate" (ES/EN/FR/DE), la cancelación es sin gastos;
// cualquier otra (no reembolsable) se cancela CON gastos, el cargo se
// mantiene y hay que revisarlo a mano.
const STANDARD_RATE = /standard rate|tarifa est[aá]ndar|taux standard|standardpreis/i
const ROOM_ONLY      = /room only|solo habitaci[oó]n|nur [uü]bernachtung|logement seul/i
const WANTS_SINGLE   = /single|individual/i

async function jumboChannelId(): Promise<number | null> {
  const configured = await getSetting<number>('jumbo.channelId')
  if (configured) return Number(configured)
  const row = await db.query.bookingChannels.findFirst({
    where: and(eq(bookingChannels.propertyId, getPropertyId()), ilike(bookingChannels.name, '%jumbo%')),
  })
  return row?.id ?? null
}

// Busca una habitación libre para esas fechas — primero del tipo que pide la
// tarifa (individual/doble), y si no hay, cualquier otra libre. La
// disponibilidad se comprueba con hasRoomOverlap (reservations.ts) — la
// MISMA función que usa el resto de la app (crear/editar reserva desde el
// panel) — no con reservation_nights, que no es la fuente real de "esta
// habitación ya tiene reserva ese día" (ese era el bug: podía asignar una
// habitación ya ocupada si sus noches no estaban en esa tabla). Además se
// excluyen las habitaciones bloqueadas (blocked_beds) en alguna noche del
// rango — hasRoomOverlap NO mira esa tabla (solo solapamiento de reservas),
// así que sin este filtro aparte Jumbo podía acabar asignando una habitación
// bloqueada (mantenimiento, fuera de servicio...) sin que nadie lo pidiera.
type RoomRow = { id: number; code: string; roomTypeId: number }

async function blockedRoomIds(checkIn: string, checkOut: string): Promise<Set<number>> {
  const dates: string[] = []
  for (let d = new Date(checkIn + 'T12:00:00Z'); d < new Date(checkOut + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10))
  }
  if (dates.length === 0) return new Set()
  const rows = await db.selectDistinct({ roomId: blockedBeds.roomId })
    .from(blockedBeds)
    .where(and(eq(blockedBeds.propertyId, getPropertyId()), inArray(blockedBeds.blockDate, dates)))
  return new Set(rows.map(r => r.roomId))
}

async function firstFreeRoom(rows: RoomRow[], checkIn: string, checkOut: string, blocked: Set<number>): Promise<RoomRow | null> {
  for (const r of rows) {
    if (blocked.has(r.id)) continue
    const overlap = await hasRoomOverlap(r.id, checkIn, checkOut)
    if (!overlap) return r
  }
  return null
}

async function findAvailableRoom(checkIn: string, checkOut: string, wantsSingle: boolean) {
  const blocked = await blockedRoomIds(checkIn, checkOut)

  const preferredRows = await db.select({ id: rooms.id, code: rooms.code, roomTypeId: rooms.roomTypeId })
    .from(rooms)
    .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
    .where(and(
      eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true),
      wantsSingle ? eq(roomTypes.maxOccupancy, 1) : gte(roomTypes.maxOccupancy, 2),
    ))
    .orderBy(rooms.code)
  const preferred = await firstFreeRoom(preferredRows, checkIn, checkOut, blocked)
  if (preferred) return preferred

  const anyRows = await db.select({ id: rooms.id, code: rooms.code, roomTypeId: rooms.roomTypeId })
    .from(rooms)
    .where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)))
    .orderBy(rooms.code)
  return firstFreeRoom(anyRows, checkIn, checkOut, blocked)
}

// Empareja la tarifa de Jumbo (texto libre, ES/EN/FR/DE) con una tarifa
// nuestra por título — ROOM ONLY vs BED & BREAKFAST. Aproximado: conviene
// revisar los títulos reales de "rates" la primera vez que se use de verdad.
async function findRateId(tarifaText: string): Promise<number | null> {
  const pattern = ROOM_ONLY.test(tarifaText) ? '%room only%' : '%breakfast%'
  const row = await db.query.rates.findFirst({
    where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true), ilike(rates.title, pattern)),
  })
  return row?.id ?? null
}

// ── GET /reservations/:code — ¿existe ya esta reserva? ─────────────────────
app.get('/reservations/:code', async (c) => {
  try {
    const code = c.req.param('code')
    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.externalCode, code), eq(reservations.propertyId, getPropertyId())) })
    return c.json({ data: res ? { exists: true, reservationId: res.id, status: res.status } : { exists: false } })
  } catch (err) { return serverError(c, err) }
})

// ── POST /reservations — crear reserva nueva a partir del email de Jumbo ───
const createSchema = z.object({
  code:         z.string().min(1),
  firstName:    z.string().min(1),
  lastName:     z.string().min(1),
  checkInDate:  z.string().date(),
  checkOutDate: z.string().date(),
  nights:       z.number().int().min(1),
  adults:       z.number().int().min(1).default(1),
  tarifa:       z.string().min(1),
  total:        z.number().min(0),
})

app.post('/reservations', zValidator('json', createSchema), async (c) => {
  try {
    const body = c.req.valid('json')

    const existing = await db.query.reservations.findFirst({ where: and(eq(reservations.externalCode, body.code), eq(reservations.propertyId, getPropertyId())) })
    if (existing) return c.json({ error: 'Esa reserva ya existe', data: { reservationId: existing.id } }, 409)

    const channelId = await jumboChannelId()
    if (!channelId) return c.json({ error: 'No se encuentra el canal Jumbo (setting jumbo.channelId o canal con "jumbo" en el nombre)' }, 422)
    const currencyId = await tenantCurrencyId()

    // Sin disponibilidad: se crea igual SIN habitación asignada (roomId null)
    // en vez de rechazarla — mismo criterio que la importación de FDM
    // (pickRoom devuelve null ahí también y la reserva se crea igual). La
    // alerta genérica "unassigned-room" (src/routes/alerts.ts) ya avisa sola
    // de cualquier reserva sin habitación con check-in próximo, sea el canal
    // que sea — no hace falta una alerta aparte solo para Jumbo.
    const room = await findAvailableRoom(body.checkInDate, body.checkOutDate, WANTS_SINGLE.test(body.tarifa))

    const rateId = await findRateId(body.tarifa)

    const [guest] = await db.insert(guests).values({
      propertyId: getPropertyId(), firstName: body.firstName, lastName: body.lastName,
    }).returning({ id: guests.id })

    const [reservation] = await db.insert(reservations).values({
      propertyId: getPropertyId(), externalCode: body.code, status: 'confirmed',
      checkInDate: body.checkInDate, checkOutDate: body.checkOutDate, nights: body.nights,
      guestId: guest!.id, people: body.adults,
      bookingChannelId: channelId, rateId: rateId ?? undefined, roomId: room?.id ?? null,
      currencyId: currencyId, total: String(body.total),
    }).returning({ id: reservations.id })

    // reservation_nights exige room_id/room_type_id NOT NULL — sin habitación
    // asignada simplemente no se generan (igual que la importación de FDM,
    // que tampoco las usa); no son la fuente real de disponibilidad, solo de
    // precio/informes por noche, así que no bloquea nada dejarlas sin crear
    // hasta que alguien le asigne una habitación a mano.
    if (room) {
      const pricePerNight = Math.round((body.total / body.nights) * 100) / 100
      const nightRows = []
      const cur = new Date(body.checkInDate + 'T12:00:00Z')
      const end = new Date(body.checkOutDate + 'T12:00:00Z')
      while (cur < end) {
        nightRows.push({
          reservationId: reservation!.id, date: cur.toISOString().slice(0, 10), guestId: guest!.id,
          roomId: room.id, roomTypeId: room.roomTypeId,
          price: String(pricePerNight), commission: '0', currencyId: currencyId, isOriginal: true,
        })
        cur.setUTCDate(cur.getUTCDate() + 1)
      }
      await db.insert(reservationNights).values(nightRows as any)
    }

    await db.insert(reservationNotes).values({
      reservationId: reservation!.id,
      note: room
        ? `Reserva creada por integración directa de Jumbo (sin pasar por el channel manager) — tipo de tarifa: "${body.tarifa}"`
        : `⚠ Reserva creada por integración directa de Jumbo SIN HABITACIÓN ASIGNADA (no había disponibilidad para esas fechas) — tipo de tarifa: "${body.tarifa}", asignar a mano`,
      type: 'change',
    })

    return c.json({ data: { reservationId: reservation!.id, roomCode: room?.code ?? null } }, 201)
  } catch (err) { return serverError(c, err) }
})

// ── POST /reservations/:code/cancel ─────────────────────────────────────────
const cancelSchema = z.object({ tarifa: z.string().min(1) })

app.post('/reservations/:code/cancel', zValidator('json', cancelSchema), async (c) => {
  try {
    const code = c.req.param('code')
    const { tarifa } = c.req.valid('json')

    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.externalCode, code), eq(reservations.propertyId, getPropertyId())) })
    if (!res) return notFound(c, 'Reserva')

    const sinGastos = STANDARD_RATE.test(tarifa)
    await db.update(reservations).set({ status: 'cancelled', updatedAt: new Date() }).where(and(eq(reservations.id, res.id), eq(reservations.propertyId, getPropertyId())))

    const note = sinGastos
      ? `Cancelación Jumbo SIN GASTOS — tarifa original: "${tarifa}" (tarifa estándar, cancelación gratuita)`
      : `⚠ Cancelación Jumbo CON GASTOS — tarifa original: "${tarifa}" (no reembolsable, el cargo se mantiene) — revisar cobro`
    await db.insert(reservationNotes).values({ reservationId: res.id, note, type: 'change' })

    return c.json({ data: { reservationId: res.id, status: 'cancelled', sinGastos } })
  } catch (err) { return serverError(c, err) }
})

export default app
