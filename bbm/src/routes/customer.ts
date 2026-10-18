import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, guests, saleItems, feedbackThreads, rooms } from '../db/schema'
import { eq, and, desc, inArray } from 'drizzle-orm'
import { getPropertyId, getBranding, runWithProperty } from '../lib/property'
import { getStripeCurrency, publicUrl } from '../lib/stripe'
import { fromOf } from '../lib/email'
import { verify, sign } from 'hono/jwt'
import { env } from '../lib/env'
import { serverError } from '../lib/errors'
import { requireStripe } from '../lib/stripe'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import { quoteExtensionForReservation, MAX_EXTEND_NIGHTS } from '../lib/stayExtension'
import { Resend } from 'resend'
import MUNICIPALITIES from '../../frontend/data/municipalities.json'

const MUNI_LIST = MUNICIPALITIES as { code: string; name: string }[]

const resend     = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

// Huésped del tenant por email (siempre acotado al tenant del token)
const guestByEmail = (email: string) => db.query.guests.findFirst({
  where: and(eq(guests.email, email), eq(guests.propertyId, getPropertyId())),
})
// Reserva del huésped acotada al tenant
const ownRes = (id: number, guestId: number) =>
  and(eq(reservations.id, id), eq(reservations.guestId, guestId), eq(reservations.propertyId, getPropertyId()))

const app = new Hono()

const BOOKING_ALIAS = /@guest\.booking\.com$/i

// Códigos de las habitaciones adicionales (extraRoomIds) de un conjunto de
// reservas — no existe relación de Drizzle para esto (jsonb, no FK), así que
// se resuelve con una consulta aparte, igual que ya hace el listado de
// reservas del panel (src/routes/reservations.ts). El huésped solo veía la
// habitación principal hasta ahora, nunca cuántas más tenía.
async function resolveExtraRoomCodes(resList: { extraRoomIds?: unknown }[]): Promise<Map<number, string>> {
  const ids = [...new Set(resList.flatMap(r => ((r.extraRoomIds ?? []) as number[])))]
  if (ids.length === 0) return new Map()
  const rows = await db.select({ id: rooms.id, code: rooms.code }).from(rooms).where(and(inArray(rooms.id, ids), eq(rooms.propertyId, getPropertyId())))
  return new Map(rows.map(r => [r.id, r.code]))
}

// ─── Middleware: customer JWT ──────────────────────────────────────────────────

app.use('*', async (c, next) => {
  const auth = c.req.header('Authorization')
  if (!auth?.startsWith('Bearer ')) return c.json({ error: 'No autorizado' }, 401)
  try {
    const payload = await verify(auth.slice(7), env.JWT_SECRET, 'HS256') as any
    if (payload.type !== 'customer') return c.json({ error: 'Token inválido' }, 401)
    // El tenant viaja DENTRO del JWT (lo firma el servidor al verificar el magic link)
    const pid = Number(payload.propertyId)
    if (!pid) return c.json({ error: 'Sesión antigua — vuelve a pedir tu enlace de acceso' }, 401)
    c.set('customerEmail', payload.sub as string)
    return await runWithProperty(pid, () => next())
  } catch {
    return c.json({ error: 'Token inválido o expirado' }, 401)
  }
})

// ─── GET /api/customer/me ──────────────────────────────────────────────────────

app.get('/me', async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const guest = await db.query.guests.findFirst({
      where: eq(guests.email, email),
    })
    return c.json({ email, guest: guest ?? null })
  } catch (err) { return serverError(c, err) }
})

// ─── PATCH /api/customer/email — sustituir email temporal de Booking por el real

