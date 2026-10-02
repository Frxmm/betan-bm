import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, guests, rooms, roomTypes, rates, rateDailyPrices, financialTransactions, financialAccounts, bookingChannels, customerTokens, saleItems, reservationSaleItems, guestContracts, abandonedCarts, cancellationRecoveries, reservationNotes, temporaryDiscountSettings, bookingDiscountTimers, blockedBeds, users, properties } from '../db/schema'
import { hasRoomOverlap } from './reservations'
import { findFreeRoomOfType } from '../lib/roomTypeAvailability'
import { renderContract, renderAdmissionTermsPage, type ContractData } from '../lib/contract'
import { syncAutoInvoice } from '../lib/invoicing'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import { channelEnabled, renderEmail, portalLink } from '../lib/messaging'
import { sendWhatsappTemplate, isWhatsappConfigured } from '../lib/whatsapp'
import { resolvePrice, rateChainIds, roomTypeChainIds } from '../lib/price-resolver'
import { normalizeName } from '../lib/cartRecovery'
import { eq, and, sql, gte, lte, not, inArray, isNull, isNotNull, asc } from 'drizzle-orm'
import { requireStripe, getStripeWebhookSecret, getStripePublicKey, getStripeAccountId, getBookingChannelId, getCurrencyId, getStripeCurrency, publicUrl, publicBase } from '../lib/stripe'
import { getPropertyId, hasPropertyContext, getBranding, getProperty, hasFeature, featureOf, runWithProperty, resolvePublicProperty, loadProperty, type Branding } from '../lib/property'
import { fromOf } from '../lib/email'
import { env } from '../lib/env'
import { sign, verify } from 'hono/jwt'
import { serverError } from '../lib/errors'
import { Resend } from 'resend'

const app = new Hono()

// Resend es de plataforma (clave en env); el remitente es el de cada tenant (fromOf)
const resend       = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

// Reserva por id SIEMPRE acotada al tenant del contexto (evita IDOR entre hoteles)
const resWhere = (id: number) => and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId()))

// URL pública del tenant (dominio propio, o PUBLIC_URL + ?tenant=slug)
async function pu(path: string) { return publicUrl(await getBranding(), path) }

// Cuenta financiera de Stripe del tenant (por id en settings, nunca por nombre)
async function stripeAccount() {
  const id = await getStripeAccountId()
  if (!id) { console.warn('[stripe] el tenant no tiene cuenta financiera para Stripe (bookingEngine.stripeAccountId)'); return null }
  return db.query.financialAccounts.findFirst({
    where: and(eq(financialAccounts.id, id), eq(financialAccounts.propertyId, getPropertyId())),
  })
}

// Usuario "sistema" del tenant para filas que exigen created_by (primer usuario del hotel)
async function systemUserId(): Promise<number> {
  const u = await db.query.users.findFirst({ where: eq(users.propertyId, getPropertyId()), orderBy: asc(users.id), columns: { id: true } })
  if (!u) throw new Error('El tenant no tiene usuarios')
  return u.id
}

// Rate limiting magic link: email → timestamp del último envío
const magicLinkLastSent = new Map<string, number>()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escHtml(v: string) { return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') }

function isoDate(d: Date) { return d.toISOString().slice(0, 10) }

function addDays(date: string, n: number) {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n)
  return isoDate(d)
}

function dateRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = []
  let cur = checkIn
  while (cur < checkOut) { dates.push(cur); cur = addDays(cur, 1) }
  return dates
}

// Módulos por tenant: motor de reservas y portal pueden estar apagados
app.use('*', async (c, next) => {
  const path = new URL(c.req.url).pathname.replace(/^\/api\/public/, '')
  if (/^\/(availability|extras|discount-timer|checkout|booking|recover|recover-cancellation)(\/|$)/.test(path)) {
    if (!await hasFeature('bookingEngine')) return c.json({ error: 'Motor de reservas no disponible' }, 404)
  } else if (/^\/auth(\/|$)/.test(path)) {
    if (!await hasFeature('portal')) return c.json({ error: 'Portal de clientes no disponible' }, 404)
  }
  await next()
})

// ─── GET /api/public/config — config pública del booking engine ───────────────

// Branding público y seguro del tenant: nunca incluye secretos (solo la clave
// pública/publishable de Stripe, que es pública por diseño).
async function publicProperty() {
  const p = await getProperty()
  const b = await getBranding()
  return {
    name: b.name, legalName: b.legalName, logoUrl: b.logoUrl || null, websiteUrl: b.websiteUrl || null,
    phone: b.phone || null, receptionEmail: b.receptionEmail || null, mapsUrl: b.mapsUrl || null,
    starLabel: b.starLabel || null, localeDefault: b.localeDefault, currencyCode: b.currencyCode,
    timezone: b.timezone, slug: b.slug, city: b.city || null, countryCode: b.countryCode,
    features: { bookingEngine: featureOf(p, 'bookingEngine'), portal: featureOf(p, 'portal') },
    stripePublicKey: await getStripePublicKey(),
  }
}

app.get('/property', async (c) => {
  try { return c.json({ data: await publicProperty() }) } catch (err) { return serverError(c, err) }
})

app.get('/config', async (c) => {
  try {
    return c.json({ data: {
      googleAdsId:    process.env.GOOGLE_ADS_ID ?? null,             // AW-XXXXXXXXX (plataforma)
      googleAdsLabel: process.env.GOOGLE_ADS_CONVERSION_LABEL ?? null,
      property:       await publicProperty(),
    } })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/availability ─────────────────────────────────────────────

app.get('/availability', zValidator('query', z.object({
  checkIn:  z.string().date(),
  checkOut: z.string().date(),
  guests:   z.coerce.number().int().min(1).max(10).default(1),
})), async (c) => {
  try {
    const { checkIn, checkOut, guests: numGuests } = c.req.valid('query')

    if (checkIn >= checkOut) return c.json({ error: 'checkOut debe ser posterior a checkIn' }, 400)
    const nights = dateRange(checkIn, checkOut).length

    // Habitaciones ocupadas por noche en el rango
    const occupiedRaw = await db.execute(sql`
      SELECT ro.room_type_id, COUNT(DISTINCT ro.id)::int AS occupied
      FROM (
        SELECT r.room_id
        FROM reservations r
        WHERE r.property_id = ${getPropertyId()}
          AND r.room_id IS NOT NULL
          AND r.status NOT IN ('cancelled', 'no_show')
          AND r.check_in_date  < ${checkOut}::date
          AND r.check_out_date > ${checkIn}::date
        UNION
        SELECT jsonb_array_elements_text(r.extra_room_ids)::int AS room_id
        FROM reservations r
        WHERE r.property_id = ${getPropertyId()}
          AND r.extra_room_ids IS NOT NULL
          AND r.status NOT IN ('cancelled', 'no_show')
          AND r.check_in_date  < ${checkOut}::date
          AND r.check_out_date > ${checkIn}::date
        UNION
        SELECT bb.room_id
        FROM blocked_beds bb
        WHERE bb.property_id = ${getPropertyId()}
          AND bb.block_date >= ${checkIn}::date
          AND bb.block_date <  ${checkOut}::date
      ) occ
      JOIN rooms ro ON ro.id = occ.room_id
      GROUP BY ro.room_type_id
    `) as unknown as { room_type_id: number; occupied: number }[]

    const occupiedByType = Object.fromEntries(occupiedRaw.map(r => [r.room_type_id, r.occupied]))

    // Total de habitaciones por tipo
    const allRooms = await db.select({ roomTypeId: rooms.roomTypeId, total: sql<number>`COUNT(*)::int` })
      .from(rooms)
      .where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)))
      .groupBy(rooms.roomTypeId)

    // Tipos de habitación disponibles
    const types = await db.query.roomTypes.findMany({
      where: and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true)),
    })

    // Tarifas activas para motor de reservas
    const webRates = await db.query.rates.findMany({
      where: and(
        eq(rates.propertyId, getPropertyId()),
        eq(rates.active, true),
        eq(rates.activeForBookingEngine, true),
      ),
    })

    // Todas las tarifas y tipos de habitación activos (no solo los web): las
    // cadenas de derivación pueden pasar por tarifas/tipos intermedios que no
    // están en el booking engine (ej.: Web NR HD ← Dir HD ← Dir AL)
    const allRates = await db.query.rates.findMany({
      where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true)),
    })
    const ratesById = new Map(allRates.map(r => [r.id, r]))

    const allRoomTypes = await db.query.roomTypes.findMany({
      where: eq(roomTypes.propertyId, getPropertyId()),
    })
    const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))

    // Ids de toda la cadena de derivación de cada tarifa web y cada tipo de habitación
    const rateIdsToFetch = new Set<number>()
    for (const r of webRates) for (const id of rateChainIds(r, ratesById)) rateIdsToFetch.add(id)
    const roomTypeIdsToFetch = new Set<number>()
    for (const rt of types) for (const id of roomTypeChainIds(rt, roomTypesById)) roomTypeIdsToFetch.add(id)

    const dailyPrices = await db.select()
      .from(rateDailyPrices)
      .where(and(
        eq(rateDailyPrices.propertyId, getPropertyId()),
        gte(rateDailyPrices.date, checkIn),
        lte(rateDailyPrices.date, addDays(checkOut, -1)),
        not(rateDailyPrices.closed),
        inArray(rateDailyPrices.rateId, [...rateIdsToFetch]),
      ))

    const result = []

    for (const rt of types) {
      const totalRooms  = allRooms.find(r => r.roomTypeId === rt.id)?.total ?? 0
      const occupied    = occupiedByType[rt.id] ?? 0
      const available   = Math.max(0, totalRooms - occupied)

      if (available === 0) continue

      // Filtrar si el nº de huéspedes supera el máximo permitido en el booking engine
      const beMax = (rt as any).maxOccupancyBookingEngine ?? rt.maxOccupancy
      if (numGuests > beMax) continue

      const typeRates = webRates.filter(r => !r.roomTypeId || r.roomTypeId === rt.id)
      const rateOptions = []

      for (const rate of typeRates) {
        // Restricciones de estancia
        if (nights < (rate.minStay ?? 1)) continue
        if (rate.maxStay && nights > rate.maxStay) continue

        const prices = dateRange(checkIn, checkOut).map(date => resolvePrice(ratesById, roomTypesById, dailyPrices, rate.id, rt.id, date, rt.maxOccupancy ?? 1))

        if (prices.some(p => p === null)) continue // falta precio para alguna noche → no mostrar
        const total = prices.reduce((s, p) => s! + p!, 0)!

        rateOptions.push({
          rateId:          rate.id,
          rateTitle:       rate.title,
          rateDescription: rate.description ?? null,
          rateCode:        rate.code,
          pricePerNight:   Math.round((total / nights) * 100) / 100,
          totalPrice:      Math.round(total * 100) / 100,
          nights,
          minStay:         rate.minStay ?? 1,
          maxStay:         rate.maxStay ?? null,
        })
      }

      if (rateOptions.length === 0) continue

      rateOptions.sort((a, b) => a.totalPrice - b.totalPrice)

      result.push({
        roomTypeId:   rt.id,
        name:         rt.bookingEngineLabel || rt.name,
        description:  rt.description,
        maxOccupancy:          rt.maxOccupancy,
        maxOccupancyBookingEngine: (rt as any).maxOccupancyBookingEngine ?? null,
        available,
        rates:        rateOptions,
      })
    }

    result.sort((a, b) => a.rates[0]!.totalPrice - b.rates[0]!.totalPrice)

    return c.json({ checkIn, checkOut, nights, guests: numGuests, rooms: result })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/extras — extras disponibles para el booking engine ────────

