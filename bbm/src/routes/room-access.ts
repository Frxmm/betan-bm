// ─── Acceso por QR de habitación ────────────────────────────────────────────
// Cada habitación física tiene un QR propio (token opaco, rooms.qrToken —
// nunca el id de la habitación, ver src/lib/roomAccess.ts). Al escanearlo, el
// huésped que esté alojado AHORA en esa habitación (reserva en estado
// checked_in/checking_out, ver findCurrentReservationForRoom) confirma su
// primer apellido y obtiene una sesión corta y acotada a ESA reserva — no es
// el mismo login por email del portal (/api/customer), que da acceso de
// larga duración a TODAS las reservas de ese email. Aquí solo se ve/gestiona
// la estancia actual: detalle, ampliarla, extras, feedback y la petición de
// limpieza del día.
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { rooms, reservations, saleItems, feedbackThreads, housekeepingTasks, roomAccessVisits } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { sign, verify } from 'hono/jwt'
import { env } from '../lib/env'
import { serverError } from '../lib/errors'
import { requireStripe, getStripeCurrency, publicUrl } from '../lib/stripe'
import { getPropertyId, getBranding, runWithProperty } from '../lib/property'
import { quoteExtensionForReservation, MAX_EXTEND_NIGHTS } from '../lib/stayExtension'
import { findCurrentReservationForRoom, normalizeName, isRateLimited, registerFailedAttempt, clearAttempts } from '../lib/roomAccess'
import { realPaidByReservation } from '../lib/paymentAggregate'

const app = new Hono()

async function nowParts() {
  const { timezone } = await getBranding()
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = fmt.formatToParts(new Date())
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}
function addDaysISO(date: string, n: number) {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

// ─── POST /verify — apellido → sesión corta acotada a la reserva ──────────────

app.post('/verify', zValidator('json', z.object({
  token:    z.string().min(1),
  lastName: z.string().min(1).max(100),
})), async (c) => {
  try {
    const { token, lastName } = c.req.valid('json')

    if (isRateLimited(token)) {
      return c.json({ error: 'Demasiados intentos — inténtalo de nuevo en unos minutos o pasa por recepción' }, 429)
    }

    // El tenant se deduce de la fila de la habitación (el token del QR es único global)
    const room = await db.query.rooms.findFirst({ where: eq(rooms.qrToken, token), columns: { id: true, propertyId: true } })
    if (!room) return c.json({ error: 'Código no válido' }, 404)

    return await runWithProperty(room.propertyId, () => verifyInTenant(c, token, lastName, room.id))
  } catch (err) { return serverError(c, err) }
})

async function verifyInTenant(c: any, token: string, lastName: string, roomId: number) {
  try {
    const room = { id: roomId }
    const res = await findCurrentReservationForRoom(room.id)
    const guestLastName = (res as any)?.guest?.lastName as string | undefined
    if (!res || !guestLastName || normalizeName(guestLastName) !== normalizeName(lastName)) {
      registerFailedAttempt(token)
      return c.json({ error: 'No coincide con ninguna reserva activa en esta habitación. Prueba de nuevo o pasa por recepción.' }, 401)
    }
    clearAttempts(token)

    // Sesión válida durante toda la estancia y un margen tras la salida —
    // nunca más de 30 días, por si el check-out quedara muy lejos por error.
    const now      = Math.floor(Date.now() / 1000)
    const checkout = Math.floor(new Date(res.checkOutDate + 'T23:59:00').getTime() / 1000) + 6 * 3600
    const exp      = Math.min(now + 30 * 24 * 3600, Math.max(now + 3600, checkout))

    const jwt = await sign(
      { sub: String(res.id), roomId: room.id, propertyId: getPropertyId(), type: 'room-guest', iat: now, exp },
      env.JWT_SECRET, 'HS256',
    )

    return c.json({ token: jwt, reservationId: res.id })
  } catch (err) { return serverError(c, err) }
}

// ─── Middleware: sesión de huésped por habitación ──────────────────────────────

app.use('*', async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'No autorizado' }, 401)
  try {
    const payload = await verify(auth.slice(7), env.JWT_SECRET, 'HS256') as any
    if (payload.type !== 'room-guest') return c.json({ error: 'Token inválido' }, 401)
    // El tenant viaja dentro del JWT (firmado por el servidor en /verify)
    const pid = Number(payload.propertyId)
    if (!pid) return c.json({ error: 'Sesión antigua — vuelve a escanear el QR' }, 401)
    c.set('roomReservationId', Number(payload.sub))
    c.set('roomId', Number(payload.roomId))
    return await runWithProperty(pid, () => next())
  } catch {
    return c.json({ error: 'Sesión inválida o caducada' }, 401)
  }
})