app.patch('/email', zValidator('json', z.object({
  email: z.string().email(),
})), async (c) => {
  try {
    const current  = c.get('customerEmail') as string
    const newEmail = c.req.valid('json').email.trim().toLowerCase()

    if (BOOKING_ALIAS.test(newEmail)) {
      return c.json({ error: 'Introduce tu email real, no el temporal de Booking.com' }, 422)
    }

    const guest = await guestByEmail(current)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    // guests.email no tiene constraint UNIQUE — si ya pertenece a otro huésped, no
    // lo permitimos: fusionar identidades por email abriría un IDOR entre reservas
    const other = await guestByEmail(newEmail)
    if (other && other.id !== guest.id) {
      return c.json({ error: 'Ese email ya está en uso por otra reserva. Contacta con recepción.' }, 409)
    }

    await db.update(guests).set({ email: newEmail }).where(and(eq(guests.id, guest.id), eq(guests.propertyId, getPropertyId())))

    const now = Math.floor(Date.now() / 1000)
    const jwt = await sign(
      { sub: newEmail, type: 'customer', propertyId: getPropertyId(), iat: now, exp: now + 30 * 24 * 3600 },
      env.JWT_SECRET,
      'HS256',
    )

    return c.json({ ok: true, token: jwt, email: newEmail })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/customer/reservations ───────────────────────────────────────────

app.get('/reservations', async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const guest = await guestByEmail(email)
    if (!guest) return c.json({ data: [] })

    const list = await db.query.reservations.findMany({
      where:   and(eq(reservations.guestId, guest.id), eq(reservations.propertyId, getPropertyId())),
      with:    { room: true, rate: true, bookingChannel: true },
      orderBy: desc(reservations.checkInDate),
    })

    const codeById = await resolveExtraRoomCodes(list)
    const data = list.map(r => ({
      ...r,
      extraRoomCodes: ((r.extraRoomIds ?? []) as number[]).map(id => codeById.get(id) ?? `#${id}`),
    }))

    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/customer/reservations/:id ───────────────────────────────────────

app.get('/reservations/:id', async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
      with:  { room: true, rate: true, bookingChannel: true, transactions: true },
    })

    if (!res) return c.json({ error: 'No encontrado' }, 404)

    const codeById = await resolveExtraRoomCodes([res])
    const extraRoomCodes = ((res.extraRoomIds ?? []) as number[]).map(id => codeById.get(id) ?? `#${id}`)

    return c.json({ data: { ...res, extraRoomCodes } })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/customer/reservations/:id/checkin — check-in online ────────────

const ISO2 = /^[A-Z]{2}$/

app.post('/reservations/:id/checkin', zValidator('json', z.object({
  documentType:   z.enum(['dni', 'nie', 'passport', 'driving_licence', 'other']),
  documentNumber: z.string().min(1).max(30).trim().transform(s => s.toUpperCase()),
  nationality:    z.string().regex(ISO2, 'Código de país inválido (2 letras ISO)').optional(),
  birthDate:      z.string().date().optional(),
  arrivalTime:    z.string().regex(/^\d{2}:\d{2}$/).optional(),
  address1:           z.string().max(200).trim().optional(),
  zipCode:            z.string().max(12).trim().optional(),
  city:               z.string().max(100).trim().optional(),
  addressCountryCode: z.string().regex(ISO2, 'Código de país inválido (2 letras ISO)').optional(),
}).superRefine((data, ctx) => {
  const doc = data.documentNumber
  if (data.documentType === 'dni' && !/^\d{8}[A-Z]$/.test(doc)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'DNI inválido (8 dígitos + letra)' })
  }
  if (data.documentType === 'nie' && !/^[XYZ]\d{7}[A-Z]$/.test(doc)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'NIE inválido (X/Y/Z + 7 dígitos + letra)' })
  }
  if (['passport', 'driving_licence'].includes(data.documentType) && !/^[A-Z0-9]{3,20}$/.test(doc)) {
    ctx.addIssue({ code: 'custom', path: ['documentNumber'], message: 'Número de documento inválido' })
  }
  if (data.birthDate) {
    const bd   = new Date(data.birthDate)
    const now  = new Date()
    const age  = (now.getTime() - bd.getTime()) / (365.25 * 24 * 3600 * 1000)
    if (bd >= now)    ctx.addIssue({ code: 'custom', path: ['birthDate'], message: 'La fecha de nacimiento debe ser anterior a hoy' })
    if (age > 120)    ctx.addIssue({ code: 'custom', path: ['birthDate'], message: 'Fecha de nacimiento no válida' })
  }
})), async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))
    const body  = c.req.valid('json')

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    if (!['confirmed', 'arriving', 'tentative'].includes(res.status)) {
      return c.json({ error: 'La reserva no está en estado válido para check-in' }, 422)
    }

    // Código INE si la dirección es española y el municipio casa con el catálogo
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    const ineCode = body.addressCountryCode === 'ES' && body.city
      ? (MUNI_LIST.find(m => norm(m.name) === norm(body.city!))?.code ?? null)
      : null

    // Actualizar datos del huésped titular
    await db.update(guests).set({
      idDocType:    body.documentType as any,
      idDocNumber:  body.documentNumber,
      nationality:  body.nationality ?? null,
      dateOfBirth:  body.birthDate   ?? null,
      ...(body.address1           ? { address1: body.address1 } : {}),
      ...(body.zipCode            ? { zipCode: body.zipCode } : {}),
      ...(body.city               ? { city: body.city } : {}),
      ...(body.addressCountryCode ? { addressCountryCode: body.addressCountryCode } : {}),
      ...(ineCode                 ? { cityIneCode: ineCode } : {}),
    } as any).where(and(eq(guests.id, guest.id), eq(guests.propertyId, getPropertyId())))

    // Marcar check-in online en la reserva
    const updates: any = { onlineCheckIn: true, updatedAt: new Date() }
    if (body.arrivalTime) updates.arrivalTime = body.arrivalTime

    await db.update(reservations).set(updates).where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/customer/reservations/:id/invoice ───────────────────────────────

