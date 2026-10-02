// ─── Recuperación de carritos abandonados del booking engine ──────────────────
// Cada 10 min busca reservas web tentative sin pagar (minAgeMin – maxAgeHours de antigüedad),
// las registra en abandoned_carts y envía al cliente un email/WhatsApp con enlace
// de recuperación con descuento escalonado válido validityHours horas.
// La configuración se lee de cart_recovery_settings (editable en Tarifas > Promociones Web).

import { db } from '../db'
import { reservations, guests, abandonedCarts, cartRecoverySettings, type DiscountTier } from '../db/schema'
import { and, eq, ne, isNull, ilike, lt, gt, sql, notInArray } from 'drizzle-orm'
import { requireStripe, publicUrl } from './stripe'
import { Resend } from 'resend'
import { getPropertyId, getBranding, forEachActiveProperty } from './property'
import { fromOf } from './email'
import { sendWhatsappTemplate, isWhatsappConfigured } from './whatsapp'
import { channelEnabled, renderEmail } from './messaging'

const resend     = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null

async function loadSettings() {
  let [row] = await db.select().from(cartRecoverySettings).where(eq(cartRecoverySettings.propertyId, getPropertyId())).limit(1)
  if (!row) {
    ;[row] = await db.insert(cartRecoverySettings).values({ propertyId: getPropertyId() }).returning()
  }
  return row!
}

function getDiscountPct(total: number, tiers: DiscountTier[]): number {
  const sorted = [...tiers].sort((a, b) => b.threshold - a.threshold)
  for (const tier of sorted) {
    if (total > tier.threshold) return tier.pct
  }
  return sorted[sorted.length - 1]?.pct ?? 10
}

export function normalizeName(s: string): string {
  return s.trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
}

// Devuelve true si el huésped es un cliente nuevo según los criterios activos (AND).
async function isNewLead(
  g: any,
  resId: number,
  cfg: { targetNewPhone: boolean; targetNewName: boolean; targetFirstTime: boolean },
): Promise<boolean> {
  if (!g) return false

  // Criterio 1: teléfono no existe en ningún otro huésped
  if (cfg.targetNewPhone) {
    const phone = (g.phone as string | null)?.trim()
    if (phone) {
      const [row] = await db.select({ id: guests.id }).from(guests)
        .where(and(eq(guests.propertyId, getPropertyId()), eq(guests.phone, phone), ne(guests.id, g.id)))
        .limit(1)
      if (row) return false  // teléfono ya conocido → no es nuevo
    }
  }

  // Criterio 2: nombre+apellido normalizados no existen en ningún otro huésped
  if (cfg.targetNewName) {
    const fn = g.firstName?.trim()
    const ln = g.lastName?.trim()
    if (fn && ln) {
      const rows = await db.select({ id: guests.id, firstName: guests.firstName, lastName: guests.lastName })
        .from(guests)
        .where(and(eq(guests.propertyId, getPropertyId()), ilike(guests.firstName, fn), ilike(guests.lastName, ln), ne(guests.id, g.id)))
        .limit(20)
      const normFn = normalizeName(fn)
      const normLn = normalizeName(ln)
      const match = rows.find(r =>
        normalizeName(r.firstName ?? '') === normFn && normalizeName(r.lastName ?? '') === normLn,
      )
      if (match) return false  // nombre ya conocido → no es nuevo
    }
  }

  // Criterio 3: sin reservas anteriores completadas (primer contacto)
  if (cfg.targetFirstTime) {
    const [prior] = await db.select({ id: reservations.id }).from(reservations)
      .where(and(
        eq(reservations.propertyId, getPropertyId()),
        eq(reservations.guestId, g.id),
        ne(reservations.id, resId),
        notInArray(reservations.status, ['tentative', 'cancelled', 'no_show']),
      ))
      .limit(1)
    if (prior) return false  // ya ha reservado antes → no es nuevo
  }

  return true
}