async function currentReservation(c: any) {
  const id = c.get('roomReservationId') as number
  return db.query.reservations.findFirst({
    where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    with: { room: true, rate: true, bookingChannel: true, transactions: true, guest: true },
  })
}

// ─── GET /reservation — detalle de la estancia actual ─────────────────────────

app.get('/reservation', async (c) => {
  try {
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    // "Pagado" al huésped no debe incluir depósitos retenidos sin cobrar
    // (paymentMethod 'deposit'/'deposit_cc' hasta que se cobran de verdad) —
    // reservations.amountPaid sí los incluye, ver src/lib/paymentAggregate.ts.
    const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    // Una visita por carga de página (este endpoint se llama una sola vez al
    // montar la pantalla de la estancia, ver RoomStay en frontend-public/room.tsx)
    // — para el informe "Uso QR habitaciones". No debe romper la respuesta al
    // huésped si falla por lo que sea.
    const roomId = c.get('roomId') as number
    db.insert(roomAccessVisits).values({ propertyId: getPropertyId(), roomId, reservationId: res.id })
      .then(() => {}, err => console.error('[room-access] no se pudo registrar la visita', err))
    return c.json({ data: { ...res, amountPaid: realPaid.toFixed(2) } })
  } catch (err) { return serverError(c, err) }
})

// ─── Ampliar estancia — misma lógica que el portal por email ──────────────────

app.get('/extend-quote', zValidator('query', z.object({
  nights: z.coerce.number().int().min(1).max(MAX_EXTEND_NIGHTS),
})), async (c) => {
  try {
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    const { nights } = c.req.valid('query')
    const q = await quoteExtensionForReservation(res, nights)
    if ('error' in q) return c.json({ error: q.error }, q.status)
    return c.json({ nights: q.nights, newCheckOutDate: q.newCheckOutDate, perNight: q.perNight, total: q.total })
  } catch (err) { return serverError(c, err) }
})