app.get('/reservations/:id/invoice', async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
      with:  { invoices: true },
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    return c.json({ data: (res as any).invoices ?? [] })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/customer/reservations/:id/request-invoice ──────────────────────

app.post('/reservations/:id/request-invoice',
  zValidator('json', z.object({
    billingName:    z.string().min(1, 'El nombre es obligatorio'),
    billingNif:     z.string().min(1, 'El NIF/CIF es obligatorio'),
    billingAddress: z.string().min(1, 'La dirección es obligatoria'),
  })),
  async (c) => {
    try {
      const email = c.get('customerEmail') as string
      const id    = parseInt(c.req.param('id'))
      const body  = c.req.valid('json')

      const guest = await guestByEmail(email)
      if (!guest) return c.json({ error: 'No encontrado' }, 404)

      const res = await db.query.reservations.findFirst({
        where: ownRes(id, guest.id),
      })
      if (!res) return c.json({ error: 'No encontrado' }, 404)

      await db.update(reservations)
        .set({ billingName: body.billingName, billingNif: body.billingNif, billingAddress: body.billingAddress } as any)
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

      const branding = await getBranding()
      if (resend && branding.receptionEmail) {
        await resend.emails.send({
          from:    fromOf(branding),
          to:      branding.receptionEmail,
          subject: `Solicitud de factura — Reserva #${id}`,
          html: `<p>El cliente <strong>${guest.firstName} ${guest.lastName}</strong> (${email}) ha solicitado factura para la reserva <strong>#${id}</strong> (${res.checkInDate} → ${res.checkOutDate}).</p>
<table style="border-collapse:collapse;margin-top:12px">
  <tr><td style="padding:4px 12px 4px 0"><strong>Nombre / Razón social</strong></td><td>${body.billingName}</td></tr>
  <tr><td style="padding:4px 12px 4px 0"><strong>NIF / CIF</strong></td><td>${body.billingNif}</td></tr>
  <tr><td style="padding:4px 12px 4px 0"><strong>Dirección</strong></td><td>${body.billingAddress}</td></tr>
</table>`,
        }).catch(() => {})
      }

      return c.json({ ok: true })
    } catch (err) { return serverError(c, err) }
  }
)

// ─── POST /api/customer/reservations/:id/pay — sesión Stripe para saldo pendiente

app.post('/reservations/:id/pay', async (c) => {
  try {
    const s     = await requireStripe()
    const branding = await getBranding()
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
      with: { rate: true },
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    if (['cancelled', 'no_show'].includes(res.status)) {
      return c.json({ error: 'La reserva no está activa' }, 422)
    }

    // No cuenta los depósitos retenidos sin cobrar como pago de la estancia
    // (ver src/lib/paymentAggregate.ts) — si no, el huésped podría no poder
    // pagar online lo que realmente debe, o pagar de menos.
    const realPaid   = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const pending    = Math.round(calcPendingBalance(res.total, realPaid) * 100) // centimos
    if (pending <= 0) return c.json({ error: 'No hay importe pendiente' }, 422)

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:             await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:    await getStripeCurrency(),
          unit_amount: pending,
          product_data: {
            name:        `${branding.name} — Pago de reserva`,
            description: `Reserva #${id} · ${res.checkInDate} → ${res.checkOutDate}`,
          },
        },
      }],
      customer_email: email,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(id),
        type:          'pending_payment',
      },
      success_url: publicUrl(branding, `/portal?payment_ok=1`),
      cancel_url:  publicUrl(branding, `/portal`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/customer/reservations/:id/extras — añadir y pagar extras ───────

app.post('/reservations/:id/extras', zValidator('json', z.object({
  extras: z.array(z.object({
    saleItemId: z.number().int().positive(),
    quantity:   z.number().int().min(1),
  })).min(1),
})), async (c) => {
  try {
    const s     = await requireStripe()
    const branding = await getBranding()
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))
    const body  = c.req.valid('json')

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)
    if (['cancelled', 'no_show', 'checked_out'].includes(res.status)) {
      return c.json({ error: 'Esta reserva ya no admite extras' }, 422)
    }

    const extraIds = body.extras.map(e => e.saleItemId)
    const items = await db.select().from(saleItems).where(and(
      eq(saleItems.propertyId, getPropertyId()),
      eq(saleItems.activeForBookingEngine, true),
      eq(saleItems.active, true),
      inArray(saleItems.id, extraIds),
    ))

    // Noches que quedan por cobrar (de hoy al checkout), no las de la estancia
    // completa — si compra el desayuno en el día 3 de 7, solo paga lo que
    // queda, no los días que ya pasaron. Si todavía no ha hecho check-in, es
    // sencillamente el total de la estancia.
    const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
    const start  = todayMadrid > res.checkInDate ? todayMadrid : res.checkInDate
    const nights = Math.max(0, Math.round((new Date(res.checkOutDate + 'T12:00:00').getTime() - new Date(start + 'T12:00:00').getTime()) / 86400000))
    const people = res.people as number

    let extrasTotal = 0
    const detail: { i: number; q: number; u: number; title: string }[] = []
    for (const req of body.extras) {
      const item = items.find(i => i.id === req.saleItemId)
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
      extrasTotal += unit * qty
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
        price_data: {
          currency:     cur,
          unit_amount:  Math.round(d.u * 100),
          product_data: { name: d.title },
        },
      })),
      customer_email: email,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(id),
        type:          'extra_purchase',
        extras:        JSON.stringify(detail.map(d => ({ i: d.i, q: d.q, u: d.u }))),
      },
      success_url: publicUrl(branding, `/portal?payment_ok=1`),
      cancel_url:  publicUrl(branding, `/portal`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── Ampliar estancia (añadir noches al final) ─────────────────────────────────
// Solo para reservas de una habitación (sin extraRoomIds — las de grupo no
// tienen precio por habitación en este sistema, se gestionan a mano por
// recepción) y SOLO cuando la reserva ya está pagada al 100% (sin contar
// depósitos retenidos sin cobrar, ver src/lib/paymentAggregate.ts). Lógica de
// cotización compartida con el acceso por QR de habitación, ver
// src/lib/stayExtension.ts.

// GET /api/customer/reservations/:id/extend-quote?nights=N
app.get('/reservations/:id/extend-quote', zValidator('query', z.object({
  nights: z.coerce.number().int().min(1).max(MAX_EXTEND_NIGHTS),
})), async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))
    const { nights } = c.req.valid('query')

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    const q = await quoteExtensionForReservation(res, nights)
    if ('error' in q) return c.json({ error: q.error }, q.status)

    return c.json({ nights: q.nights, newCheckOutDate: q.newCheckOutDate, perNight: q.perNight, total: q.total })
  } catch (err) { return serverError(c, err) }
})

