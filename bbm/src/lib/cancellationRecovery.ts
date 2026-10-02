// ─── Reenganche de reservas canceladas con descuento ───────────────────────────
// Cada 10 min busca reservas recién canceladas (minAgeHours–maxAgeHours desde
// que se canceló, ver reservation_status_logs) con email real del huésped
// (no el alias @guest.booking.com), les calcula un descuento sobre el menor
// entre lo que pagaban antes y lo que costaría hoy esa misma estancia con la
// MISMA tarifa, y les manda un email/WhatsApp con enlace para volver a
// reservar. A diferencia de la recuperación de carritos, NO revive la reserva
// original (ya tiene su ciclo de cancelación cerrado) — el enlace crea una
// reserva NUEVA cuando se pulsa (ver /api/public/recover-cancellation/:token).
// La configuración se lee de cancellation_recovery_settings (editable en
// Tarifas > Promociones Web).

import { db } from '../db'
import {
  reservations, guests, rooms, rates, roomTypes, rateDailyPrices,
  cancellationRecoveries, cancellationRecoverySettings,
} from '../db/schema'
import { and, eq, gte, lte, inArray, notInArray, or, sql } from 'drizzle-orm'
import { getPropertyId, getBranding, forEachActiveProperty } from './property'
import { fromOf } from './email'
import { publicUrl } from './stripe'
import { resolvePrice, rateChainIds, roomTypeChainIds } from './price-resolver'
import { Resend } from 'resend'
import { sendWhatsappTemplate, isWhatsappConfigured } from './whatsapp'
import { channelEnabled, renderEmail } from './messaging'

const resend     = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

// Alias temporal de Booking.com — no es el email real del huésped, mandarle
// algo ahí no llega a nadie (o llega a Booking, no queremos eso).
const BOOKING_ALIAS = /@guest\.booking\.com$/i

async function loadSettings() {
  let [row] = await db.select().from(cancellationRecoverySettings).where(eq(cancellationRecoverySettings.propertyId, getPropertyId())).limit(1)
  if (!row) {
    ;[row] = await db.insert(cancellationRecoverySettings).values({ propertyId: getPropertyId() }).returning()
  }
  return row!
}

// Repricing de la estancia HOY, con la MISMA tarifa que tenía la reserva
// cancelada — null si no se puede calcular (tarifa/tipo eliminados, huecos
// de precio sin cubrir).
async function currentEquivalentPrice(rateId: number, roomTypeId: number, checkIn: string, checkOut: string): Promise<number | null> {
  const rate     = await db.query.rates.findFirst({ where: and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId())) })
  const roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, getPropertyId())) })
  if (!rate || !roomType) return null

  const [allRates, allRoomTypes] = await Promise.all([
    db.query.rates.findMany({ where: eq(rates.propertyId, rate.propertyId) }),
    db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, roomType.propertyId) }),
  ])
  const ratesById     = new Map(allRates.map(r => [r.id, r]))
  const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))

  const nights: string[] = []
  const cur = new Date(checkIn + 'T00:00:00Z')
  const end = new Date(checkOut + 'T00:00:00Z')
  while (cur < end) { nights.push(cur.toISOString().slice(0, 10)); cur.setUTCDate(cur.getUTCDate() + 1) }
  if (nights.length === 0) return null

  const priceRows = await db.select({
    rateId:     rateDailyPrices.rateId,
    date:       rateDailyPrices.date,
    price:      rateDailyPrices.price,
    roomTypeId: rateDailyPrices.roomTypeId,
  }).from(rateDailyPrices).where(and(
    inArray(rateDailyPrices.rateId, rateChainIds(rate, ratesById)),
    gte(rateDailyPrices.date, checkIn),
    lte(rateDailyPrices.date, nights.at(-1)!),
    or(
      inArray(rateDailyPrices.roomTypeId, roomTypeChainIds(roomType, roomTypesById)),
      sql`${rateDailyPrices.roomTypeId} IS NULL`,
    ),
  ))

  const occupancy = roomType.maxOccupancy ?? 1
  const prices = nights.map(d => resolvePrice(ratesById, roomTypesById, priceRows, rateId, roomTypeId, d, occupancy))
  if (!prices.every(p => p != null)) return null
  return Math.round(prices.reduce((s, p) => s + p!, 0) * 100) / 100
}

