// ─── Envíos WhatsApp (Cloud API) desde el admin ────────────────────────────────
// Check-in online y pago pendiente. El código de cerradura va en routes/ttlock.ts
// (con su regla de saldo cero). Solo recepción/dirección.

import { Hono } from 'hono'
import { db } from '../db'
import { reservations, userRoles, users } from '../db/schema'
import { eq } from 'drizzle-orm'
import { and } from 'drizzle-orm'
import { serverError, notFound } from '../lib/errors'
import { sendWhatsappTemplate, isWhatsappConfigured, waTemplateCatalog } from '../lib/whatsapp'
import { getPropertyId, hasFeature } from '../lib/property'
import { channelEnabled, portalLink } from '../lib/messaging'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import type { Context } from 'hono'

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('whatsapp')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// GET /api/whatsapp/templates — catálogo de plantillas (nombre efectivo, descripción, variables)
app.get('/templates', async (c) => {
  try { return c.json({ data: await waTemplateCatalog() }) } catch (err) { return serverError(c, err) }
})

function getUserId(c: Context): number | undefined {
  const id = Number((c.get('jwtPayload') as { sub?: string | number } | undefined)?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

async function allowed(c: Context): Promise<boolean> {
  const uid = getUserId(c)
  if (!uid) return false
  const [roleRows, u] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, uid)),
    db.query.users.findFirst({ where: and(eq(users.id, uid), eq(users.propertyId, getPropertyId())), columns: { isPrimary: true } }),
  ])
  const roles = roleRows.map(r => r.role as string)
  return u?.isPrimary === true || roles.includes('direccion') || roles.includes('recepcion')
}

const fmtD = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }

async function loadReservation(id: number) {
  return db.query.reservations.findFirst({
    where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    with:  { guest: true, room: true, bookingChannel: true },
  })
}

// Canales que cobran ellos mismos: el saldo local no es fiable, no se puede
// reclamar pago al huésped (puede haber pagado ya a través del canal)
function channelCollectsPayment(res: any): boolean {
  const ch = (res.bookingChannel?.name ?? '').toLowerCase()
  return ch.includes('booking')
}

// POST /api/whatsapp/checkin/:id — enlace de check-in online por WhatsApp
app.post('/checkin/:id', async (c) => {
  try {
    if (!await allowed(c))       return c.json({ error: 'Sin permisos' }, 403)
    if (!await isWhatsappConfigured()) return c.json({ error: 'WhatsApp no configurado' }, 503)
    const res = await loadReservation(Number(c.req.param('id')))
    if (!res) return notFound(c, 'Reserva')
    if (!await channelEnabled('checkin_link', 'whatsapp', res.bookingChannelId)) {
      return c.json({ error: 'Deshabilitado para este mensaje o canal de venta (Ajustes → Mensajes)' }, 422)
    }
    const g = res.guest as any
    if (!g?.phone) return c.json({ error: 'El huésped no tiene teléfono registrado' }, 422)
    if (!g?.email) return c.json({ error: 'El huésped necesita email registrado (el portal se identifica por email)' }, 422)

    const link = await portalLink(g.email)
    const r = await sendWhatsappTemplate({
      to: g.phone, template: 'checkin',
      params: [g.firstName, fmtD(res.checkInDate), fmtD(res.checkOutDate), link],
    })
    if (!r.ok) return c.json({ error: r.error }, 502)
    return c.json({ data: { sent: true } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/whatsapp/payment/:id — recordatorio de saldo pendiente por WhatsApp
app.post('/payment/:id', async (c) => {
  try {
    if (!await allowed(c))       return c.json({ error: 'Sin permisos' }, 403)
    if (!await isWhatsappConfigured()) return c.json({ error: 'WhatsApp no configurado' }, 503)

    const res = await loadReservation(Number(c.req.param('id')))
    if (!res) return notFound(c, 'Reserva')
    const g = res.guest as any
    if (!g?.phone) return c.json({ error: 'El huésped no tiene teléfono registrado' }, 422)
    if (!g?.email) return c.json({ error: 'El huésped necesita email registrado (el portal se identifica por email)' }, 422)

    // No cuenta los depósitos retenidos sin cobrar como pago de la estancia
    // (ver src/lib/paymentAggregate.ts) — si no, un depósito podría ocultar
    // saldo real pendiente en el recordatorio al huésped.
    const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const due = calcPendingBalance(res.total, realPaid)
    if (due <= 0.01) return c.json({ error: 'La reserva no tiene saldo pendiente' }, 422)
    if (channelCollectsPayment(res)) {
      return c.json({ error: 'Reserva de un canal que cobra por su cuenta: el pago puede haberse hecho por el canal — no se envían recordatorios de pago' }, 422)
    }
    if (!await channelEnabled('payment_reminder', 'whatsapp', res.bookingChannelId)) {
      return c.json({ error: 'Deshabilitado para este mensaje o canal de venta (Ajustes → Mensajes)' }, 422)
    }

    const link = await portalLink(g.email)
    const r = await sendWhatsappTemplate({
      to: g.phone, template: 'pago',
      params: [g.firstName, due.toFixed(2).replace('.', ',') + ' €', link],
    })
    if (!r.ok) return c.json({ error: r.error }, 502)
    return c.json({ data: { sent: true, due } })
  } catch (err) { return serverError(c, err) }
})

export default app