app.get('/extras', async (c) => {
  try {
    const items = await db.select({
      id:          saleItems.id,
      title:       saleItems.title,
      description: saleItems.description,
      icon:        saleItems.icon,
      pricingType: saleItems.pricingType,
      maxQuantity: saleItems.maxQuantity,
      defaultPrice: saleItems.defaultPrice,
    })
    .from(saleItems)
    .where(and(eq(saleItems.propertyId, getPropertyId()), eq(saleItems.activeForBookingEngine, true), eq(saleItems.active, true)))

    return c.json({ data: items })
  } catch (err) { return serverError(c, err) }
})


// ─── POST /api/public/discount-timer — arranca el descuento temporal ───────────
// Se llama UNA vez desde el motor de reservas, en cuanto el cliente rellena
// email + nombre (antes de pagar). No se manda nada por email ni se guarda
// nada visible fuera de esta misma sesión de reserva — vive entera en la
// página: el frontend guarda el token y cuenta el tiempo en pantalla; aquí
// solo se ancla el instante real de inicio, porque el servidor nunca se fía
// de un timestamp que mande el navegador para decidir si aplica un descuento.
app.post('/discount-timer', zValidator('json', z.object({
  email:     z.string().email(),
  firstName: z.string().optional(),
  lastName:  z.string().optional(),
})), async (c) => {
  try {
    const [cfg] = await db.select().from(temporaryDiscountSettings).where(eq(temporaryDiscountSettings.propertyId, getPropertyId())).limit(1)
    if (!cfg?.enabled) return c.json({ data: { enabled: false } })

    const body = c.req.valid('json')

    // Un uso por email o por nombre normalizado cada 2 días — evita que el
    // mismo cliente vuelva a conseguir el descuento reabriendo la página una
    // y otra vez. Solo cuenta un uso REAL (usedAt), no el simple hecho de
    // haber visto la oferta antes sin llegar a canjearla.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000)
    const recentUsed = (await db.select({ t: bookingDiscountTimers }).from(bookingDiscountTimers)
      .innerJoin(reservations, eq(reservations.id, bookingDiscountTimers.reservationId))
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        isNotNull(bookingDiscountTimers.usedAt), gte(bookingDiscountTimers.usedAt, twoDaysAgo),
      ))).map(r => r.t)
    const normEmail = body.email.trim().toLowerCase()
    const normName  = normalizeName(`${body.firstName ?? ''} ${body.lastName ?? ''}`)
    const alreadyUsedRecently = recentUsed.some(r =>
      r.email.trim().toLowerCase() === normEmail
      || (normName.length > 1 && normalizeName(`${r.firstName ?? ''} ${r.lastName ?? ''}`) === normName)
    )
    if (alreadyUsedRecently) return c.json({ data: { enabled: false } })

    const token = crypto.randomUUID()
    const [row] = await db.insert(bookingDiscountTimers).values({
      token, email: body.email, firstName: body.firstName ?? null, lastName: body.lastName ?? null,
    }).returning()

    const startedMs   = row!.startedAt.getTime()
    const activatesAt = new Date(startedMs + cfg.activationMinutes * 60_000)
    const expiresAt   = new Date(startedMs + (cfg.activationMinutes + cfg.windowMinutes) * 60_000)
    return c.json({
      data: {
        enabled: true, token, discountPct: cfg.discountPct,
        activatesAt: activatesAt.toISOString(), expiresAt: expiresAt.toISOString(),
      },
    })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/public/checkout ─────────────────────────────────────────────────

app.post('/checkout', zValidator('json', z.object({
  checkIn:       z.string().date(),
  checkOut:      z.string().date(),
  roomTypeId:    z.number().int().positive(),
  rateId:        z.number().int().positive(),
  guests:        z.number().int().min(1).max(10),
  firstName:     z.string().min(1).max(100),
  lastName:      z.string().min(1).max(100),
  email:         z.string().email(),
  phone:         z.string().optional(),
  notes:         z.string().max(500).optional(),
  bedPreferenceTwin: z.boolean().optional(),
  // Descuento temporal (ver POST /discount-timer) — el servidor recalcula si
  // de verdad sigue en plazo, nunca se fía de nada que no sea este token.
  discountToken: z.string().optional(),
  // De dónde viene la petición — booking.tsx (página completa) o
  // booking-widget.tsx (iframe embebido en otra web). Decide a qué URL vuelve
  // Stripe si el cliente cancela: si no se distinguiera, un pago iniciado
  // desde el widget devolvería la página completa DENTRO del propio iframe
  // del widget (una web anidada dentro de la otra).
  source: z.enum(['standalone', 'widget']).optional().default('standalone'),
  extras:        z.array(z.object({
    saleItemId: z.number().int().positive(),
    quantity:   z.number().int().min(1).max(20),
  })).max(20).optional(),
})), async (c) => {
  try {
    const s = await requireStripe()
    const body = c.req.valid('json')

    const nights  = dateRange(body.checkIn, body.checkOut).length
    if (nights < 1) return c.json({ error: 'Fechas inválidas' }, 400)

    // Verificar disponibilidad
    const occu = await db.execute(sql`
      SELECT COUNT(DISTINCT occ.room_id)::int AS occupied,
             (SELECT COUNT(*)::int FROM rooms WHERE room_type_id = ${body.roomTypeId} AND property_id = ${getPropertyId()} AND active = true) AS total
      FROM (
        SELECT r.room_id FROM reservations r
        WHERE r.property_id = ${getPropertyId()} AND r.room_id IS NOT NULL
          AND r.status NOT IN ('cancelled','no_show')
          AND r.check_in_date < ${body.checkOut}::date AND r.check_out_date > ${body.checkIn}::date
          AND r.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${body.roomTypeId})
        UNION
        SELECT x.room_id FROM (
          SELECT jsonb_array_elements_text(r.extra_room_ids)::int AS room_id
          FROM reservations r
          WHERE r.property_id = ${getPropertyId()} AND r.extra_room_ids IS NOT NULL
            AND r.status NOT IN ('cancelled','no_show')
            AND r.check_in_date < ${body.checkOut}::date AND r.check_out_date > ${body.checkIn}::date
        ) x
        WHERE x.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${body.roomTypeId})
        UNION
        SELECT bb.room_id FROM blocked_beds bb
        WHERE bb.property_id = ${getPropertyId()}
          AND bb.block_date >= ${body.checkIn}::date AND bb.block_date < ${body.checkOut}::date
          AND bb.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${body.roomTypeId})
      ) occ
    `) as unknown as { occupied: number; total: number }[]

    const { occupied, total } = occu[0] ?? { occupied: 0, total: 0 }
    if (total - occupied < 1) return c.json({ error: 'No hay disponibilidad para las fechas seleccionadas' }, 409)

    // Calcular precio siguiendo la cadena de derivación completa (tarifa y tipo
    // de habitación) — misma lógica compartida que /availability
    const rate = await db.query.rates.findFirst({ where: and(eq(rates.id, body.rateId), eq(rates.propertyId, getPropertyId())) })
    if (!rate) return c.json({ error: 'Tarifa no encontrada' }, 404)

    const rtForCheckout = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, body.roomTypeId), eq(roomTypes.propertyId, getPropertyId())) })
    if (!rtForCheckout) return c.json({ error: 'Tipo de habitación no encontrado' }, 404)
    const occupancy = rtForCheckout.maxOccupancy ?? 1

    const chainRates = await db.query.rates.findMany({
      where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true)),
    })
    const chainById = new Map(chainRates.map(r => [r.id, r]))

    const chainRoomTypes = await db.query.roomTypes.findMany({
      where: eq(roomTypes.propertyId, getPropertyId()),
    })
    const roomTypesById = new Map(chainRoomTypes.map(rt => [rt.id, rt]))

    const rateIdsToCheck = rateChainIds(rate, chainById)

    const allPrices = await db.select()
      .from(rateDailyPrices)
      .where(and(
        eq(rateDailyPrices.propertyId, getPropertyId()),
        inArray(rateDailyPrices.rateId, rateIdsToCheck),
        gte(rateDailyPrices.date, body.checkIn),
        lte(rateDailyPrices.date, addDays(body.checkOut, -1)),
        not(rateDailyPrices.closed),
      ))

    const dates = dateRange(body.checkIn, body.checkOut)
    const resolvedPrices: Record<string, number> = {}
    for (const d of dates) {
      const p = resolvePrice(chainById, roomTypesById, allPrices, rate.id, body.roomTypeId, d, occupancy)
      if (p != null) resolvedPrices[d] = p
    }

    const missing = dates.filter(d => !(d in resolvedPrices))
    if (missing.length > 0) return c.json({ error: `Sin precio para: ${missing.join(', ')}` }, 422)

    const roomTotal = dates.reduce((s, d) => s + resolvedPrices[d]!, 0)

    // Calcular precio de extras
    let extrasTotal = 0
    const extrasDetail: { saleItemId: number; quantity: number; unitPrice: number; title: string }[] = []
    if (body.extras?.length) {
      const extraIds = body.extras.map(e => e.saleItemId)
      const items = await db.select().from(saleItems)
        .where(and(eq(saleItems.propertyId, getPropertyId()), eq(saleItems.activeForBookingEngine, true), inArray(saleItems.id, extraIds)))
      for (const req of body.extras) {
        const item = items.find(i => i.id === req.saleItemId)
        if (!item || !item.defaultPrice) continue
        const base = parseFloat(item.defaultPrice)
        const qty  = Math.min(req.quantity, item.maxQuantity ?? 1)
        let unit: number
        switch (item.pricingType) {
          case 'per_night':         unit = base * nights; break
          case 'per_person':        unit = base * body.guests; break
          case 'per_person_night':  unit = base * body.guests * nights; break
          default:                  unit = base
        }
        extrasTotal += unit * qty
        extrasDetail.push({ saleItemId: item.id, quantity: qty, unitPrice: unit, title: item.title })
      }
    }

    const rawTotal = roomTotal + extrasTotal

    // Descuento temporal (ver POST /discount-timer): solo aplica si el token
    // existe, no se ha usado ya, el email coincide con el de aquel momento, y
    // ha pasado entre `activationMinutes` y `activationMinutes+windowMinutes`
    // desde que se creó — todo verificado con el reloj del servidor, nunca
    // con nada que mande el navegador.
    let discountAmount = 0
    let discountPct: number | null = null
    let discountTimerId: number | null = null
    if (body.discountToken) {
      const [discountCfg] = await db.select().from(temporaryDiscountSettings).where(eq(temporaryDiscountSettings.propertyId, getPropertyId())).limit(1)
      if (discountCfg?.enabled) {
        const timer = await db.query.bookingDiscountTimers.findFirst({
          where: eq(bookingDiscountTimers.token, body.discountToken),
        })
        if (timer && !timer.usedAt && timer.email.toLowerCase() === body.email.toLowerCase()) {
          const elapsedMin = (Date.now() - timer.startedAt.getTime()) / 60_000
          if (elapsedMin >= discountCfg.activationMinutes && elapsedMin <= discountCfg.activationMinutes + discountCfg.windowMinutes) {
            discountAmount = Math.round(rawTotal * discountCfg.discountPct / 100 * 100) / 100
            discountPct = discountCfg.discountPct
            discountTimerId = timer.id
          }
        }
      }
    }

    const totalAmount = Math.round((rawTotal - discountAmount) * 100) / 100
    const amountCents = Math.round(totalAmount * 100)
    const roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, body.roomTypeId), eq(roomTypes.propertyId, getPropertyId())) })

    // Upsert huésped por email
    let guestId: number
    const existingGuest = body.email
      ? await db.query.guests.findFirst({ where: and(eq(guests.email, body.email), eq(guests.propertyId, getPropertyId())) })
      : null

    if (existingGuest) {
      guestId = existingGuest.id
    } else {
      const [g] = await db.insert(guests).values({
        propertyId: getPropertyId(),
        firstName:  body.firstName,
        lastName:   body.lastName,
        email:      body.email,
        phone:      body.phone ?? null,
      }).returning({ id: guests.id })
      guestId = g!.id
    }

    // Canal de venta del motor de reservas (bookingEngine.channelId)
    const channelId = await getBookingChannelId()

    // Crear reserva en estado tentativo
    const [reservation] = await db.insert(reservations).values({
      propertyId:       getPropertyId(),
      guestId,
      status:           'tentative',
      checkInDate:      body.checkIn,
      checkOutDate:     body.checkOut,
      nights:           nights as any,
      people:           body.guests as any,
      rateId:           body.rateId,
      bookingChannelId: channelId,
      currencyId:       await getCurrencyId(),
      total:            totalAmount.toFixed(2),
      amountPaid:       '0',
      source:           'web_directa',
      isFromPortal:     true,
      extraField2:      body.notes ?? null,
      bedPreferenceTwin: body.bedPreferenceTwin ?? false,
    }).returning({ id: reservations.id })

    // Descuento temporal aplicado — consumir el token (no reutilizable) y
    // dejar rastro visible en la reserva para el equipo.
    if (discountTimerId && reservation) {
      await db.update(bookingDiscountTimers)
        .set({ usedAt: new Date(), reservationId: reservation.id, discountPct, discountAmount: discountAmount.toFixed(2) })
        .where(eq(bookingDiscountTimers.id, discountTimerId))
      await db.insert(reservationNotes).values({
        reservationId: reservation.id,
        note: `💸 Descuento temporal de reserva rápida aplicado: -${discountAmount.toFixed(2)}€ sobre ${rawTotal.toFixed(2)}€.`,
        type: 'note',
      })
    }

    // Nota visible en la ficha de la reserva — extraField2 (comentarios) no se
    // muestra en ReservationDetailView, así que la preferencia de camas se
    // registra también como nota para que el equipo la vea al asignar habitación.
    if (body.bedPreferenceTwin && reservation) {
      await db.insert(reservationNotes).values({
        reservationId: reservation.id,
        note: '🛏️ El huésped solicitó habitación con dos camas separadas (preferencia del motor de reservas, no garantizada — asignar habitación con bedSize "twin" si es posible).',
        type: 'note',
      })
    }

    // Guardar extras de la reserva
    if (extrasDetail.length > 0 && reservation) {
      await db.insert(reservationSaleItems).values(
        extrasDetail.map(e => ({
          reservationId: reservation.id,
          saleItemId:    e.saleItemId,
          quantity:      e.quantity as any,
          unitPrice:     e.unitPrice.toFixed(2),
        }))
      )
    }

    // Stripe Checkout Session
    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:             await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     await getStripeCurrency(),
          unit_amount:  amountCents,
          product_data: {
            name:        `${(await getBranding()).name} — ${roomType?.name ?? 'Habitación'}`,
            description: `${body.checkIn} → ${body.checkOut} · ${nights} noche${nights !== 1 ? 's' : ''} · Tarifa: ${rate?.title ?? ''}`,
          },
        },
      }],
      customer_email: body.email,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(reservation!.id),
        guestId:       String(guestId),
        roomTypeId:    String(body.roomTypeId),
        checkIn:       body.checkIn,
        checkOut:      body.checkOut,
      },
      success_url: await pu(`/${body.source === 'widget' ? 'booking-widget' : 'booking'}/success?session_id={CHECKOUT_SESSION_ID}`),
      // reservationId en la vuelta: si cancela en Stripe, el motor de reservas
      // reconoce que hay una reserva tentativa a medias y la retoma
      // directamente, en vez de mandar al cliente a la búsqueda desde cero.
      cancel_url:  await pu(`/${body.source === 'widget' ? 'booking-widget' : 'booking'}?cancelled=1&reservationId=${reservation!.id}`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60, // 30 min
    })

    // Guardar session ID en la reserva
    await db.update(reservations)
      .set({ extraField1: session.id })
      .where(eq(reservations.id, reservation!.id))

    return c.json({ url: session.url, reservationId: reservation!.id })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/booking/pending/:id ───────────────────────────────────────