export async function sweepAbandonedCarts() {
  const cfg = await loadSettings()
  if (!cfg.enabled) return

  const branding = await getBranding()
  const now    = Date.now()
  const tiers  = cfg.discountTiers as DiscountTier[]

  const already = db.select({ id: abandonedCarts.reservationId }).from(abandonedCarts)
  const carts = await db.query.reservations.findMany({
    where: and(
      eq(reservations.propertyId, getPropertyId()),
      eq(reservations.status, 'tentative'),
      eq(reservations.isFromPortal, true),
      isNull(reservations.roomId),
      sql`${reservations.amountPaid} = 0`,
      lt(reservations.createdAt, new Date(now - cfg.minAgeMin * 60_000)),
      gt(reservations.createdAt, new Date(now - cfg.maxAgeHours * 3_600_000)),
      notInArray(reservations.id, already),
    ),
    with: { guest: true },
    limit: 20,
  })

  for (const res of carts) {
    try {
      const g = res.guest as any

      let roomTypeId: number | null = null
      if (res.extraField1) {
        try {
          const s = await requireStripe()
          const session = await s.checkout.sessions.retrieve(res.extraField1)
          roomTypeId = parseInt(session.metadata?.roomTypeId ?? '0') || null
        } catch {}
      }

      const token       = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
      const total       = parseFloat(String(res.total))
      const discountPct = getDiscountPct(total, tiers)
      const newLead     = await isNewLead(g, res.id, cfg)

      await db.insert(abandonedCarts).values({
        reservationId: res.id,
        email:         g?.email ?? null,
        phone:         g?.phone ?? null,
        guestName:     g ? `${g.firstName} ${g.lastName}` : null,
        amount:        total.toFixed(2),
        checkIn:       res.checkInDate,
        checkOut:      res.checkOutDate,
        roomTypeId,
        recoveryToken: token,
        discountPct,
        expiresAt:     new Date(now + cfg.validityHours * 3_600_000),
      })

      if (!newLead) {
        await db.update(abandonedCarts)
          .set({ emailSkipReason: 'No es cliente nuevo (teléfono, nombre o estancia previa ya conocidos)' })
          .where(eq(abandonedCarts.reservationId, res.id))
        console.log(`[cartRecovery] carrito registrado sin envío — datos completos, no es lead nuevo (reserva ${res.id})`)
        continue
      }

      if (g?.phone && await isWhatsappConfigured() && await channelEnabled('cart_recovery', 'whatsapp', res.bookingChannelId)) {
        const fmtD = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
        const wa = await sendWhatsappTemplate({
          to: g.phone, template: 'carrito',
          params: [
            g.firstName, fmtD(res.checkInDate), fmtD(res.checkOutDate),
            String(discountPct), publicUrl(branding, `/api/public/recover/${token}`),
          ],
        })
        if (wa.ok) {
          await db.update(abandonedCarts).set({ whatsappSentAt: new Date(), whatsappError: null })
            .where(eq(abandonedCarts.reservationId, res.id))
          console.log(`[cartRecovery] WhatsApp enviado — reserva ${res.id} (${discountPct}% dto.)`)
        } else {
          await db.update(abandonedCarts).set({ whatsappError: wa.error ?? 'Error desconocido' })
            .where(eq(abandonedCarts.reservationId, res.id))
          console.error(`[cartRecovery] WhatsApp falló — reserva ${res.id}: ${wa.error}`)
        }
      }

      // Motivo de no-intento explícito para cada causa — antes se quedaban
      // silenciosos (solo el caso "sin email" se logueaba), así que en el
      // informe todos aparecían igual como "no intentado" sin decir por qué.
      let skipReason: string | null = null
      if (!g?.email)   skipReason = 'El huésped no dejó email'
      else if (!resend || !branding.fromEmail) skipReason = 'Resend no está configurado en el servidor'
      else if (!await channelEnabled('cart_recovery', 'email', res.bookingChannelId)) {
        skipReason = 'Envío de recuperación por email desactivado (Ajustes → Mensajes)'
      }

      if (skipReason) {
        await db.update(abandonedCarts).set({ emailSkipReason: skipReason })
          .where(eq(abandonedCarts.reservationId, res.id))
        console.log(`[cartRecovery] email no intentado — reserva ${res.id}: ${skipReason}`)
      } else {
        const { subject, html } = await renderEmail('cart_recovery', {
          name:        g.firstName,
          checkIn:     res.checkInDate,
          checkOut:    res.checkOutDate,
          total:       total.toFixed(2),
          discounted:  (total * (1 - discountPct / 100)).toFixed(2),
          discountPct,
          url:         publicUrl(branding, `/api/public/recover/${token}`),
        })
        // Resend NO lanza excepción en fallos de la API (p.ej. dominio no
        // verificado, destinatario inválido) — devuelve { error } en la
        // respuesta. Sin comprobarlo aquí, emailSentAt se marcaba igual aunque
        // el envío hubiera fallado de verdad.
        try {
          const result = await resend!.emails.send({ from: fromOf(branding), to: g!.email, subject, html })
          if (result?.error) {
            const msg = result.error.message ?? String(result.error)
            await db.update(abandonedCarts).set({ emailError: msg, emailSkipReason: null })
              .where(eq(abandonedCarts.reservationId, res.id))
            console.error(`[cartRecovery] email falló — reserva ${res.id}: ${msg}`)
          } else {
            await db.update(abandonedCarts)
              .set({ emailSentAt: new Date(), emailError: null, emailSkipReason: null })
              .where(eq(abandonedCarts.reservationId, res.id))
            console.log(`[cartRecovery] email enviado — reserva ${res.id} (${g!.email}, ${discountPct}% dto.)`)
          }
        } catch (e: any) {
          const msg = e?.message ?? 'Error de conexión al enviar'
          await db.update(abandonedCarts).set({ emailError: msg, emailSkipReason: null })
            .where(eq(abandonedCarts.reservationId, res.id))
          console.error(`[cartRecovery] email falló (excepción) — reserva ${res.id}: ${msg}`)
        }
      }
    } catch (e: any) {
      console.error(`[cartRecovery] error con reserva ${res.id}: ${e.message}`)
    }
  }
}

export function startCartRecoveryScheduler() {
  const run = () => forEachActiveProperty('cartRecovery', sweepAbandonedCarts, { feature: 'bookingEngine' })
  run().catch(e => console.error('[cartRecovery] error en arranque:', e))
  setInterval(() => {
    run().catch(e => console.error('[cartRecovery] error en sweep:', e))
  }, 10 * 60 * 1000)
  console.log('[cartRecovery] scheduler iniciado — sweep cada 10 min')
}
