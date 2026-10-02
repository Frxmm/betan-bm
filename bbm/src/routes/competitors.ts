import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { competitorHotels, competitorPrices, rateDailyPrices, rates, roomTypes } from '../db/schema'
import { eq, and, gte, lte, inArray, not } from 'drizzle-orm'
import { isAdmin, canUseFdm } from '../middleware/auth'
import { serverError, notFound } from '../lib/errors'
import { getPropertyId, hasFeature } from '../lib/property'
import { refreshCompetitor } from '../lib/competitorPricing'
import { resolvePrice, rateChainIds, roomTypeChainIds, cheapestForRate } from '../lib/price-resolver'

const app = new Hono()

// Módulo opcional: si el tenant no tiene 'competitors' activo, la ruta no existe.
app.use('*', async (c, next) => {
  if (!(await hasFeature('competitors'))) return c.json({ error: 'Módulo de competidores no activado' }, 404)
  await next()
})

// GET /api/competitors — lista de hoteles competidores configurados. Visible
// (solo lectura) también para recepción; solo admin/dirección puede
// añadir/editar/borrar/refrescar (ver el resto de rutas de este archivo).
app.get('/', async (c) => {
  try {
    if (!canUseFdm(c)) return c.json({ error: 'Sin permisos' }, 403)
    const list = await db.select().from(competitorHotels).where(eq(competitorHotels.propertyId, getPropertyId())).orderBy(competitorHotels.name)
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

const competitorSchema = z.object({
  name:     z.string().min(1),
  platform: z.enum(['paraty', 'cloudbeds']),
  config:   z.record(z.string(), z.string()),
  active:   z.boolean().optional(),
  // Precio de mostrador ÷ este valor = precio "efectivo" comparable (Genius +
  // rebaja adicional en Booking.com) — varía por hotel, de ahí que sea
  // configurable en vez de una constante fija. 1 = sin ajustar.
  bookingEffectiveDivisor: z.number().positive().optional(),
})

// POST /api/competitors — añadir un competidor
app.post('/', zValidator('json', competitorSchema), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const body = c.req.valid('json')
    const [row] = await db.insert(competitorHotels).values({
      propertyId: getPropertyId(), name: body.name, platform: body.platform, config: body.config,
      active: body.active ?? true,
      ...(body.bookingEffectiveDivisor != null ? { bookingEffectiveDivisor: String(body.bookingEffectiveDivisor) } : {}),
    }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/competitors/:id — editar/activar-desactivar
app.patch('/:id', zValidator('json', competitorSchema.partial()), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const { bookingEffectiveDivisor, ...rest } = c.req.valid('json')
    const patch: Record<string, any> = { ...rest }
    if (bookingEffectiveDivisor != null) patch.bookingEffectiveDivisor = String(bookingEffectiveDivisor)
    const [row] = await db.update(competitorHotels).set(patch).where(and(eq(competitorHotels.id, id), eq(competitorHotels.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c, 'Competidor')
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/competitors/:id
app.delete('/:id', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [row] = await db.delete(competitorHotels).where(and(eq(competitorHotels.id, id), eq(competitorHotels.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c, 'Competidor')
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// POST /api/competitors/:id/refresh — forzar actualización de precios ahora
app.post('/:id/refresh', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const result = await refreshCompetitor(id)
    if (!result.ok) return c.json({ error: result.error ?? 'Error al actualizar' }, 502)
    return c.json({ data: result })
  } catch (err) { return serverError(c, err) }
})

// GET /api/competitors/prices?from&to — comparativa: nuestro precio base
// (tarifa raíz, sin reglas dinámicas) por día contra el de cada competidor,
// para el gráfico de la pestaña Competidores en PriceCalendarView.
app.get('/prices', zValidator('query', z.object({
  from:       z.string().date(),
  to:         z.string().date(),
  rateId:     z.coerce.number().int().positive().optional(),
  roomTypeId: z.coerce.number().int().positive().optional(),
})), async (c) => {
  try {
    if (!canUseFdm(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { from, to, rateId, roomTypeId } = c.req.valid('query')

    const days: string[] = []
    for (let d = new Date(`${from}T00:00:00`); d <= new Date(`${to}T00:00:00`); d.setDate(d.getDate() + 1)) {
      days.push(d.toISOString().slice(0, 10))
    }

    const [hotels, compPrices, webRates, allRates, allRoomTypes] = await Promise.all([
      db.select().from(competitorHotels).where(and(eq(competitorHotels.propertyId, getPropertyId()), eq(competitorHotels.active, true))).orderBy(competitorHotels.name),
      db.select({
          id: competitorPrices.id, competitorId: competitorPrices.competitorId, date: competitorPrices.date,
          price: competitorPrices.price, fetchedAt: competitorPrices.fetchedAt,
        }).from(competitorPrices)
        .innerJoin(competitorHotels, eq(competitorHotels.id, competitorPrices.competitorId))
        .where(and(eq(competitorHotels.propertyId, getPropertyId()), gte(competitorPrices.date, from), lte(competitorPrices.date, to))),
      // Tarifas activas para el motor de reservas — mismo criterio que
      // GET /public/availability, para comparar contra el precio que de
      // verdad vería hoy un cliente nuevo, no un precio de referencia interno.
      db.query.rates.findMany({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true), eq(rates.activeForBookingEngine, true)) }),
      db.query.rates.findMany({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true)) }),
      db.query.roomTypes.findMany({ where: and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true)) }),
    ])

    // Por defecto se compara la más barata entre todas las tarifas activas
    // para el motor de reservas (el "desde X €" que ve un cliente nuevo).
    // Si se pide una tarifa concreta (rateId), se compara solo esa — puede
    // ser cualquier tarifa activa, no solo las del motor de reservas, para
    // poder comparar también una tarifa interna/no publicada.
    let compareRates = webRates
    if (rateId != null) {
      const one = allRates.find(r => r.id === rateId)
      if (!one) return c.json({ error: 'Tarifa no encontrada' }, 404)
      compareRates = [one]
    }
    // Si se pide un tipo de habitación concreto, se compara SOLO ese (en vez
    // de la más barata entre todos) — para poder comparar exactamente la
    // misma fila que se ve en el Calendario de precios, que lista un precio
    // por cada tipo de habitación, no uno solo por tarifa.
    let compareRoomType: typeof allRoomTypes[number] | null = null
    if (roomTypeId != null) {
      compareRoomType = allRoomTypes.find(rt => rt.id === roomTypeId) ?? null
      if (!compareRoomType) return c.json({ error: 'Tipo de habitación no encontrado' }, 404)
    }

    const ratesById     = new Map(allRates.map(r => [r.id, r]))
    const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
    const rateIds     = new Set<number>()
    for (const r of compareRates) for (const id of rateChainIds(r as any, ratesById as any)) rateIds.add(id)
    const roomTypeIds = new Set<number>()
    for (const rt of allRoomTypes) for (const id of roomTypeChainIds(rt as any, roomTypesById as any)) roomTypeIds.add(id)

    const dailyPrices = rateIds.size
      ? await db.select().from(rateDailyPrices).where(and(
          inArray(rateDailyPrices.rateId, [...rateIds]),
          gte(rateDailyPrices.date, from),
          lte(rateDailyPrices.date, to),
          not(rateDailyPrices.closed),
        ))
      : []

    // "Nuestro precio" de un día = el más barato entre todas las combinaciones
    // (tarifa(s) a comparar × tipo de habitación) — el mismo "desde X €" que
    // vería un cliente nuevo en la web (o, si se eligió una tarifa concreta,
    // el precio de esa tarifa), comparable con el precio más barato que
    // devuelve cada competidor.
    const ourByDate = new Map<string, number>()
    for (const date of days) {
      let cheapest: number | null = null
      for (const rate of compareRates) {
        if (compareRoomType) {
          const occupancy = (compareRoomType as any).maxOccupancy ?? 1
          const price = resolvePrice(ratesById as any, roomTypesById as any, dailyPrices as any, rate.id, compareRoomType.id, date, occupancy)
          if (price != null && (cheapest == null || price < cheapest)) cheapest = price
        } else {
          const best = cheapestForRate(ratesById as any, roomTypesById as any, dailyPrices as any, rate as any, allRoomTypes as any, date)
          if (best != null && (cheapest == null || best.price < cheapest)) cheapest = best.price
        }
      }
      if (cheapest != null) ourByDate.set(date, cheapest)
    }

    const compByHotel = new Map<number, Map<string, number | null>>()
    for (const p of compPrices) {
      const m = compByHotel.get(p.competitorId) ?? new Map()
      // 0 (o negativo) se trata igual que null — precio nulo es "sin
      // disponibilidad ese día", no un precio real de 0€.
      const price = p.price != null ? parseFloat(p.price) : null
      m.set(p.date, price != null && price > 0 ? price : null)
      compByHotel.set(p.competitorId, m)
    }

    // Serie de fechas del rango completo, con nuestro precio y el de cada
    // competidor activo (null si no hay dato ese día).
    const series = days.map(date => ({
      date,
      ours: ourByDate.get(date) ?? null,
      ...Object.fromEntries(hotels.map(h => [`c_${h.id}`, compByHotel.get(h.id)?.get(date) ?? null])),
    }))

    return c.json({ data: { hotels, series } })
  } catch (err) { return serverError(c, err) }
})

export default app