// Reserva tentativa (sin pagar) creada en /checkout — para retomarla al volver
// de un pago cancelado en Stripe, en vez de mandar al cliente a empezar de
// cero. Sin datos del huésped (nombre/email) en la respuesta: solo lo mínimo
// para mostrar "tienes una reserva pendiente" y ofrecer terminar el pago.
app.get('/booking/pending/:id', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'tentative')),
      with: { rate: true },
    })
    if (!res) return c.json({ error: 'No encontrado' }, 404)

    // Si ya se le aplicó el descuento temporal (en el primer intento de pago,
    // cancelado en Stripe), lo decimos aquí — res.total ya lleva el descuento
    // restado, esto es solo para poder mostrarlo explícito en pantalla.
    const usedDiscount = await db.query.bookingDiscountTimers.findFirst({
      where: and(eq(bookingDiscountTimers.reservationId, id), isNotNull(bookingDiscountTimers.usedAt), isNotNull(bookingDiscountTimers.discountPct)),
    })

    return c.json({
      data: {
        id: res.id,
        checkIn:  res.checkInDate,
        checkOut: res.checkOutDate,
        nights:   res.nights,
        guests:   res.people,
        total:    res.total,
        rateName: (res.rate as any)?.title ?? null,
        discountPct:    usedDiscount?.discountPct ?? null,
        discountAmount: usedDiscount?.discountAmount ?? null,
      },
    })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/public/checkout/resume ──────────────────────────────────────────