export async function sweepCancellations() {
  const cfg = await loadSettings()
  if (!cfg.enabled) return

  const branding = await getBranding()
  const now = Date.now()
  const today = new Date().toISOString().slice(0, 10)

  const already = db.select({ id: cancellationRecoveries.reservationId }).from(cancellationRecoveries)
  const candidates = await db.query.reservations.findMany({
    where: and(
      eq(reservations.propertyId, getPropertyId()),
      eq(reservations.status, 'cancelled'),
      sql`${reservations.checkInDate} >= ${today}`,   // estancia aún futura
      notInArray(reservations.id, already),
    ),
    with: { guest: true },
    limit: 50,
  })
  if (candidates.length === 0) return

  // Fecha real de cancelación (reservation_status_logs) — filtra la ventana
  // minAgeHours–maxAgeHours; sin log (reserva de antes de la migración 0035)
  // se cae a updatedAt.
  const ids = candidates.map(r => r.id)
  const cancelledAt: Record<number, Date> = {}
  const logRows = await db.execute(sql`
    SELECT DISTINCT ON (reservation_id) reservation_id, changed_at
    FROM reservation_status_logs
    WHERE reservation_id IN (${sql.join(ids.map(id => sql`${id}`), sql`,`)}) AND to_status = 'cancelled'
    ORDER BY reservation_id, changed_at DESC
  `) as unknown as { reservation_id: number; changed_at: Date }[]
  for (const row of logRows) cancelledAt[row.reservation_id] = new Date(row.changed_at)

  const minAgeMs = cfg.minAgeHours * 3_600_000
  const maxAgeMs = cfg.maxAgeHours * 3_600_000

  for (const res of candidates) {
    try {
      const g = res.guest as any
      if (!g?.email || BOOKING_ALIAS.test(g.email.trim())) {
        // No es un "email real" (o no hay ninguno) — no se registra siquiera,
        // no hay nada que reintentar en el próximo barrido.
        continue
      }

      const cAt = cancelledAt[res.id] ?? res.updatedAt
      const ageMs = now - cAt.getTime()
      if (ageMs < minAgeMs || ageMs > maxAgeMs) continue

      if (!res.roomId || !res.rateId) continue   // sin habitación/tarifa no hay qué repricear ni reofrecer
      const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, res.roomId), eq(rooms.propertyId, getPropertyId())), columns: { roomTypeId: true } })
      if (!room?.roomTypeId) continue

      const originalAmount = parseFloat(String(res.total))
      const currentAmount  = await currentEquivalentPrice(res.rateId, room.roomTypeId, res.checkInDate, res.checkOutDate)
      const baseAmount     = currentAmount != null ? Math.min(originalAmount, currentAmount) : originalAmount
      const discountPct    = cfg.discountPct
      const discountedAmount = Math.round(baseAmount * (100 - discountPct)) / 100

      const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')

      await db.insert(cancellationRecoveries).values({
        reservationId:    res.id,
        email:            g.email,
        phone:            g.phone ?? null,
        guestName:        `${g.firstName} ${g.lastName}`,
        checkIn:          res.checkInDate,
        checkOut:         res.checkOutDate,
        roomTypeId:       room.roomTypeId,
        rateId:           res.rateId,
        originalAmount:   originalAmount.toFixed(2),
        currentAmount:    currentAmount != null ? currentAmount.toFixed(2) : null,
        baseAmount:       baseAmount.toFixed(2),
        discountPct,
        discountedAmount: discountedAmount.toFixed(2),
        recoveryToken:    token,
        expiresAt:        new Date(now + cfg.validityHours * 3_600_000),
      })

      if (g.phone && await isWhatsappConfigured() && await channelEnabled('cancellation_recovery', 'whatsapp', res.bookingChannelId)) {
        const fmtD = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
        const wa = await sendWhatsappTemplate({
          to: g.phone, template: 'reenganche',
          params: [
            g.firstName, fmtD(res.checkInDate), fmtD(res.checkOutDate),
            String(discountPct), publicUrl(branding, `/api/public/recover-cancellation/${token}`),
          ],
        })
        if (wa.ok) {
          await db.update(cancellationRecoveries).set({ whatsappSentAt: new Date(), whatsappError: null })
            .where(eq(cancellationRecoveries.reservationId, res.id))
          console.log(`[cancellationRecovery] WhatsApp enviado — reserva ${res.id} (${discountPct}% dto.)`)
        } else {
          await db.update(cancellationRecoveries).set({ whatsappError: wa.error ?? 'Error desconocido' })
            .where(eq(cancellationRecoveries.reservationId, res.id))
          console.error(`[cancellationRecovery] WhatsApp falló — reserva ${res.id}: ${wa.error}`)
        }
      }

      let skipReason: string | null = null
      if (!resend || !branding.fromEmail) skipReason = 'Resend no está configurado en el servidor'
      else if (!await channelEnabled('cancellation_recovery', 'email', res.bookingChannelId)) {
        skipReason = 'Envío de reenganche por email desactivado (Ajustes → Mensajes)'
      }

      if (skipReason) {
        await db.update(cancellationRecoveries).set({ emailSkipReason: skipReason })
          .where(eq(cancellationRecoveries.reservationId, res.id))
        console.log(`[cancellationRecovery] email no intentado — reserva ${res.id}: ${skipReason}`)
      } else {
        const { subject, html } = await renderEmail('cancellation_recovery', {
          name:        g.firstName,
          checkIn:     res.checkInDate,
          checkOut:    res.checkOutDate,
          total:       baseAmount.toFixed(2),
          discounted:  discountedAmount.toFixed(2),
          discountPct,
          url:         publicUrl(branding, `/api/public/recover-cancellation/${token}`),
        })
        try {
          const result = await resend!.emails.send({ from: fromOf(branding), to: g.email, subject, html })
          if (result?.error) {
            const msg = result.error.message ?? String(result.error)
            await db.update(cancellationRecoveries).set({ emailError: msg, emailSkipReason: null })
              .where(eq(cancellationRecoveries.reservationId, res.id))
            console.error(`[cancellationRecovery] email falló — reserva ${res.id}: ${msg}`)
          } else {
            await db.update(cancellationRecoveries)
              .set({ emailSentAt: new Date(), emailError: null, emailSkipReason: null })
              .where(eq(cancellationRecoveries.reservationId, res.id))
            console.log(`[cancellationRecovery] email enviado — reserva ${res.id} (${g.email}, ${discountPct}% dto.)`)
          }
        } catch (e: any) {
          const msg = e?.message ?? 'Error de conexión al enviar'
          await db.update(cancellationRecoveries).set({ emailError: msg, emailSkipReason: null })
            .where(eq(cancellationRecoveries.reservationId, res.id))
          console.error(`[cancellationRecovery] email falló (excepción) — reserva ${res.id}: ${msg}`)
        }
      }
    } catch (e: any) {
      console.error(`[cancellationRecovery] error con reserva ${res.id}: ${e.message}`)
    }
  }
}

export function startCancellationRecoveryScheduler() {
  const run = () => forEachActiveProperty('cancellationRecovery', sweepCancellations, { feature: 'bookingEngine' })
  run().catch(e => console.error('[cancellationRecovery] error en arranque:', e))
  setInterval(() => {
    run().catch(e => console.error('[cancellationRecovery] error en sweep:', e))
  }, 10 * 60 * 1000)
  console.log('[cancellationRecovery] scheduler iniciado — sweep cada 10 min')
}
