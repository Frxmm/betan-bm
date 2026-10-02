// Empresas (por CIF de facturación) y ofertas de precio fijo semanal — solo
// dirección. Ver src/lib/corporateDetection.ts (qué cuenta como empresa) y
// src/db/schema/corporate.ts (ofertas).
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, corporateOffers, roomTypes, invoices } from '../db/schema'
import { and, desc, eq, isNotNull, ne } from 'drizzle-orm'
import { isAdmin } from '../middleware/auth'
import { notFound, serverError } from '../lib/errors'
import { isCompanyNif } from '../lib/corporateDetection'
import { getPropertyId } from '../lib/property'

const app = new Hono()
const STATUS = ['draft', 'sent', 'accepted', 'rejected', 'expired'] as const

// GET /api/corporate/companies — agregado de reservas con CIF de empresa.
app.get('/companies', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    // El CIF de una reserva puede estar en dos sitios: reservations.billingNif
    // (lo típico si se pidió al reservar) o SOLO en la factura
    // (invoices.billingNif — lo típico si se pidió factura a nombre de la
    // empresa después, al pagar). Sin mirar las facturas se perdían empresas
    // reales que solo dejaron su CIF ahí.
    const [resRows, invRows] = await Promise.all([
      db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), ne(reservations.status, 'cancelled')),  // sin filtrar por billingNif aquí: el CIF puede venir solo de la factura
        columns: {
          id: true, billingName: true, billingNif: true,
          checkInDate: true, checkOutDate: true, total: true, status: true, bookedAt: true,
        },
        with: { guest: { columns: { firstName: true, lastName: true } } },
      }),
      db.select({
        reservationId: invoices.reservationId, billingName: invoices.billingName, billingNif: invoices.billingNif,
      }).from(invoices).where(and(eq(invoices.propertyId, getPropertyId()), isNotNull(invoices.billingNif))),
    ])
    // Última factura con CIF por reserva — si hay varias, la más reciente
    // manda (es la que de verdad se usó al final).
    const invoiceByRes = new Map<number, { billingName: string | null; billingNif: string | null }>()
    for (const inv of invRows) {
      if (inv.reservationId != null) invoiceByRes.set(inv.reservationId, { billingName: inv.billingName, billingNif: inv.billingNif })
    }

    type ResSummary = { id: number; guestName: string; checkIn: string; checkOut: string; total: number; status: string }
    type Agg = {
      name: string; nif: string; reservations: number; nights: number; revenue: number
      lastStay: string; firstStay: string; checkIns: string[]; reservationList: ResSummary[]
    }
    const byNif = new Map<string, Agg>()
    for (const r of resRows) {
      // El de la factura tiene prioridad sobre el de la propia reserva.
      const eff = invoiceByRes.get(r.id) ?? { billingName: r.billingName, billingNif: r.billingNif }
      if (!isCompanyNif(eff.billingNif)) continue
      const nif = eff.billingNif!.trim().toUpperCase()
      const checkIn = r.checkInDate, checkOut = r.checkOutDate
      const nights = Math.max(0, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000))
      let a = byNif.get(nif)
      if (!a) byNif.set(nif, a = { name: eff.billingName ?? nif, nif, reservations: 0, nights: 0, revenue: 0, lastStay: checkOut, firstStay: checkIn, checkIns: [], reservationList: [] })
      a.reservations++; a.nights += nights; a.revenue += parseFloat(r.total) || 0
      a.checkIns.push(checkIn)
      const g = r.guest as { firstName: string; lastName: string } | null
      a.reservationList.push({ id: r.id, guestName: g ? `${g.firstName} ${g.lastName}` : '—', checkIn, checkOut, total: parseFloat(r.total) || 0, status: r.status })
      if (checkOut > a.lastStay) a.lastStay = checkOut
      if (checkIn < a.firstStay) a.firstStay = checkIn
      if (eff.billingName) a.name = eff.billingName  // el más reciente con nombre gana
    }
    const offerCounts = await db.select({ nif: corporateOffers.companyNif }).from(corporateOffers).where(eq(corporateOffers.propertyId, getPropertyId()))
    const withOffer = new Set(offerCounts.map(o => o.nif))
    // Candidata a oferta: más de una reserva cuyos check-in caen dentro de una
    // misma ventana de 6 meses (182 días) — cliente recurrente de verdad, no una
    // sola empresa que reservó una vez para varios empleados.
    const SIX_MONTHS_DAYS = 182
    const hasTwoWithin2Months = (dates: string[]): boolean => {
      const sorted = [...dates].sort()
      for (let i = 0; i < sorted.length - 1; i++) {
        const gapDays = (new Date(sorted[i + 1]!).getTime() - new Date(sorted[i]!).getTime()) / 86400000
        if (gapDays <= SIX_MONTHS_DAYS) return true
      }
      return false
    }
    const data = [...byNif.values()]
      .filter(a => a.reservations > 1 && hasTwoWithin2Months(a.checkIns))
      .map(({ checkIns, reservationList, ...a }) => ({
        ...a, revenue: Math.round(a.revenue * 100) / 100, hasOffer: withOffer.has(a.nif),
        reservationList: [...reservationList].sort((x, y) => y.checkIn.localeCompare(x.checkIn)),
      }))
      .sort((x, y) => y.revenue - x.revenue)
    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

app.get('/offers', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const rows = await db.select().from(corporateOffers).where(eq(corporateOffers.propertyId, getPropertyId())).orderBy(desc(corporateOffers.createdAt))
    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

app.post('/offers', zValidator('json', z.object({
  companyName: z.string().min(1), companyNif: z.string().optional(), roomTypeId: z.number().int().optional(),
  weeklyPrice: z.number().positive(), validFrom: z.string().date(), validTo: z.string().date(), notes: z.string().optional(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const b = c.req.valid('json')
    if (b.validTo <= b.validFrom) return c.json({ error: 'validTo debe ser posterior a validFrom' }, 400)
    if (b.roomTypeId && !(await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, b.roomTypeId), eq(roomTypes.propertyId, getPropertyId())), columns: { id: true } })))
      return notFound(c, 'Tipo de habitación')
    const uid = Number((c.get('jwtPayload') as any)?.sub) || null
    const [row] = await db.insert(corporateOffers).values({ ...b, weeklyPrice: b.weeklyPrice.toFixed(2), propertyId: getPropertyId(), createdBy: uid }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

app.patch('/offers/:id', zValidator('json', z.object({ status: z.enum(STATUS) })), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id')); const { status } = c.req.valid('json')
    const now = new Date()
    const [row] = await db.update(corporateOffers).set({
      status, ...(status === 'sent' ? { sentAt: now } : {}), ...(['accepted', 'rejected'].includes(status) ? { decidedAt: now } : {}),
    }).where(and(eq(corporateOffers.id, id), eq(corporateOffers.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c, 'Oferta')
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

export default app