// Crea una NUEVA sesión de Stripe para una reserva tentativa YA existente (no
// crea otra reserva) — para el botón "Completar pago" al retomar una reserva
// pendiente tras volver de un pago cancelado.
app.post('/checkout/resume', zValidator('json', z.object({
  reservationId: z.number().int().positive(),
  source: z.enum(['standalone', 'widget']).optional().default('standalone'),
  // Descuento temporal — solo tiene efecto si esta reserva NO recibió ya uno
  // en el primer intento (se comprueba abajo); si no había llegado a
  // activarse cuando pagó la primera vez pero para cuando retoma el pago ya
  // está en ventana válida, se le aplica ahora.
  discountToken: z.string().optional(),
})), async (c) => {
  try {
    const s = await requireStripe()
    const body = c.req.valid('json')
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, body.reservationId), eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'tentative')),
      with: { guest: true },
    })
    if (!res) return c.json({ error: 'Esta reserva pendiente ya no está disponible' }, 404)

    // ¿Ya se le aplicó un descuento en el intento anterior? No se aplica dos veces.
    const alreadyDiscounted = await db.query.bookingDiscountTimers.findFirst({
      where: and(eq(bookingDiscountTimers.reservationId, res.id), isNotNull(bookingDiscountTimers.usedAt), isNotNull(bookingDiscountTimers.discountPct)),
    })

    let currentTotal = parseFloat(res.total ?? '0')
    if (!alreadyDiscounted && body.discountToken) {
      const [discountCfg] = await db.select().from(temporaryDiscountSettings).where(eq(temporaryDiscountSettings.propertyId, getPropertyId())).limit(1)
      if (discountCfg?.enabled) {
        const timer = await db.query.bookingDiscountTimers.findFirst({
          where: eq(bookingDiscountTimers.token, body.discountToken),
        })
        const guestEmail = ((res.guest as any)?.email ?? '').toLowerCase()
        if (timer && !timer.usedAt && timer.email.toLowerCase() === guestEmail) {
          const elapsedMin = (Date.now() - timer.startedAt.getTime()) / 60_000
          if (elapsedMin >= discountCfg.activationMinutes && elapsedMin <= discountCfg.activationMinutes + discountCfg.windowMinutes) {
            const discountAmount = Math.round(currentTotal * discountCfg.discountPct / 100 * 100) / 100
            currentTotal = Math.round((currentTotal - discountAmount) * 100) / 100
            await db.update(reservations).set({ total: currentTotal.toFixed(2) }).where(resWhere(res.id))
            await db.update(bookingDiscountTimers)
              .set({ usedAt: new Date(), reservationId: res.id, discountPct: discountCfg.discountPct, discountAmount: discountAmount.toFixed(2) })
              .where(eq(bookingDiscountTimers.id, timer.id))
          }
        }
      }
    }

    const amountCents = Math.round(currentTotal * 100)
    if (amountCents <= 0) return c.json({ error: 'Importe inválido' }, 422)

    // roomTypeId no se guarda en la propia reserva (solo viajaba en los
    // metadatos de la sesión de Stripe original, que el webhook usa para
    // asignar habitación al confirmar el pago) — se recupera de esa sesión
    // (guardada en extraField1) para que la nueva sesión lo siga llevando y
    // no se pierda la asignación automática de habitación al pagar.
    let roomTypeId = ''
    if (res.extraField1) {
      try {
        const origSession = await s.checkout.sessions.retrieve(res.extraField1)
        roomTypeId = origSession.metadata?.roomTypeId ?? ''
      } catch { /* sesión original ya no recuperable — se asignará habitación a mano */ }
    }

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:             await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     await getStripeCurrency(),
          unit_amount:  amountCents,
          product_data: {
            name:        `${(await getBranding()).name} — Reserva`,
            description: `${res.checkInDate} → ${res.checkOutDate}`,
          },
        },
      }],
      customer_email: (res.guest as any)?.email ?? undefined,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(res.id),
        guestId:       String(res.guestId),
        roomTypeId,
        checkIn:       res.checkInDate,
        checkOut:      res.checkOutDate,
      },
      success_url: await pu(`/${body.source === 'widget' ? 'booking-widget' : 'booking'}/success?session_id={CHECKOUT_SESSION_ID}`),
      cancel_url:  await pu(`/${body.source === 'widget' ? 'booking-widget' : 'booking'}?cancelled=1&reservationId=${res.id}`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    await db.update(reservations).set({ extraField1: session.id }).where(resWhere(res.id))
    return c.json({ url: session.url })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/public/stripe/webhook ──────────────────────────────────────────

// Resolución del tenant ANTES de verificar la firma: cada hotel tiene su cuenta
// de Stripe y su secreto de webhook. Orden: metadata.property_id del evento →
// ruta /stripe/webhook/:slug → contexto de la petición (dominio / único tenant).
// El id de la metadata no se "cree": la firma se verifica con el secreto de ESE
// tenant, así que un property_id falsificado solo produce una firma inválida.
async function stripeWebhook(c: any, slug?: string) {
  const body = await c.req.text()
  const sig  = c.req.header('stripe-signature') ?? ''

  let pid: number | null = null
  try {
    const m = Number(JSON.parse(body)?.data?.object?.metadata?.property_id)
    if (Number.isInteger(m) && m > 0) pid = m
  } catch { /* cuerpo no JSON → se rechaza más abajo por firma */ }
  if (!pid && slug) pid = await resolvePublicProperty({ slug })
  if (!pid && hasPropertyContext()) pid = getPropertyId()
  if (!pid) return c.text('Tenant no identificado en el webhook', 400)
  try { await loadProperty(pid) } catch { return c.text('Tenant no encontrado', 400) }

  return runWithProperty(pid, () => stripeWebhookInTenant(c, body, sig))
}

app.post('/stripe/webhook',       (c) => stripeWebhook(c))
app.post('/stripe/webhook/:slug', (c) => stripeWebhook(c, c.req.param('slug')))

async function stripeWebhookInTenant(c: any, body: string, sig: string) {
  const s = await requireStripe()
  console.log('[stripe/webhook] solicitud recibida', { hasSig: !!sig, bodyLen: body.length })

  let event: any
  try {
    // Bun usa Web Crypto (async) — constructEvent es síncrono y falla con
    // CryptoProviderOnlySupportsAsyncError; hay que usar la variante async
    event = await s.webhooks.constructEventAsync(body, sig, (await getStripeWebhookSecret()) ?? '')
  } catch (err) {
    console.error('[stripe/webhook] firma inválida', err)
    return c.text('Webhook signature inválida', 400)
  }

  console.log('[stripe/webhook] evento verificado', event.type, event.data?.object?.metadata)

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object
    const reservationId = parseInt(session.metadata?.reservationId ?? '0')
    if (!reservationId) return c.json({ ok: true })

    // Pago de saldo pendiente desde el portal del cliente
    if (session.metadata?.type === 'pending_payment') {
      try {
        // Idempotente: Stripe puede reintentar la entrega del webhook
        const alreadyProcessed = await db.query.financialTransactions.findFirst({
          where: and(eq(financialTransactions.reservationId, reservationId), eq(financialTransactions.onlinePaymentId, session.id)),
        })
        if (alreadyProcessed) return c.json({ ok: true })

        const amountNew = (session.amount_total ?? 0) / 100

        const account = await stripeAccount()

        await db.transaction(async (tx) => {
          const existing = await tx.query.reservations.findFirst({
            where: resWhere(reservationId),
            columns: { amountPaid: true },
          })
          const alreadyPaid = parseFloat((existing?.amountPaid as string) ?? '0')

          await tx.update(reservations)
            .set({ amountPaid: (alreadyPaid + amountNew).toFixed(2), updatedAt: new Date() } as any)
            .where(resWhere(reservationId))

          if (account) {
            await tx.insert(financialTransactions).values({
              propertyId:          getPropertyId(),
              reservationId,
              financialAccountId:  account.id,
              amount:              amountNew.toFixed(2),
              currencyId:          await getCurrencyId(),
              paymentMethod:       'stripe',
              description:         `Pago portal — sesión ${session.id}`,
              transactionDate:     isoDate(new Date()),
              onlinePaymentId:     session.id,
              onlinePaymentStatus: 'paid',
            } as any)
          }
        })

        if (account) await syncAutoInvoice(reservationId)
      } catch (err) {
        console.error('[stripe/webhook] pending_payment falló', reservationId, session.id, err)
        return c.json({ error: 'internal' }, 500)
      }

      return c.json({ ok: true })
    }

    // Compra de extras post-reserva desde el portal del cliente
    if (session.metadata?.type === 'extra_purchase') {
      try {
        // Idempotente: Stripe puede reintentar la entrega del webhook
        const alreadyProcessed = await db.query.financialTransactions.findFirst({
          where: and(eq(financialTransactions.reservationId, reservationId), eq(financialTransactions.onlinePaymentId, session.id)),
        })
        if (alreadyProcessed) return c.json({ ok: true })

        const amountNew = (session.amount_total ?? 0) / 100

        let extrasDetail: { i: number; q: number; u: number }[] = []
        try { extrasDetail = JSON.parse(session.metadata?.extras ?? '[]') } catch (e) {
          console.error('[stripe/webhook] extra_purchase: metadata.extras no parseable', session.metadata?.extras, e)
        }

        const account = await stripeAccount()

        // Todo en una transacción: si algo falla, no queda dinero aplicado sin su
        // línea de extra o su transacción contable
        await db.transaction(async (tx) => {
          const existing = await tx.query.reservations.findFirst({
            where: resWhere(reservationId),
            columns: { amountPaid: true, total: true },
          })
          const alreadyPaid   = parseFloat((existing?.amountPaid as string) ?? '0')
          const previousTotal = parseFloat((existing?.total as string) ?? '0')

          await tx.update(reservations)
            .set({
              amountPaid: (alreadyPaid + amountNew).toFixed(2),
              total:      (previousTotal + amountNew).toFixed(2),
              updatedAt:  new Date(),
            } as any)
            .where(resWhere(reservationId))

          if (extrasDetail.length > 0) {
            await tx.insert(reservationSaleItems).values(
              extrasDetail.map(e => ({
                reservationId,
                saleItemId: e.i,
                quantity:   e.q as any,
                unitPrice:  e.u.toFixed(2),
              }))
            )
          }

          if (account) {
            await tx.insert(financialTransactions).values({
              propertyId:          getPropertyId(),
              reservationId,
              financialAccountId:  account.id,
              amount:              amountNew.toFixed(2),
              currencyId:          await getCurrencyId(),
              paymentMethod:       'stripe',
              description:         `Extras portal — sesión ${session.id}`,
              transactionDate:     isoDate(new Date()),
              onlinePaymentId:     session.id,
              onlinePaymentStatus: 'paid',
            } as any)
          }
        })

        if (account) await syncAutoInvoice(reservationId)
      } catch (err) {
        console.error('[stripe/webhook] extra_purchase falló', reservationId, session.id, err)
        return c.json({ error: 'internal' }, 500)
      }

      return c.json({ ok: true })
    }

    // Ampliación de estancia pagada desde el portal del cliente. El check-out
    // NUNCA se toca antes de aquí (ver POST /api/customer/reservations/:id/extend)
    // — y aquí tampoco si, entre la cotización y la confirmación del pago, la
    // disponibilidad ya no es real: el dinero se registra igualmente (queda
    // contabilizado) pero la reserva se deja tal cual y salta una alerta para
    // que dirección lo resuelva a mano (ver GET /api/alerts/urgent).
    if (session.metadata?.type === 'extend_stay') {
      try {
        const alreadyProcessed = await db.query.financialTransactions.findFirst({
          where: and(eq(financialTransactions.reservationId, reservationId), eq(financialTransactions.onlinePaymentId, session.id)),
        })
        if (alreadyProcessed) return c.json({ ok: true })

        const amountNew        = (session.amount_total ?? 0) / 100
        const addedNights       = parseInt(session.metadata?.nights ?? '0')
        const newCheckOutDate   = session.metadata?.newCheckOutDate as string

        const account = await stripeAccount()

        const current = await db.query.reservations.findFirst({
          where: resWhere(reservationId),
          columns: { roomId: true, checkInDate: true, checkOutDate: true, amountPaid: true, total: true },
        })

        // La habitación concreta puede coincidir con otra reserva esas
        // noches (lo normal: la siguiente reserva ya la tiene asignada) —
        // eso no bloquea la ampliación mientras quede OTRA habitación libre
        // del mismo tipo; se aplica igualmente y se deja avisado para que
        // dirección reubique a alguien antes de esa fecha.
        let applied = false
        let needsRelocation = false
        let relocationRoom: { id: number; code: string } | null = null
        let roomTypeId: number | null = null
        if (current?.roomId && newCheckOutDate && newCheckOutDate > current.checkOutDate) {
          const overlap = await hasRoomOverlap(current.roomId, current.checkOutDate, newCheckOutDate, reservationId)
          if (!overlap) {
            applied = true
          } else {
            const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, current.roomId), eq(rooms.propertyId, getPropertyId())), columns: { roomTypeId: true } })
            roomTypeId = room?.roomTypeId ?? null
            if (roomTypeId) {
              relocationRoom = await findFreeRoomOfType(roomTypeId, current.checkOutDate, newCheckOutDate, reservationId)
              if (relocationRoom) { applied = true; needsRelocation = true }
            }
          }
        }

        await db.transaction(async (tx) => {
          const alreadyPaid   = parseFloat((current?.amountPaid as string) ?? '0')
          const previousTotal = parseFloat((current?.total as string) ?? '0')

          const updates: any = {
            amountPaid: (alreadyPaid + amountNew).toFixed(2),
            total:      (previousTotal + amountNew).toFixed(2),
            updatedAt:  new Date(),
          }
          if (applied) {
            updates.checkOutDate = newCheckOutDate
            updates.nights = Math.round((new Date(newCheckOutDate + 'T12:00:00').getTime() - new Date((current!.checkInDate as string) + 'T12:00:00').getTime()) / 86400000)
          }
          await tx.update(reservations).set(updates).where(resWhere(reservationId))

          await tx.insert(reservationNotes).values({
            reservationId,
            note: needsRelocation
              ? `Ampliación pagada por el huésped desde el portal: salida ${current!.checkOutDate} → ${newCheckOutDate} (+${addedNights} noche(s), ${amountNew.toFixed(2)} €). Su habitación coincide con otra reserva esas noches — hay que reubicar a este huésped o a la otra reserva a la habitación ${relocationRoom!.code} (bloqueada temporalmente para esto) antes del ${current!.checkOutDate}.`
              : applied
              ? `Ampliación pagada por el huésped desde el portal: salida ${current!.checkOutDate} → ${newCheckOutDate} (+${addedNights} noche(s), ${amountNew.toFixed(2)} €)`
              : `⚠️ Ampliación pagada por el huésped (${amountNew.toFixed(2)} €, salida solicitada ${newCheckOutDate}) pero SIN disponibilidad real al confirmarse el pago — revisar manualmente (reubicar o reembolsar). No se ha cambiado la fecha de salida.`,
            type: needsRelocation ? 'extend_needs_relocation' : applied ? 'change' : 'extend_unavailable',
          })

          if (needsRelocation && relocationRoom && roomTypeId) {
            const blockDates = dateRange(current!.checkOutDate, newCheckOutDate)
            if (blockDates.length > 0) {
              const blockedBy = await systemUserId()
              await tx.insert(blockedBeds).values(blockDates.map(blockDate => ({
                propertyId: getPropertyId(), roomId: relocationRoom!.id, roomTypeId: roomTypeId!,
                bedNumber: '1', blockDate,
                reason: `Reservado para reubicación — ampliación de la reserva #${reservationId}`,
                createdBy: blockedBy,
              })))
            }
          }

          if (account) {
            await tx.insert(financialTransactions).values({
              propertyId:          getPropertyId(),
              reservationId,
              financialAccountId:  account.id,
              amount:              amountNew.toFixed(2),
              currencyId:          await getCurrencyId(),
              paymentMethod:       'stripe',
              description:         `Ampliación de estancia portal — sesión ${session.id}`,
              transactionDate:     isoDate(new Date()),
              onlinePaymentId:     session.id,
              onlinePaymentStatus: 'paid',
            } as any)
          }
        })

        if (account) await syncAutoInvoice(reservationId)
      } catch (err) {
        console.error('[stripe/webhook] extend_stay falló', reservationId, session.id, err)
        return c.json({ error: 'internal' }, 500)
      }

      return c.json({ ok: true })
    }

    // Asignar habitación disponible
    const roomTypeId = parseInt(session.metadata?.roomTypeId ?? '0')
    const checkIn    = session.metadata?.checkIn  as string
    const checkOut   = session.metadata?.checkOut as string

    const availableRoom = await db.execute(sql`
      SELECT r.id FROM rooms r
      WHERE r.room_type_id = ${roomTypeId} AND r.property_id = ${getPropertyId()} AND r.active = true
        AND r.id NOT IN (
          SELECT COALESCE(room_id, 0) FROM reservations
          WHERE property_id = ${getPropertyId()} AND room_id IS NOT NULL
            AND status NOT IN ('cancelled','no_show','tentative')
            AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
        )
        AND r.id NOT IN (
          SELECT jsonb_array_elements_text(extra_room_ids)::int FROM reservations
          WHERE property_id = ${getPropertyId()} AND extra_room_ids IS NOT NULL
            AND status NOT IN ('cancelled','no_show','tentative')
            AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
        )
        AND r.id NOT IN (
          SELECT bb.room_id FROM blocked_beds bb
          WHERE bb.property_id = ${getPropertyId()}
            AND bb.block_date >= ${checkIn}::date AND bb.block_date < ${checkOut}::date
        )
      LIMIT 1
    `) as unknown as { id: number }[]

    const roomId = availableRoom[0]?.id ?? null
    const amountPaid = (session.amount_total ?? 0) / 100

    await db.update(reservations)
      .set({
        status:     'confirmed',
        roomId,
        amountPaid: amountPaid.toFixed(2),
        updatedAt:  new Date(),
      } as any)
      .where(resWhere(reservationId))

    // Registrar transacción
    const account = await stripeAccount()

    if (account) {
      await db.insert(financialTransactions).values({
        propertyId:          getPropertyId(),
        reservationId,
        financialAccountId:  account.id,
        amount:              amountPaid.toFixed(2),
        currencyId:          await getCurrencyId(),
        paymentMethod:       'stripe',
        description:         `Pago web — sesión ${session.id}`,
        transactionDate:     isoDate(new Date()),
        onlinePaymentId:     session.id,
        onlinePaymentStatus: 'paid',
      } as any)
      await syncAutoInvoice(reservationId)
    }

    // Email de confirmación
    const res = await db.query.reservations.findFirst({
      where: resWhere(reservationId),
      with:  { guest: true, room: true, rate: true },
    })

    if (res?.guest) {
      const g = res.guest as any
      const portalUrl = g.email ? await portalLink(g.email) : null

      if (g.email && resend && portalUrl && await channelEnabled('booking_confirmation', 'email', res.bookingChannelId)) {
        // No cuenta los depósitos retenidos sin cobrar como pago de la
        // estancia (ver src/lib/paymentAggregate.ts).
        const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
        const balance = calcPendingBalance(res.total, realPaid).toFixed(2)
        const { subject, html } = await renderEmail('booking_confirmation', {
          name:      `${g.firstName} ${g.lastName}`,
          checkIn:   res.checkInDate,
          checkOut:  res.checkOutDate,
          room:      (res.room as any)?.code ?? 'Por asignar',
          total:     res.total as string,
          balance,
          resId:     reservationId,
          portalUrl,
        })
        await resend.emails.send({ from: fromOf(await getBranding()), to: g.email, subject, html }).catch(() => {})
      }

      if (g.phone && portalUrl && await isWhatsappConfigured() && await channelEnabled('booking_confirmation', 'whatsapp', res.bookingChannelId)) {
        await sendWhatsappTemplate({
          to: g.phone, template: 'confirmacion',
          params: [g.firstName, res.checkInDate, res.checkOutDate, (res.room as any)?.code ?? 'Por asignar', portalUrl],
        }).catch(() => {})
      }
    }

    // Notificación a recepción
    const rtName = session.metadata?.roomTypeName ?? ''
    notifyReception(reservationId, amountPaid, rtName).catch(() => {})
  }

  if (event.type === 'checkout.session.expired') {
    const session    = event.data.object
    const reservationId = parseInt(session.metadata?.reservationId ?? '0')
    if (reservationId) {
      await db.update(reservations)
        .set({ status: 'cancelled' } as any)
        .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'tentative')))
    }
  }

  return c.json({ ok: true })
}