app.post('/extend', zValidator('json', z.object({
  nights: z.number().int().min(1).max(MAX_EXTEND_NIGHTS),
})), async (c) => {
  try {
    const s   = await requireStripe()
    const branding = await getBranding()
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    const { nights } = c.req.valid('json')

    const q = await quoteExtensionForReservation(res, nights)
    if ('error' in q) return c.json({ error: q.error }, q.status)

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:              await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:    await getStripeCurrency(),
          unit_amount: Math.round(q.total * 100),
          product_data: {
            name:        `Ampliación de estancia — ${nights} noche${nights === 1 ? '' : 's'}`,
            description: `Reserva #${res.id} · nueva salida ${q.newCheckOutDate}`,
          },
        },
      }],
      customer_email: (res as any).guest?.email || undefined,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId:   String(res.id),
        type:            'extend_stay',
        nights:          String(nights),
        newCheckOutDate: q.newCheckOutDate,
      },
      success_url: publicUrl(branding, `/room?payment_ok=1`),
      cancel_url:  publicUrl(branding, `/room`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── Extras ─────────────────────────────────────────────────────────────────

app.post('/extras', zValidator('json', z.object({
  extras: z.array(z.object({
    saleItemId: z.number().int().positive(),
    quantity:   z.number().int().min(1),
  })).min(1),
})), async (c) => {
  try {
    const s   = await requireStripe()
    const branding = await getBranding()
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    if (['cancelled', 'no_show', 'checked_out'].includes(res.status)) {
      return c.json({ error: 'Esta reserva ya no admite extras' }, 422)
    }
    const body = c.req.valid('json')

    const extraIds = body.extras.map(e => e.saleItemId)
    const items = await db.select().from(saleItems).where(and(
      eq(saleItems.propertyId, getPropertyId()),
      eq(saleItems.activeForBookingEngine, true),
      eq(saleItems.active, true),
    ))
    const itemsById = new Map(items.filter(i => extraIds.includes(i.id)).map(i => [i.id, i]))

    const nights = res.nights as number
    const people  = res.people as number

    let detail: { i: number; q: number; u: number; title: string }[] = []
    for (const req of body.extras) {
      const item = itemsById.get(req.saleItemId)
      if (!item || !item.defaultPrice) continue
      const base = parseFloat(item.defaultPrice)
      const qty  = Math.min(req.quantity, item.maxQuantity ?? 1)
      let unit: number
      switch (item.pricingType) {
        case 'per_night':        unit = base * nights; break
        case 'per_person':       unit = base * people; break
        case 'per_person_night': unit = base * people * nights; break
        default:                 unit = base
      }
      detail.push({ i: item.id, q: qty, u: unit, title: item.title })
    }
    if (detail.length === 0) return c.json({ error: 'Extras no válidos' }, 422)

    const cur = await getStripeCurrency()
    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:             await getStripeCurrency(),
      line_items: detail.map(d => ({
        quantity: d.q,
        price_data: { currency: cur, unit_amount: Math.round(d.u * 100), product_data: { name: d.title } },
      })),
      customer_email: (res as any).guest?.email || undefined,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(res.id),
        type:          'extra_purchase',
        extras:        JSON.stringify(detail.map(d => ({ i: d.i, q: d.q, u: d.u }))),
      },
      success_url: publicUrl(branding, `/room?payment_ok=1`),
      cancel_url:  publicUrl(branding, `/room`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── Feedback ───────────────────────────────────────────────────────────────

const FEEDBACK_SENTIMENTS = ['positive', 'neutral', 'complaint', 'suggestion'] as const

app.post('/feedback', zValidator('json', z.object({
  text:      z.string().min(1).max(2000),
  sentiment: z.enum(FEEDBACK_SENTIMENTS),
})), async (c) => {
  try {
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    const body = c.req.valid('json')

    await db.insert(feedbackThreads).values({
      propertyId: getPropertyId(), reservationId: res.id, guestId: res.guestId,
      channel: 'portal', source: 'guest', sentiment: body.sentiment, text: body.text, category: 'otro',
    })

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// ─── Petición de limpieza del día ───────────────────────────────────────────
// Solo deja una nota en la tarea de HOY de esta habitación (housekeeping_tasks
// — una fila por habitación y día) — el personal decide cómo atenderla, no
// cambia el estado/dnd de la tarea automáticamente. Se deshabilita a partir
// de las 14:00 (hora local del hotel) del día anterior a la salida, para no
// interferir con la limpieza de cambio de huésped.
const HOUSEKEEPING_REQUEST_LABEL: Record<string, string> = {
  clean:        'Limpieza normal',
  dnd:          'No molestar',
  towels_only:  'Solo toallas',
}

async function housekeepingRequestCutoffOk(checkOutDate: string): Promise<boolean> {
  const cutoffDate = addDaysISO(checkOutDate, -1)
  const now = await nowParts()
  if (now.date < cutoffDate) return true
  if (now.date === cutoffDate && now.hour < 14) return true
  return false
}

app.get('/housekeeping-today', async (c) => {
  try {
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    const roomId = c.get('roomId') as number
    const today = (await nowParts()).date

    const allowed = await housekeepingRequestCutoffOk(res.checkOutDate)
    const task = await db.query.housekeepingTasks.findFirst({
      where: and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.date, today), eq(housekeepingTasks.roomId, roomId)),
      columns: { notes: true },
    })

    return c.json({ allowed, notes: task?.notes ?? null })
  } catch (err) { return serverError(c, err) }
})

app.post('/housekeeping-request', zValidator('json', z.object({
  type: z.enum(['clean', 'dnd', 'towels_only']),
})), async (c) => {
  try {
    const res = await currentReservation(c)
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    const roomId = c.get('roomId') as number
    const { type } = c.req.valid('json')

    if (!await housekeepingRequestCutoffOk(res.checkOutDate)) {
      return c.json({ error: 'Ya no se puede cambiar la petición de limpieza para el resto de tu estancia' }, 422)
    }

    const today = (await nowParts()).date
    const time  = new Intl.DateTimeFormat('es-ES', { timeZone: (await getBranding()).timezone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date())
    const line  = `🙋 Petición del huésped (${time}): ${HOUSEKEEPING_REQUEST_LABEL[type]}`

    const existing = await db.query.housekeepingTasks.findFirst({
      where: and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.date, today), eq(housekeepingTasks.roomId, roomId)),
    })
    if (existing) {
      const merged = existing.notes ? `${existing.notes}\n${line}` : line
      await db.update(housekeepingTasks).set({ notes: merged, updatedAt: new Date() }).where(and(eq(housekeepingTasks.id, existing.id), eq(housekeepingTasks.propertyId, getPropertyId())))
    } else {
      await db.insert(housekeepingTasks).values({ propertyId: getPropertyId(), date: today, roomId, taskType: 'stay', notes: line })
    }

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

export default app