// POST /api/customer/reservations/:id/extend — sesión Stripe para pagar la ampliación
app.post('/reservations/:id/extend', zValidator('json', z.object({
  nights: z.number().int().min(1).max(MAX_EXTEND_NIGHTS),
})), async (c) => {
  try {
    const s     = await requireStripe()
    const branding = await getBranding()
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))
    const { nights } = c.req.valid('json')

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    // Recalculado por completo en el servidor — nunca se confía en un importe
    // que venga del cliente.
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
            description: `Reserva #${id} · nueva salida ${q.newCheckOutDate}`,
          },
        },
      }],
      customer_email: email,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId:   String(id),
        type:            'extend_stay',
        nights:          String(nights),
        newCheckOutDate: q.newCheckOutDate,
      },
      success_url: publicUrl(branding, `/portal?payment_ok=1`),
      cancel_url:  publicUrl(branding, `/portal`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/customer/reservations/:id/feedback — el huésped deja feedback ──
// Vía directa desde el propio huésped (portal), sin pasar por el personal.
// Se guarda como hilo de feedback normal (feedback_threads), con
// source='guest' y channel='portal' para distinguirlo de lo que abre el
// personal o el agente de IA — igual de visible para dirección/recepción en
// Informes → Feedback, pero se sabe que lo escribió el huésped tal cual.
const FEEDBACK_SENTIMENTS = ['positive', 'neutral', 'complaint', 'suggestion'] as const

app.post('/reservations/:id/feedback', zValidator('json', z.object({
  text:      z.string().min(1).max(2000),
  sentiment: z.enum(FEEDBACK_SENTIMENTS),
})), async (c) => {
  try {
    const email = c.get('customerEmail') as string
    const id    = parseInt(c.req.param('id'))
    const body  = c.req.valid('json')

    const guest = await guestByEmail(email)
    if (!guest) return c.json({ error: 'No encontrado' }, 404)

    const res = await db.query.reservations.findFirst({
      where: ownRes(id, guest.id),
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    await db.insert(feedbackThreads).values({
      propertyId: getPropertyId(), reservationId: res.id, guestId: guest.id,
      channel: 'portal', source: 'guest', sentiment: body.sentiment, text: body.text, category: 'otro',
    })

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

export default app