// ─── POST /api/public/auth/send — enviar magic link ───────────────────────────

app.post('/auth/send', zValidator('json', z.object({
  email: z.string().email(),
})), async (c) => {
  try {
    const { email } = c.req.valid('json')

    const RESEND_COOLDOWN_MS = 15 * 60 * 1000       // antispam: no repetir solicitud antes de esto
    const TOKEN_EXPIRY_MS    = 48 * 3_600_000        // el enlace en sí es válido 48h
    const lastSent = magicLinkLastSent.get(`${getPropertyId()}:${email}`)
    if (lastSent && Date.now() - lastSent < RESEND_COOLDOWN_MS) {
      const waitMin = Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastSent)) / 60000)
      return c.json({ error: `Espera ${waitMin} minuto${waitMin !== 1 ? 's' : ''} antes de solicitar otro enlace` }, 429)
    }

    const token     = crypto.randomUUID()
    const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS)

    await db.insert(customerTokens).values({ email, token, expiresAt })
    magicLinkLastSent.set(`${getPropertyId()}:${email}`, Date.now())

    const branding = await getBranding()
    const link = publicUrl(branding, `/portal?token=${token}`)

    if (resend) {
      await resend.emails.send({
        from:    fromOf(branding),
        to:      email,
        subject: `Accede a tus reservas — ${branding.name}`,
        html:    magicLinkEmail({ email, link, branding }),
      })
    } else {
      console.log(`[booking-engine] magic link (sin email configurado): ${link}`)
    }

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/auth/verify — verificar magic link ───────────────────────

app.get('/auth/verify', zValidator('query', z.object({
  token: z.string().uuid(),
})), async (c) => {
  try {
    const { token } = c.req.valid('query')

    const record = await db.query.customerTokens.findFirst({
      where: eq(customerTokens.token, token),
    })

    if (!record)                       return c.json({ error: 'Token no encontrado' }, 404)
    if (new Date() > record.expiresAt) return c.json({ error: 'Token expirado' }, 410)

    // Reutilizable durante toda su validez (48h): un escáner de email que lo
    // pre-visite no debe invalidarlo para el huésped real. Solo registramos
    // la primera vez que se usó, no bloqueamos usos posteriores.
    if (!record.usedAt) {
      await db.update(customerTokens)
        .set({ usedAt: new Date() })
        .where(eq(customerTokens.id, record.id))
    }

    const jwt = await sign(
      { sub: record.email, type: 'customer', propertyId: getPropertyId(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600 },
      env.JWT_SECRET,
      'HS256',
    )

    return c.json({ token: jwt, email: record.email })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/recover/:token — recuperar carrito abandonado con descuento ─

app.get('/recover/:token', async (c) => {
  const branding = await getBranding()
  const fail = (msg: string) => c.html(
    `<div style="font-family:Arial;max-width:480px;margin:60px auto;text-align:center">
      <h2>${escHtml(branding.name)}</h2><p>${msg}</p>
      <p><a href="${publicUrl(branding, '/booking')}">Hacer una reserva nueva</a></p></div>`, 410)
  try {
    const s     = await requireStripe()
    const token = c.req.param('token')

    const cart = await db.query.abandonedCarts.findFirst({ where: eq(abandonedCarts.recoveryToken, token) })
    if (!cart)             return fail('Este enlace no es válido.')
    if (cart.recoveredAt)  return fail('Esta reserva ya fue completada. ¡Gracias!')
    if (cart.expiresAt && cart.expiresAt < new Date()) return fail('El descuento ha caducado.')

    const res = await db.query.reservations.findFirst({
      where: resWhere(cart.reservationId),
      with:  { guest: true },
    })
    if (!res) return fail('Reserva no encontrada.')
    if (res.checkInDate < isoDate(new Date())) return fail('Las fechas de la reserva ya han pasado.')
    if (parseFloat(String(res.amountPaid)) > 0.01) return fail('Esta reserva ya está pagada.')

    // Re-verificar disponibilidad si conocemos el tipo de habitación
    if (cart.roomTypeId) {
      const occu = await db.execute(sql`
        SELECT COUNT(DISTINCT occ.room_id)::int AS occupied,
               (SELECT COUNT(*)::int FROM rooms WHERE room_type_id = ${cart.roomTypeId} AND property_id = ${getPropertyId()} AND active = true) AS total
        FROM (
          SELECT r.room_id FROM reservations r
          WHERE r.property_id = ${getPropertyId()} AND r.room_id IS NOT NULL
            AND r.status NOT IN ('cancelled','no_show')
            AND r.check_in_date < ${res.checkOutDate}::date AND r.check_out_date > ${res.checkInDate}::date
            AND r.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${cart.roomTypeId})
          UNION
          SELECT x.room_id FROM (
            SELECT jsonb_array_elements_text(r.extra_room_ids)::int AS room_id
            FROM reservations r
            WHERE r.property_id = ${getPropertyId()} AND r.extra_room_ids IS NOT NULL
              AND r.status NOT IN ('cancelled','no_show')
              AND r.check_in_date < ${res.checkOutDate}::date AND r.check_out_date > ${res.checkInDate}::date
          ) x WHERE x.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${cart.roomTypeId})
        ) occ
      `) as unknown as { occupied: number; total: number }[]
      const { occupied, total } = occu[0] ?? { occupied: 0, total: 0 }
      if (total - occupied < 1) return fail('Lo sentimos, ya no queda disponibilidad para esas fechas.')
    }

    const original   = parseFloat(String(cart.amount))
    const discounted = Math.round(original * (100 - cart.discountPct)) / 100
    const g = res.guest as any

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:             await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     await getStripeCurrency(),
          unit_amount:  Math.round(discounted * 100),
          product_data: {
            name:        `${(await getBranding()).name} — Reserva con ${cart.discountPct}% dto.`,
            description: `${res.checkInDate} → ${res.checkOutDate} · antes ${original.toFixed(2)} €`,
          },
        },
      }],
      customer_email: g?.email ?? undefined,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId: String(res.id),
        roomTypeId:    String(cart.roomTypeId ?? ''),
        checkIn:       res.checkInDate,
        checkOut:      res.checkOutDate,
        recoveryToken: token,
      },
      success_url: await pu(`/booking/success?session_id={CHECKOUT_SESSION_ID}`),
      cancel_url:  await pu(`/booking?cancelled=1`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    // Revivir la reserva (el scheduler pudo cancelarla) con el total descontado
    await db.update(reservations)
      .set({ status: 'tentative', total: discounted.toFixed(2), extraField1: session.id, updatedAt: new Date() } as any)
      .where(resWhere(res.id))

    return c.redirect(session.url!, 302)
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/recover-cancellation/:token — reenganche de reserva cancelada ─
// A diferencia de /recover/:token (que revive el mismo carrito tentative), aquí
// la reserva original YA está cancelada y cerrada — se crea una reserva NUEVA
// (tentative) con la MISMA tarifa y fechas, a precio descontado; el webhook de
// Stripe normal la confirma sola en cuanto se paga, igual que cualquier venta
// nueva del motor de reservas.

app.get('/recover-cancellation/:token', async (c) => {
  const branding = await getBranding()
  const fail = (msg: string) => c.html(
    `<div style="font-family:Arial;max-width:480px;margin:60px auto;text-align:center">
      <h2>${escHtml(branding.name)}</h2><p>${msg}</p>
      <p><a href="${publicUrl(branding, '/booking')}">Hacer una reserva nueva</a></p></div>`, 410)
  try {
    const s     = await requireStripe()
    const token = c.req.param('token')

    const rec = await db.query.cancellationRecoveries.findFirst({ where: eq(cancellationRecoveries.recoveryToken, token) })
    if (!rec)             return fail('Este enlace no es válido.')
    if (rec.recoveredAt)  return fail('Esta reserva ya fue completada. ¡Gracias!')
    if (rec.expiresAt && rec.expiresAt < new Date()) return fail('El descuento ha caducado.')
    if (rec.checkIn < isoDate(new Date())) return fail('Las fechas de la estancia ya han pasado.')
    if (!rec.roomTypeId || !rec.rateId) return fail('Esta oferta ya no está disponible.')

    const original = await db.query.reservations.findFirst({
      where: resWhere(rec.reservationId),
      with:  { guest: true },
    })
    if (!original?.guest) return fail('Reserva no encontrada.')

    // Disponibilidad real para ese tipo de habitación en esas fechas
    const occu = await db.execute(sql`
      SELECT COUNT(DISTINCT occ.room_id)::int AS occupied,
             (SELECT COUNT(*)::int FROM rooms WHERE room_type_id = ${rec.roomTypeId} AND property_id = ${getPropertyId()} AND active = true) AS total
      FROM (
        SELECT r.room_id FROM reservations r
        WHERE r.property_id = ${getPropertyId()} AND r.room_id IS NOT NULL
          AND r.status NOT IN ('cancelled','no_show')
          AND r.check_in_date < ${rec.checkOut}::date AND r.check_out_date > ${rec.checkIn}::date
          AND r.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${rec.roomTypeId})
        UNION
        SELECT x.room_id FROM (
          SELECT jsonb_array_elements_text(r.extra_room_ids)::int AS room_id
          FROM reservations r
          WHERE r.property_id = ${getPropertyId()} AND r.extra_room_ids IS NOT NULL
            AND r.status NOT IN ('cancelled','no_show')
            AND r.check_in_date < ${rec.checkOut}::date AND r.check_out_date > ${rec.checkIn}::date
        ) x WHERE x.room_id IN (SELECT id FROM rooms WHERE room_type_id = ${rec.roomTypeId})
      ) occ
    `) as unknown as { occupied: number; total: number }[]
    const { occupied, total } = occu[0] ?? { occupied: 0, total: 0 }
    if (total - occupied < 1) return fail('Lo sentimos, ya no queda disponibilidad para esas fechas.')

    // Canal de venta del motor de reservas — mismo criterio que las reservas nuevas del motor de reservas
    const channelId = await getBookingChannelId()

    const nights = Math.round((new Date(rec.checkOut).getTime() - new Date(rec.checkIn).getTime()) / 86400000)
    const g = original.guest as any

    const [newRes] = await db.insert(reservations).values({
      propertyId:       getPropertyId(),
      guestId:          g.id,
      status:           'tentative',
      checkInDate:      rec.checkIn,
      checkOutDate:     rec.checkOut,
      nights:           nights as any,
      people:           original.people,
      rateId:           rec.rateId,
      bookingChannelId: channelId,
      currencyId:       await getCurrencyId(),
      total:            rec.discountedAmount,
      amountPaid:       '0',
      source:           'cancellation_recovery',
      isFromPortal:     true,
    }).returning({ id: reservations.id })

    await db.update(cancellationRecoveries).set({ newReservationId: newRes!.id }).where(eq(cancellationRecoveries.id, rec.id))

    const roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, rec.roomTypeId), eq(roomTypes.propertyId, getPropertyId())) })

    const session = await s.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:                 'payment',
      currency:              await getStripeCurrency(),
      line_items: [{
        quantity: 1,
        price_data: {
          currency:     await getStripeCurrency(),
          unit_amount:  Math.round(parseFloat(rec.discountedAmount) * 100),
          product_data: {
            name:        `${(await getBranding()).name} — Reserva con ${rec.discountPct}% dto.`,
            description: `${rec.checkIn} → ${rec.checkOut} · antes ${parseFloat(rec.baseAmount).toFixed(2)} €`,
          },
        },
      }],
      customer_email: g.email ?? undefined,
      metadata: {
        property_id:   String(getPropertyId()),
        reservationId:            String(newRes!.id),
        roomTypeId:                String(rec.roomTypeId),
        roomTypeName:              roomType?.name ?? '',
        checkIn:                   rec.checkIn,
        checkOut:                  rec.checkOut,
        cancellationRecoveryToken: token,
      },
      success_url: await pu(`/booking/success?session_id={CHECKOUT_SESSION_ID}`),
      cancel_url:  await pu(`/booking?cancelled=1`),
      expires_at:  Math.floor(Date.now() / 1000) + 30 * 60,
    })

    return c.redirect(session.url!, 302)
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/booking/confirm — datos de confirmación (fallback de webhook) ─

app.get('/booking/confirm', zValidator('query', z.object({
  session_id: z.string(),
})), async (c) => {
  try {
    const s       = await requireStripe()
    const session = await s.checkout.sessions.retrieve(c.req.valid('query').session_id)
    const resId   = parseInt(session.metadata?.reservationId ?? '0')
    if (!resId) return c.json({ error: 'No encontrado' }, 404)
    // La sesión debe ser de ESTE tenant (si lleva property_id en la metadata)
    if (session.metadata?.property_id && session.metadata.property_id !== String(getPropertyId())) {
      return c.json({ error: 'No encontrado' }, 404)
    }

    // Fallback: si Stripe dice pagado pero el webhook aún no actualizó la BD, lo hacemos aquí
    if (session.payment_status === 'paid') {
      // Carrito recuperado con descuento → marcarlo en el registro (idempotente)
      if (session.metadata?.recoveryToken) {
        await db.update(abandonedCarts)
          .set({ recoveredAt: new Date(), recoveredAmount: ((session.amount_total ?? 0) / 100).toFixed(2) })
          .where(and(
            eq(abandonedCarts.recoveryToken, session.metadata.recoveryToken),
            isNull(abandonedCarts.recoveredAt),
          )).catch(() => {})
      }
      // Reserva cancelada reenganchada con descuento → marcarla en el registro (idempotente)
      if (session.metadata?.cancellationRecoveryToken) {
        await db.update(cancellationRecoveries)
          .set({ recoveredAt: new Date(), recoveredAmount: ((session.amount_total ?? 0) / 100).toFixed(2) })
          .where(and(
            eq(cancellationRecoveries.recoveryToken, session.metadata.cancellationRecoveryToken),
            isNull(cancellationRecoveries.recoveredAt),
          )).catch(() => {})
      }
      const existing = await db.query.reservations.findFirst({
        where: resWhere(resId),
        columns: { amountPaid: true, status: true },
      })
      const alreadyPaid = parseFloat((existing?.amountPaid as string) ?? '0')

      if (alreadyPaid < 0.01) {
        const amountPaid  = (session.amount_total ?? 0) / 100
        const roomTypeId  = parseInt(session.metadata?.roomTypeId ?? '0')
        const checkIn     = session.metadata?.checkIn  as string
        const checkOut    = session.metadata?.checkOut as string

        const availableRoom = await db.execute(sql`
          SELECT r.id FROM rooms r
          WHERE r.room_type_id = ${roomTypeId} AND r.property_id = ${getPropertyId()} AND r.active = true
            AND r.id NOT IN (
              SELECT COALESCE(room_id, 0) FROM reservations
              WHERE property_id = ${getPropertyId()} AND room_id IS NOT NULL
                AND status NOT IN ('cancelled','no_show','tentative')
                AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
            )
            AND r.id NOT IN (
              SELECT jsonb_array_elements_text(extra_room_ids)::int FROM reservations
              WHERE property_id = ${getPropertyId()} AND extra_room_ids IS NOT NULL
                AND status NOT IN ('cancelled','no_show','tentative')
                AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
            )
            AND r.id NOT IN (
              SELECT bb.room_id FROM blocked_beds bb
              WHERE bb.property_id = ${getPropertyId()}
                AND bb.block_date >= ${checkIn}::date AND bb.block_date < ${checkOut}::date
            )
          LIMIT 1
        `) as unknown as { id: number }[]

        await db.update(reservations)
          .set({
            status:     'confirmed',
            roomId:     availableRoom[0]?.id ?? null,
            amountPaid: amountPaid.toFixed(2),
            updatedAt:  new Date(),
          } as any)
          .where(resWhere(resId))

        const account = await stripeAccount()
        if (account) {
          // Evitar duplicar la transacción si el webhook ya la insertó
          const existingTx = await db.query.financialTransactions.findFirst({
            where: and(
              eq(financialTransactions.reservationId, resId),
              sql`online_payment_id = ${session.id}`,
            ),
          })
          if (!existingTx) {
            await db.insert(financialTransactions).values({
              propertyId:          getPropertyId(),
              reservationId:       resId,
              financialAccountId:  account.id,
              amount:              amountPaid.toFixed(2),
              currencyId:          await getCurrencyId(),
              paymentMethod:       'stripe',
              description:         `Pago web — sesión ${session.id}`,
              transactionDate:     isoDate(new Date()),
              onlinePaymentId:     session.id,
              onlinePaymentStatus: 'paid',
            } as any)
            await syncAutoInvoice(resId)
          }
        }

        // Notificación a recepción (fallback cuando el webhook no ha llegado aún)
        notifyReception(resId, amountPaid, session.metadata?.roomTypeName ?? '').catch(() => {})
      }
    }

    const res = await db.query.reservations.findFirst({
      where: resWhere(resId),
      with:  { guest: true, room: true, rate: true },
    })

    return c.json({ data: res })
  } catch (err) { return serverError(c, err) }
})

// ─── Google Places (proxy — la API key nunca sale del servidor) ───────────────

const placesHits = new Map<string, { n: number; at: number }>()
function placesRateLimited(ip: string): boolean {
  const now = Date.now()
  const h = placesHits.get(ip)
  if (!h || now - h.at > 60_000) { placesHits.set(ip, { n: 1, at: now }); return false }
  h.n++
  return h.n > 40 // 40 req/min por IP
}

app.get('/places/autocomplete', zValidator('query', z.object({
  q: z.string().min(3).max(120),
})), async (c) => {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) return c.json({ error: 'Autocompletado no configurado' }, 503)
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
    if (placesRateLimited(ip)) return c.json({ error: 'Demasiadas peticiones' }, 429)

    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body:    JSON.stringify({ input: c.req.valid('query').q, languageCode: 'es' }),
    })
    const d: any = await r.json()
    if (!r.ok) return c.json({ error: d.error?.message ?? 'Error de Google Places' }, 502)

    const data = (d.suggestions ?? [])
      .map((s: any) => ({ placeId: s.placePrediction?.placeId, text: s.placePrediction?.text?.text }))
      .filter((s: any) => s.placeId && s.text)
      .slice(0, 6)
    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

app.get('/places/details/:placeId', async (c) => {
  try {
    const key = process.env.GOOGLE_PLACES_API_KEY
    if (!key) return c.json({ error: 'Autocompletado no configurado' }, 503)
    const placeId = c.req.param('placeId')
    if (!/^[A-Za-z0-9_-]{5,300}$/.test(placeId)) return c.json({ error: 'placeId inválido' }, 400)
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
    if (placesRateLimited(ip)) return c.json({ error: 'Demasiadas peticiones' }, 429)

    const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}?languageCode=es`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'addressComponents,formattedAddress' },
    })
    const d: any = await r.json()
    if (!r.ok) return c.json({ error: d.error?.message ?? 'Error de Google Places' }, 502)

    const comp = (type: string, short = false) => {
      const x = (d.addressComponents ?? []).find((ac: any) => ac.types?.includes(type))
      return x ? (short ? x.shortText : x.longText) as string : ''
    }
    const route  = comp('route')
    const number = comp('street_number')
    const city   = comp('locality') || comp('postal_town') || comp('administrative_area_level_3') || comp('administrative_area_level_2')

    return c.json({ data: {
      address1:    [route, number].filter(Boolean).join(' ') || (d.formattedAddress ?? '').split(',')[0] || '',
      zipCode:     comp('postal_code'),
      city,
      countryCode: comp('country', true).toUpperCase(),
      formatted:   d.formattedAddress ?? '',
    } })
  } catch (err) { return serverError(c, err) }
})

// ─── Contrato de huésped: helper ──────────────────────────────────────────────

async function contractDataFor(reservationId: number): Promise<ContractData | null> {
  const res = await db.query.reservations.findFirst({
    where: resWhere(reservationId),
    with:  { guest: true, room: { with: { roomType: true } }, rate: true },
  })
  if (!res) return null
  const g = res.guest as any
  return {
    guestName:     `${g.firstName} ${g.lastName}${g.secondLastName ? ' ' + g.secondLastName : ''}`,
    idDocType:     g.idDocType ?? null,
    idDocNumber:   g.idDocNumber ?? null,
    checkIn:       res.checkInDate,
    checkOut:      res.checkOutDate,
    roomCode:      (res.room as any)?.code ?? '—',
    roomTypeName:  (res.room as any)?.roomType?.name ?? '—',
    people:        res.people,
    rateTitle:     (res.rate as any)?.title ?? 'DIRECT',
    total:         res.total,
    reservationId: res.id,
  }
}

// ─── GET /api/public/contract-terms — condiciones de admisión del tenant (HTML) ─
// Sustituye al PDF estático: salen de properties.admissionTermsHtml (con
// variables {{hotel}}, {{cif}}…) o de la plantilla genérica.
app.get('/contract-terms', async (c) => {
  try {
    return c.html(renderAdmissionTermsPage(await getBranding(), (await getProperty()).admissionTermsHtml))
  } catch (err) { return serverError(c, err) }
})

// ─── GET /api/public/contract/:token — datos del contrato para firmar ─────────

app.get('/contract/:token', async (c) => {
  try {
    const token = c.req.param('token')
    const contract = await db.query.guestContracts.findFirst({ where: and(eq(guestContracts.token, token), eq(guestContracts.propertyId, getPropertyId())) })
    if (!contract || contract.status === 'cancelled') return c.json({ error: 'Contrato no encontrado' }, 404)
    if (contract.status === 'signed') return c.json({ data: { status: 'signed' } })
    if (contract.expiresAt < new Date()) return c.json({ error: 'El enlace ha caducado. Pide uno nuevo en recepción.' }, 410)

    const data = await contractDataFor(contract.reservationId)
    if (!data) return c.json({ error: 'Reserva no encontrada' }, 404)

    return c.json({ data: { status: 'pending', html: renderContract(data, await getBranding(), (await getProperty()).admissionTermsHtml), guestName: data.guestName } })
  } catch (err) { return serverError(c, err) }
})

// ─── POST /api/public/contract/:token/sign — guardar la firma ─────────────────

app.post('/contract/:token/sign', zValidator('json', z.object({
  signature: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(800_000),
})), async (c) => {
  try {
    const token = c.req.param('token')
    const { signature } = c.req.valid('json')

    const contract = await db.query.guestContracts.findFirst({ where: and(eq(guestContracts.token, token), eq(guestContracts.propertyId, getPropertyId())) })
    if (!contract || contract.status === 'cancelled') return c.json({ error: 'Contrato no encontrado' }, 404)
    if (contract.status === 'signed') return c.json({ error: 'Este contrato ya está firmado' }, 409)
    if (contract.expiresAt < new Date()) return c.json({ error: 'El enlace ha caducado. Pide uno nuevo en recepción.' }, 410)

    const data = await contractDataFor(contract.reservationId)
    if (!data) return c.json({ error: 'Reserva no encontrada' }, 404)

    const signedAt = new Date()
    const signedIp = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
      ?? c.req.header('x-real-ip') ?? ''

    await db.update(guestContracts)
      .set({
        status:       'signed',
        contractHtml: renderContract(data, await getBranding(), (await getProperty()).admissionTermsHtml, { signaturePng: signature, signedAt, signedIp }),
        signedAt,
        signedIp,
      })
      .where(and(eq(guestContracts.id, contract.id), eq(guestContracts.propertyId, getPropertyId())))

    // Si el check-in registró el contrato como pendiente, marcarlo como completado
    if (contract.reservationId) {
      await db.update(reservations)
        .set({ checkinHadContract: true, updatedAt: new Date() })
        .where(and(eq(reservations.id, contract.reservationId), eq(reservations.propertyId, getPropertyId()), eq(reservations.checkinHadContract, false)))
    }

    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// ─── Plantillas de email ───────────────────────────────────────────────────────


function receptionNotificationEmail(opts: {
  branding: Branding
  resId: number; name: string; email: string; phone?: string | null
  checkIn: string; checkOut: string; nights: number
  roomType: string; total: number; channel: string; comments?: string | null
}) {
  const commentsRow = opts.comments
    ? `<div style="margin-top:12px;padding:10px 14px;background:#fef9c3;border-left:3px solid #f59e0b;border-radius:4px">
        <strong>Comentarios del cliente:</strong><br>${opts.comments}
       </div>`
    : ''
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
    <h2 style="margin-bottom:4px;color:#1d4ed8">🏨 Nueva reserva web</h2>
    <p style="color:#555;margin-top:0">Reserva confirmada y pagada online</p>
    <hr style="border:none;border-top:1px solid #eee">
    <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:16px 0">
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Reserva nº</span> <strong>#${opts.resId}</strong></div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Huésped</span> <strong>${opts.name}</strong></div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Email</span> ${opts.email}</div>
      ${opts.phone ? `<div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Teléfono</span> ${opts.phone}</div>` : ''}
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Llegada</span> <strong>${opts.checkIn}</strong></div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Salida</span> <strong>${opts.checkOut}</strong></div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Noches</span> ${opts.nights}</div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Tipo</span> ${opts.roomType}</div>
      <div style="margin-bottom:8px"><span style="color:#777;min-width:110px;display:inline-block">Canal</span> ${opts.channel}</div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #ddd"><span style="color:#777;min-width:110px;display:inline-block">Total pagado</span> <strong style="font-size:16px">${opts.total.toFixed(2)} €</strong></div>
    </div>
    ${commentsRow}
    <p style="margin-top:16px"><a href="${publicBase(opts.branding)}/reservations/${opts.resId}" style="background:#1d4ed8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Ver reserva en el panel</a></p>
    <p style="font-size:12px;color:#aaa;margin-top:24px">${escHtml(opts.branding.name)} · Sistema de reservas online</p>
  </div>`
}

async function notifyReception(resId: number, amountPaid: number, roomTypeName: string) {
  if (!resend) return
  try {
    const res = await db.query.reservations.findFirst({
      where: resWhere(resId),
      with:  { guest: true, room: { with: { roomType: true } }, bookingChannel: true },
    })
    if (!res?.guest) return
    const branding = await getBranding()
    if (!branding.receptionEmail) return
    const g      = res.guest as any
    const nights = Math.round((new Date(res.checkOutDate + 'T12:00:00').getTime() - new Date(res.checkInDate + 'T12:00:00').getTime()) / 86400000)
    await resend.emails.send({
      from:    fromOf(branding),
      to:      branding.receptionEmail,
      subject: `Nueva reserva web #${resId} — ${g.firstName} ${g.lastName} (${res.checkInDate})`,
      html:    receptionNotificationEmail({
        branding,
        resId,
        name:     `${g.firstName} ${g.lastName}`,
        email:    g.email ?? '—',
        phone:    g.phone,
        checkIn:  res.checkInDate,
        checkOut: res.checkOutDate,
        nights,
        roomType: (res.room as any)?.roomType?.name ?? roomTypeName,
        total:    amountPaid,
        channel:  (res as any).bookingChannel?.name ?? 'Web',
        comments: (res as any).extraField2,
      }),
    })
  } catch { /* best-effort */ }
}

function magicLinkEmail(opts: { email: string; link: string; branding: Branding }) {
  return `
  <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
    <h2 style="margin-bottom:4px">${escHtml(opts.branding.name)}</h2>
    <p style="color:#555;margin-top:0">Acceso a tu área de cliente</p>
    <hr style="border:none;border-top:1px solid #eee">
    <p>Hola, aquí tienes tu enlace de acceso (válido 15 minutos):</p>
    <div style="text-align:center;margin:28px 0">
      <a href="${opts.link}"
         style="background:#2563eb;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px">
        Acceder a mis reservas
      </a>
    </div>
    <p style="font-size:12px;color:#aaa">Si no solicitaste este acceso, ignora este email.<br>${escHtml(opts.branding.name)}${opts.branding.city ? ' · ' + escHtml(opts.branding.city) : ''}</p>
  </div>`
}

export default app
