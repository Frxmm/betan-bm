import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import {
  rates, rateDailyPrices, operators, bookingChannels,
  saleItems, depositItems, currencies, seasons, pricingRules, roomTypes, properties,
  reservationSaleItems, reservations, guests, rooms, priceChangeLog,
  demandPulseState,
} from '../db/schema'
import { eq, asc, desc, and, gte, lte, inArray, isNull, sql, count } from 'drizzle-orm'
import { users } from '../db/schema/core'
import { serverError, notFound } from '../lib/errors'
import { isAdmin } from '../middleware/auth'
import { getPropertyId } from '../lib/property'
import { getRootRateId } from '../lib/rootRate'
import {
  getCartRecoverySettings, getCancellationRecoverySettings, getTemporaryDiscountSettings,
  patchCartRecoverySettings, patchCancellationRecoverySettings, patchTemporaryDiscountSettings,
} from '../lib/promoSettings'
import { resolvePrice, rateChainIds, type RateForPricing, type RoomTypeForPricing, type DailyPriceRow } from '../lib/price-resolver'
import { avgLeadTimeDays, weeklyAdrByDate } from '../lib/occupancyReport'
import type { Context } from 'hono'

function getUserId(c: Context): number | undefined {
  const payload = c.get('jwtPayload') as { sub?: string | number } | undefined
  const id = Number(payload?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

const app = new Hono()

// ── RATES ─────────────────────────────────────────────────────────────────────

// GET /api/catalog/rates — todas las tarifas con relación operador
app.get('/rates', async (c) => {
  try {
    const list = await db.query.rates.findMany({
      where: and(eq(rates.active, true), eq(rates.propertyId, getPropertyId())),
      with:  { operator: true },
      orderBy: asc(rates.id),
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/catalog/rates — crear nueva tarifa
app.post('/rates', zValidator('json', z.object({
  title:                  z.string().min(1),
  code:                   z.string().nullable().optional(),
  description:            z.string().nullable().optional(),
  baseRateId:             z.number().int().positive().nullable().optional(),
  adjustType:             z.enum(['fixed', 'percentage', 'amount', 'per_person']).nullable().optional(),
  adjustValue:            z.number().optional(),
  operatorId:             z.number().int().positive().nullable().optional(),
  roomTypeId:             z.number().int().positive().nullable().optional(),
  minStay:                z.number().int().min(1).optional(),
  maxStay:                z.number().int().min(1).nullable().optional(),
  userEditable:           z.boolean().optional(),
  activeForBookingEngine: z.boolean().optional(),
  active:                 z.boolean().optional(),
})), async (c) => {
  try {
    const body = c.req.valid('json')
    const [created] = await db.insert(rates).values({
      propertyId:             getPropertyId(),
      title:                  body.title,
      code:                   body.code                   ?? null,
      description:            body.description            ?? null,
      baseRateId:             body.baseRateId             ?? null,
      adjustType:             body.adjustType             ?? null,
      adjustValue:            body.adjustValue != null ? String(body.adjustValue) : null,
      operatorId:             body.operatorId             ?? null,
      roomTypeId:             body.roomTypeId             ?? null,
      minStay:                body.minStay                ?? 1,
      maxStay:                body.maxStay                ?? null,
      userEditable:           body.userEditable           ?? true,
      activeForBookingEngine: body.activeForBookingEngine ?? false,
      active:                 body.active                 ?? true,
    }).returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

const rateUpdateSchema = z.object({
  title:        z.string().min(1).optional(),
  code:         z.string().nullable().optional(),
  adjustType:   z.enum(['fixed', 'percentage', 'amount', 'per_person']).nullable().optional(),
  adjustValue:  z.number().optional(),
  baseRateId:   z.number().int().positive().nullable().optional(),
  minStay:                 z.number().int().min(1).optional(),
  maxStay:                 z.number().int().min(1).nullable().optional(),
  userEditable:            z.boolean().optional(),
  activeForBookingEngine:  z.boolean().optional(),
  operatorId:              z.number().int().positive().nullable().optional(),
  roomTypeId:              z.number().int().positive().nullable().optional(),
  description:             z.string().nullable().optional(),
})

// PATCH /api/catalog/rates/:id — actualizar tarifa
app.patch('/rates/:id', zValidator('json', rateUpdateSchema), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')

    const existing = await db.query.rates.findFirst({ where: and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())) })
    if (!existing) return notFound(c, 'Tarifa')
    if (existing.locked) return c.json({ error: 'Tarifa bloqueada — desbloquea antes de editar' }, 403)

    const updates: Record<string, any> = { updatedAt: new Date() }
    if (body.title        !== undefined) updates.title        = body.title
    if (body.code         !== undefined) updates.code         = body.code
    if (body.adjustType   !== undefined) updates.adjustType   = body.adjustType
    if (body.adjustValue  !== undefined) updates.adjustValue  = body.adjustValue!.toFixed(2)
    if (body.baseRateId   !== undefined) updates.baseRateId   = body.baseRateId
    if (body.minStay                !== undefined) updates.minStay                = body.minStay
    if (body.maxStay                !== undefined) updates.maxStay                = body.maxStay
    if (body.userEditable           !== undefined) updates.userEditable           = body.userEditable
    if (body.activeForBookingEngine !== undefined) updates.activeForBookingEngine = body.activeForBookingEngine
    if (body.operatorId             !== undefined) updates.operatorId             = body.operatorId
    if (body.roomTypeId   !== undefined) updates.roomTypeId   = body.roomTypeId
    if (body.description  !== undefined) updates.description  = body.description

    const [updated] = await db.update(rates).set(updates).where(and(eq(rates.id, id), eq(rates.propertyId, getPropertyId()))).returning()
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/catalog/rates/:id/lock — bloquear tarifa (solo admin)
app.post('/rates/:id/lock', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const existing = await db.query.rates.findFirst({ where: and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())) })
    if (!existing) return notFound(c, 'Tarifa')
    const [updated] = await db.update(rates)
      .set({ locked: true, lockedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())))
      .returning()
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/catalog/rates/:id/unlock — desbloquear tarifa (solo admin)
app.post('/rates/:id/unlock', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const existing = await db.query.rates.findFirst({ where: and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())) })
    if (!existing) return notFound(c, 'Tarifa')
    const [updated] = await db.update(rates)
      .set({ locked: false, lockedAt: null, lockedBy: null, updatedAt: new Date() })
      .where(and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())))
      .returning()
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/catalog/rates/:id — eliminar tarifa (solo admin, soft-delete)
app.delete('/rates/:id', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const id = Number(c.req.param('id'))
    const existing = await db.query.rates.findFirst({ where: and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())) })
    if (!existing) return notFound(c, 'Tarifa')
    await db.update(rates).set({ active: false, updatedAt: new Date() }).where(and(eq(rates.id, id), eq(rates.propertyId, getPropertyId())))
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// ── RATE CALENDAR ─────────────────────────────────────────────────────────────

// GET /api/catalog/rates/calendar?dateFrom=&dateTo=&roomTypeIds=1,2&rateIds=3,5
// Filtra por tipo de habitación y/o tarifas concretas (ambos opcionales, se combinan con AND).
app.get('/rates/calendar', zValidator('query', z.object({
  dateFrom:    z.string().date(),
  dateTo:      z.string().date(),
  roomTypeIds: z.string().optional(),
  rateIds:     z.string().optional(),
})), async (c) => {
  try {
    const { dateFrom, dateTo, roomTypeIds, rateIds } = c.req.valid('query')

    const selectedRateIds = rateIds ? rateIds.split(',').map(Number).filter(Boolean) : null

    const [allRates, allRoomTypes, property] = await Promise.all([
      db.query.rates.findMany({
        where: and(eq(rates.active, true), eq(rates.propertyId, getPropertyId())),
        with:  { operator: true },
        orderBy: asc(rates.id),
      }),
      db.select().from(roomTypes).where(eq(roomTypes.propertyId, getPropertyId())).orderBy(asc(roomTypes.orderIndex)),
      db.query.properties.findFirst({
        where: eq(properties.id, getPropertyId()),
        columns: { defaultCalendarRateIds: true, defaultCalendarRoomTypeIds: true, defaultCalendarDays: true },
      }),
    ])

    // El filtro por roomTypeIds lo aplica el cliente al renderizar grupos
    const filteredRates = selectedRateIds
      ? allRates.filter(r => selectedRateIds.includes(r.id))
      : allRates

    // Construir mapas para el resolver de precios
    const ratesById     = new Map<number, RateForPricing>(allRates.map(r => [r.id, r as RateForPricing]))
    const roomTypesById = new Map<number, RoomTypeForPricing>(allRoomTypes.map(r => [r.id, r as RoomTypeForPricing]))

    // Recoger todos los rateIds necesarios (incluyendo cadenas de derivación)
    const neededRateIds = new Set<number>()
    for (const rate of allRates) {
      for (const id of rateChainIds(rate, ratesById)) neededRateIds.add(id)
    }

    const overrides = neededRateIds.size
      ? await db.select().from(rateDailyPrices).where(
          and(
            inArray(rateDailyPrices.rateId, [...neededRateIds]),
            gte(rateDailyPrices.date, dateFrom),
            lte(rateDailyPrices.date, dateTo),
          )
        )
      : []

    const priceRows: DailyPriceRow[] = overrides.map(o => ({
      rateId: o.rateId, roomTypeId: o.roomTypeId, date: o.date, price: o.price,
    }))

    // priceMap[rtKey][rateId][date] — rtKey = String(roomTypeId) | 'null'
    // Poblamos primero con las filas directas (para mantener closed)
    const priceMap: Record<string, Record<number, Record<string, { price: string; closed: boolean }>>> = {}
    for (const o of overrides) {
      const rtKey = o.roomTypeId != null ? String(o.roomTypeId) : 'null'
      ;(((priceMap[rtKey] ??= {})[o.rateId] ??= {}))[o.date] = { price: o.price, closed: o.closed }
    }

    // Completar huecos con resolvePrice() — cubre TANTO tipos de habitación
    // derivados COMO tarifas derivadas (rate.baseRateId) sobre un tipo de
    // habitación BASE. Antes esto solo se hacía para tipos de habitación
    // derivados (derivedRoomTypes), así que una tarifa derivada (p.ej. un
    // descuento % sobre una tarifa base) sin filas propias en rate_daily_prices
    // se quedaba sin precio para cualquier tipo de habitación base — resultaba
    // en 0€ en cualquier sitio que dependiera de este endpoint (p.ej. el cálculo
    // de importe extra al ampliar una reserva). Ahora se recorren TODOS los
    // tipos de habitación, no solo los derivados; resolvePrice() ya sigue las
    // dos cadenas de derivación (tarifa y tipo de habitación) y no hace nada
    // si ya hay una entrada directa.
    if (allRoomTypes.length > 0) {
      // Generar todas las fechas del rango
      const dates: string[] = []
      const cur = new Date(dateFrom + 'T12:00:00Z')
      const end = new Date(dateTo   + 'T12:00:00Z')
      while (cur <= end) {
        dates.push(cur.toISOString().slice(0, 10))
        cur.setDate(cur.getDate() + 1)
      }

      // closed de ancestros para tipos derivados
      const closedLookup = new Map<string, boolean>()
      for (const o of overrides) {
        if (o.roomTypeId != null) closedLookup.set(`${o.rateId}:${o.roomTypeId}:${o.date}`, o.closed)
      }
      function lookupClosed(rateId: number, rtId: number, date: string): boolean {
        let cur: number | null = rtId
        while (cur != null) {
          const v = closedLookup.get(`${rateId}:${cur}:${date}`)
          if (v !== undefined) return v
          cur = roomTypesById.get(cur)?.baseRoomTypeId ?? null
        }
        return false
      }

      for (const rt of allRoomTypes) {
        const rtKey      = String(rt.id)
        const occupancy  = (rt as any).maxOccupancy ?? 1
        for (const rate of allRates) {
          for (const date of dates) {
            // Solo rellenar si no hay ya una entrada directa
            if (priceMap[rtKey]?.[rate.id]?.[date]) continue
            const resolved = resolvePrice(ratesById, roomTypesById, priceRows, rate.id, rt.id, date, occupancy)
            if (resolved === null) continue
            const closed = lookupClosed(rate.id, rt.id, date)
            ;(((priceMap[rtKey] ??= {})[rate.id] ??= {}))[date] = { price: String(resolved), closed }
          }
        }
      }
    }

    // ── Disponibilidad ────────────────────────────────────────────────────────
    let availTotals:   Record<string, number>                   = {}
    let availOccupied: Record<string, Record<string, number>>   = {}
    let availOverrides: Record<string, Record<string, number>>  = {}

    try {
      // Habitaciones totales por tipo
      const roomTotalsRaw = await db.execute(sql`
        SELECT room_type_id, COUNT(*)::int AS total
        FROM rooms
        WHERE active = true AND property_id = ${getPropertyId()}
        GROUP BY room_type_id
      `) as unknown as { room_type_id: number; total: number }[]
      for (const r of roomTotalsRaw) availTotals[String(r.room_type_id)] = r.total

      // Habitaciones ocupadas por tipo y fecha (reservas + extra_room_ids + bloqueos, sin duplicados)
      const occupiedRaw = await db.execute(sql`
        WITH dr AS (
          SELECT generate_series(${dateFrom}::date, ${dateTo}::date, '1 day'::interval)::date AS date
        )
        SELECT room_type_id, date, COUNT(DISTINCT room_id)::int AS occupied
        FROM (
          -- Habitación principal de reservas activas
          SELECT ro.room_type_id, d.date::text AS date, r.room_id
          FROM reservations r
          JOIN rooms ro ON ro.id = r.room_id
          CROSS JOIN dr d
          WHERE r.room_id IS NOT NULL
            AND r.property_id = ${getPropertyId()}
            AND r.status NOT IN ('cancelled', 'no_show')
            AND r.check_in_date  <= d.date
            AND r.check_out_date >  d.date
          UNION
          -- Habitaciones adicionales (extra_room_ids) de reservas activas
          SELECT ro2.room_type_id, d.date::text AS date, eid::int AS room_id
          FROM reservations r
          CROSS JOIN jsonb_array_elements_text(r.extra_room_ids) eid
          JOIN rooms ro2 ON ro2.id = eid::int
          CROSS JOIN dr d
          WHERE r.property_id = ${getPropertyId()}
            AND r.status NOT IN ('cancelled', 'no_show')
            AND r.check_in_date  <= d.date
            AND r.check_out_date >  d.date
          UNION
          -- Habitaciones bloqueadas
          SELECT bb.room_type_id, bb.block_date::text AS date, bb.room_id
          FROM blocked_beds bb
          WHERE bb.property_id = ${getPropertyId()}
            AND bb.block_date BETWEEN ${dateFrom}::date AND ${dateTo}::date
        ) sub
        GROUP BY room_type_id, date
      `) as unknown as { room_type_id: number; date: string; occupied: number }[]
      for (const r of occupiedRaw) {
        ;(availOccupied[String(r.room_type_id)] ??= {})[r.date] = r.occupied
      }

      // Overrides manuales de disponibilidad
      const availOverridesRaw = await db.execute(sql`
        SELECT room_type_id, date::text AS date, max_avail
        FROM room_avail_overrides
        WHERE property_id = ${getPropertyId()}
          AND date BETWEEN ${dateFrom}::date AND ${dateTo}::date
      `) as unknown as { room_type_id: number; date: string; max_avail: number }[]
      for (const r of availOverridesRaw) {
        ;(availOverrides[String(r.room_type_id)] ??= {})[r.date] = r.max_avail
      }
    } catch {
      // Tabla o columna no disponible — devolver disponibilidad vacía
    }

    // Lead time medio en 3 ventanas (6/28/64 días hacia atrás desde hoy) —
    // mismo cálculo compartido que usa la regla de precio lead_time_dip
    // (avgLeadTimeDays en occupancyReport.ts: reservas cuya fecha de reserva
    // cae en la ventana, no su fecha de check-in). Aquí solo se usan para
    // pintar en el calendario dónde caería "hoy + lead time medio" de cada
    // ventana — no dependen del rango dateFrom/dateTo pedido.
    // Filtrado a Booking.com: sigue siendo el canal mayoritario, y es el
    // mismo criterio que usa la regla automática — así el calendario muestra
    // el mismo lead time que de verdad mueve el precio, no un promedio
    // global que mezcla canales con comportamientos de reserva muy distintos.
    const todayIso = new Date().toISOString().slice(0, 10)
    function daysAgoIso(n: number): string {
      const d = new Date(todayIso + 'T12:00:00Z')
      d.setUTCDate(d.getUTCDate() - n)
      return d.toISOString().slice(0, 10)
    }
    const leadTimeWindows: Record<'6' | '28' | '64', number | null> = { '6': null, '28': null, '64': null }
    for (const w of [6, 28, 64] as const) {
      leadTimeWindows[String(w) as '6' | '28' | '64'] = await avgLeadTimeDays({ from: daysAgoIso(w), to: todayIso, channelNameLike: 'booking' })
    }

    // ADR real semanal (ingresos ÷ noches ocupadas, agrupado por semana ISO) —
    // mismo cálculo compartido que Informes → Ocupación y que el motor de
    // reglas dinámicas (demand_pulse_dip usa este mismo dato como suelo de
    // precio). Se usa aquí para colorear en el calendario qué precios
    // listados quedan por encima/por debajo de lo que de verdad se cobra esa
    // semana. adrByDate[fecha] = ADR de LA SEMANA ISO de esa fecha, no de ese
    // día suelto — null si esa semana no tiene ninguna noche ocupada todavía.
    const adrByDate = await weeklyAdrByDate(dateFrom, dateTo)

    return c.json({
      rates:        filteredRates,
      allRates:     allRates,
      roomTypes:    allRoomTypes,
      priceMap,
      availTotals,
      availOccupied,
      availOverrides,
      dateFrom,
      dateTo,
      defaultRateIds:     property?.defaultCalendarRateIds     ?? null,
      defaultRoomTypeIds: property?.defaultCalendarRoomTypeIds ?? null,
      defaultDays:        property?.defaultCalendarDays        ?? 30,
      leadTimeWindows,
      todayIso,
      adrByDate,
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// PUT /api/catalog/rates/calendar-defaults — tarifas/tipos visibles por defecto
// en el calendario de precios (solo admin). null = mostrar todas/todos.
app.put('/rates/calendar-defaults', zValidator('json', z.object({
  rateIds:     z.array(z.number().int().positive()).nullable(),
  roomTypeIds: z.array(z.number().int().positive()).nullable(),
  days:        z.number().int().min(7).max(90).optional(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { rateIds, roomTypeIds, days } = c.req.valid('json')
    const patch: Record<string, any> = { defaultCalendarRateIds: rateIds, defaultCalendarRoomTypeIds: roomTypeIds, updatedAt: new Date() }
    if (days !== undefined) patch.defaultCalendarDays = days
    await db.update(properties).set(patch).where(eq(properties.id, getPropertyId()))
    return c.json({ data: { ok: true } })
  } catch (err) {
    return serverError(c, err)
  }
})

const priceEntrySchema = z.object({
  price:      z.number().nonnegative().optional(),
  closed:     z.boolean().optional(),
  roomTypeId: z.number().int().positive().nullable().optional(),
})

export async function seasonMinPriceForDate(date: string): Promise<number | null> {
  const hit = await db.select({ minPrice: seasons.minPrice })
    .from(seasons)
    .where(and(
      eq(seasons.propertyId, getPropertyId()),
      lte(seasons.dateFrom, date),
      gte(seasons.dateTo,   date),
    ))
    .limit(1)
  const raw = hit[0]?.minPrice
  return raw != null ? parseFloat(raw) : null
}

export async function upsertDailyPrice(
  rateId: number, date: string,
  price: number | undefined, closed: boolean | undefined,
  roomTypeId: number | null = null,
  // logCtx: si se pasa, registra el cambio real (precio y/o cierre) en el
  // historial (price_change_log) — lo usa la pestaña Historial del
  // calendario de precios. batchId agrupa los cambios de una misma llamada
  // (una edición sola o un bulk-edit entero) en una sola línea del historial.
  logCtx?: { userId?: number; batchId: string },
  // rateCode: código de la tarifa (ya lo tienen cargado ambos llamadores) —
  // (legado; la tarifa raíz se detecta ahora por id, ver más abajo).
  rateCode?: string | null,
) {
  const rtCond = roomTypeId != null
    ? eq(rateDailyPrices.roomTypeId, roomTypeId)
    : isNull(rateDailyPrices.roomTypeId)

  const existing = await db.select().from(rateDailyPrices)
    .where(and(eq(rateDailyPrices.propertyId, getPropertyId()), eq(rateDailyPrices.rateId, rateId), eq(rateDailyPrices.date, date), rtCond))
    .limit(1)

  const oldPrice  = existing[0]?.price  ?? null
  const oldClosed = existing[0]?.closed ?? false

  const newPrice  = price  !== undefined ? price.toFixed(2)  : (existing[0]?.price  ?? '0.00')
  const newClosed = closed !== undefined ? closed             : (existing[0]?.closed ?? false)
  // Una edición manual del precio (price !== undefined, viene de esta misma
  // función siendo llamada desde el calendario) es siempre la nueva base para
  // el motor de reglas dinámicas — ver comentario en el schema (rateDailyPrices.basePrice).
  const newBasePrice = price !== undefined ? newPrice : (existing[0]?.basePrice ?? newPrice)
  // manualOverrideAt: solo se toca en una edición manual del PRECIO — hasta
  // que el motor compruebe que ninguna regla de umbral se dispara ya para
  // esta celda, esas reglas respetan este valor sin volver a tocarlo (ver
  // comentario en el schema y pricingRulesEngine.ts).
  const newManualOverrideAt = price !== undefined ? new Date() : (existing[0]?.manualOverrideAt ?? null)

  let row
  if (existing[0]) {
    const [r] = await db.update(rateDailyPrices)
      .set({ price: newPrice, basePrice: newBasePrice, closed: newClosed, manualOverrideAt: newManualOverrideAt, updatedAt: new Date() })
      .where(and(eq(rateDailyPrices.id, existing[0].id), eq(rateDailyPrices.propertyId, getPropertyId())))
      .returning()
    row = r
  } else {
    const [r] = await db.insert(rateDailyPrices)
      .values({ propertyId: getPropertyId(), rateId, date, price: newPrice, basePrice: newBasePrice, closed: newClosed, manualOverrideAt: newManualOverrideAt, roomTypeId })
      .returning()
    row = r
  }

  // Edición manual del precio base de la tarifa raíz (la tarifa que usa el motor de
  // reglas dinámicas) — resetea el estado de "parada de reservas"
  // (demand_pulse_dip) de esa fecha. Si no, el motor seguiría aplicando en la
  // siguiente pasada el % de descuento acumulado ANTES de este cambio sobre
  // el precio nuevo que se acaba de fijar a mano, como si el humano no
  // hubiera intervenido — silenciosamente lo rebajaría otra vez hasta el
  // tope. Se borra la fila entera (no se pone a 0): así la próxima pasada
  // trata la fecha como "vista por primera vez" — toma una foto de partida
  // limpia sin disparar nada, igual que cualquier fecha nueva.
  const rootId = price !== undefined ? await getRootRateId().catch(() => null) : null
  if (price !== undefined && rootId != null && rateId === rootId) {
    await db.delete(demandPulseState).where(and(eq(demandPulseState.propertyId, getPropertyId()), eq(demandPulseState.date, date)))
  }

  if (logCtx && (oldPrice !== newPrice || oldClosed !== newClosed)) {
    await db.insert(priceChangeLog).values({
      propertyId: getPropertyId(), rateId, roomTypeId, date,
      oldPrice, newPrice, closed: newClosed,
      source: 'manual', changedByUserId: logCtx.userId ?? null,
      batchId: logCtx.batchId,
    })
  }

  return row
}

// PUT /api/catalog/rates/:id/prices/:date — upsert precio/cierre para un día
app.put('/rates/:id/prices/:date', zValidator('json', priceEntrySchema), async (c) => {
  try {
    const rateId = Number(c.req.param('id'))
    const date   = c.req.param('date')
    const { price, closed, roomTypeId = null } = c.req.valid('json')

    const rate = await db.query.rates.findFirst({ where: and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId())) })
    if (!rate) return notFound(c, 'Tarifa')
    if (rate.locked) return c.json({ error: 'Tarifa bloqueada' }, 403)

    if (price !== undefined && !rate.baseRateId) {
      const minPrice = await seasonMinPriceForDate(date)
      if (minPrice !== null && price < minPrice) {
        return c.json({ error: `Precio inferior al mínimo de temporada (${minPrice.toFixed(2)} €)` }, 422)
      }
    }

    const row = await upsertDailyPrice(rateId, date, price, closed, roomTypeId, {
      userId: getUserId(c), batchId: crypto.randomUUID(),
    }, rate.code)
    return c.json({ data: row })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/catalog/rates/:id/prices/bulk — upsert en bloque para múltiples días
app.post('/rates/:id/prices/bulk', zValidator('json', z.object({
  entries: z.array(z.object({
    date:       z.string().date(),
    price:      z.number().nonnegative().optional(),
    closed:     z.boolean().optional(),
    roomTypeId: z.number().int().positive().nullable().optional(),
  })).min(1).max(365),
})), async (c) => {
  try {
    const rateId = Number(c.req.param('id'))
    const { entries } = c.req.valid('json')

    const rate = await db.query.rates.findFirst({ where: and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId())) })
    if (!rate) return notFound(c, 'Tarifa')
    if (rate.locked) return c.json({ error: 'Tarifa bloqueada' }, 403)

    if (!rate.baseRateId) {
      for (const e of entries) {
        if (e.price === undefined) continue
        const minPrice = await seasonMinPriceForDate(e.date)
        if (minPrice !== null && e.price < minPrice) {
          return c.json({ error: `${e.date}: precio inferior al mínimo de temporada (${minPrice.toFixed(2)} €)` }, 422)
        }
      }
    }

    const logCtx = { userId: getUserId(c), batchId: crypto.randomUUID() }
    const rows = await Promise.all(
      entries.map(e => upsertDailyPrice(rateId, e.date, e.price, e.closed, e.roomTypeId ?? null, logCtx, rate.code))
    )
    return c.json({ data: rows, count: rows.length })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/catalog/rates/:id/prices/:date?roomTypeId=X — eliminar override
app.delete('/rates/:id/prices/:date', async (c) => {
  try {
    const rateId     = Number(c.req.param('id'))
    const date       = c.req.param('date')
    const roomTypeId = c.req.query('roomTypeId') ? Number(c.req.query('roomTypeId')) : null

    const rate = await db.query.rates.findFirst({ where: and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId())) })
    if (!rate) return notFound(c, 'Tarifa')
    if (rate.locked) return c.json({ error: 'Tarifa bloqueada' }, 403)

    const rtCond = roomTypeId != null
      ? eq(rateDailyPrices.roomTypeId, roomTypeId)
      : isNull(rateDailyPrices.roomTypeId)

    const [existing] = await db.select().from(rateDailyPrices)
      .where(and(eq(rateDailyPrices.propertyId, getPropertyId()), eq(rateDailyPrices.rateId, rateId), eq(rateDailyPrices.date, date), rtCond))
      .limit(1)

    await db.delete(rateDailyPrices).where(
      and(eq(rateDailyPrices.propertyId, getPropertyId()), eq(rateDailyPrices.rateId, rateId), eq(rateDailyPrices.date, date), rtCond)
    )

    // newPrice null = "override eliminado, vuelve al precio calculado" — el
    // historial lo muestra como reverso, no como un precio de destino fijo.
    if (existing) {
      await db.insert(priceChangeLog).values({
        propertyId: getPropertyId(), rateId, roomTypeId, date,
        oldPrice: existing.price, newPrice: null, closed: false,
        source: 'manual', changedByUserId: getUserId(c) ?? null,
        batchId: crypto.randomUUID(),
      })
    }

    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/catalog/rates/price-history?from=&to=&rateId=&limit=
// Historial de cambios de precio (manual + automático) para la pestaña
// Historial del calendario de precios. Se agrupa por batchId — una edición
// sola, un bulk-edit desde el calendario, o una pasada del motor de reglas —
// para mostrar "N fechas afectadas" en una línea en vez de una fila por celda.
app.get('/rates/price-history', zValidator('query', z.object({
  from:   z.string().date().optional(),
  to:     z.string().date().optional(),
  rateId: z.coerce.number().int().positive().optional(),
  limit:  z.coerce.number().int().min(1).max(2000).optional(),
})), async (c) => {
  try {
    const { from, to, rateId, limit } = c.req.valid('query')

    const allRows = await db.select({
      batchId:         priceChangeLog.batchId,
      rateId:          priceChangeLog.rateId,
      roomTypeId:       priceChangeLog.roomTypeId,
      date:            priceChangeLog.date,
      oldPrice:        priceChangeLog.oldPrice,
      newPrice:        priceChangeLog.newPrice,
      closed:          priceChangeLog.closed,
      source:          priceChangeLog.source,
      changedByUserId: priceChangeLog.changedByUserId,
      ruleId:          priceChangeLog.ruleId,
      changedAt:       priceChangeLog.changedAt,
      rateTitle:       rates.title,
      roomTypeName:    roomTypes.name,
      roomTypeBaseId:  roomTypes.baseRoomTypeId,
      userFirstName:   users.firstName,
      userLastName:    users.lastName,
      ruleName:        pricingRules.name,
    }).from(priceChangeLog)
      .leftJoin(rates,        eq(rates.id, priceChangeLog.rateId))
      .leftJoin(roomTypes,    eq(roomTypes.id, priceChangeLog.roomTypeId))
      .leftJoin(users,        eq(users.id, priceChangeLog.changedByUserId))
      .leftJoin(pricingRules, eq(pricingRules.id, priceChangeLog.ruleId))
      .where(and(
        eq(priceChangeLog.propertyId, getPropertyId()),
        from   ? gte(priceChangeLog.date, from)      : undefined,
        to     ? lte(priceChangeLog.date, to)         : undefined,
        rateId ? eq(priceChangeLog.rateId, rateId)    : undefined,
      ))
      .orderBy(desc(priceChangeLog.changedAt))
      .limit(limit ?? 1000)

    // El motor automático toca también filas muertas de tipos de habitación
    // derivados (roomTypeId con baseRoomTypeId set) — resolvePrice() nunca
    // las lee, así que en el Historial solo aportan ruido. Las ediciones
    // manuales ya solo pueden tocar el tipo base (Doble), así que este
    // filtro no les afecta.
    const rows = allRows.filter(r => !(r.source === 'auto' && r.roomTypeId != null && r.roomTypeBaseId != null))

    const batches = new Map<string, typeof rows>()
    for (const r of rows) {
      if (!batches.has(r.batchId)) batches.set(r.batchId, [])
      batches.get(r.batchId)!.push(r)
    }

    const data = [...batches.entries()].map(([batchId, items]) => {
      const first        = items[0]!
      const dates         = [...new Set(items.map(i => i.date))].sort()
      const roomTypeNames = [...new Set(items.map(i => i.roomTypeName ?? 'Compartido (todos)'))]
      const uniquePairs   = new Set(items.map(i => `${i.oldPrice}→${i.newPrice}`))
      const latestAt      = items.reduce((max, i) => i.changedAt > max ? i.changedAt : max, first.changedAt)
      return {
        batchId,
        source:        first.source as 'manual' | 'auto',
        changedAt:      latestAt,
        userName:       first.userFirstName ? `${first.userFirstName} ${first.userLastName ?? ''}`.trim() : null,
        ruleName:       first.ruleName ?? null,
        rateTitle:      first.rateTitle ?? `Tarifa #${first.rateId}`,
        roomTypes:      roomTypeNames,
        datesAffected:  dates,
        uniform:        uniquePairs.size === 1,
        oldPrice:       uniquePairs.size === 1 ? first.oldPrice : null,
        newPrice:       uniquePairs.size === 1 ? first.newPrice : null,
        items: items.map(i => ({
          date: i.date, roomTypeName: i.roomTypeName ?? 'Compartido (todos)',
          oldPrice: i.oldPrice, newPrice: i.newPrice, closed: i.closed,
        })),
      }
    }).sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())

    return c.json({ data })
  } catch (err) {
    return serverError(c, err)
  }
})

// ── DISPONIBILIDAD: OVERRIDES ─────────────────────────────────────────────────

// PUT /api/catalog/avail/:roomTypeId/:date — fijar disponibilidad manual
app.put('/avail/:roomTypeId/:date', zValidator('json', z.object({
  maxAvail: z.number().int().min(0),
})), async (c) => {
  try {
    const roomTypeId = Number(c.req.param('roomTypeId'))
    const date       = c.req.param('date')
    const { maxAvail } = c.req.valid('json')
    const [rt] = await db.select({ id: roomTypes.id }).from(roomTypes)
      .where(and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, getPropertyId()))).limit(1)
    if (!rt) return notFound(c, 'Tipo de habitación')
    await db.execute(sql`
      INSERT INTO room_avail_overrides (property_id, room_type_id, date, max_avail)
      VALUES (${getPropertyId()}, ${roomTypeId}, ${date}::date, ${maxAvail})
      ON CONFLICT (room_type_id, date) DO UPDATE
        SET max_avail = ${maxAvail}, updated_at = NOW()
    `)
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/catalog/avail/:roomTypeId/:date — eliminar override (volver a automático)
app.delete('/avail/:roomTypeId/:date', async (c) => {
  try {
    const roomTypeId = Number(c.req.param('roomTypeId'))
    const date       = c.req.param('date')
    await db.execute(sql`
      DELETE FROM room_avail_overrides
      WHERE room_type_id = ${roomTypeId} AND date = ${date}::date AND property_id = ${getPropertyId()}
    `)
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

// ── OPERATORS ─────────────────────────────────────────────────────────────────

// GET /api/catalog/operators
app.get('/operators', async (c) => {
  try {
    const list = await db.query.operators.findMany({
      where: and(eq(operators.active, true), eq(operators.propertyId, getPropertyId())),
      orderBy: asc(operators.name),
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/catalog/operators
app.post('/operators', zValidator('json', z.object({
  name:    z.string().min(1),
  code:    z.string().min(1),
  logoUrl: z.string().url().optional().or(z.literal('')),
})), async (c) => {
  try {
    const { name, code, logoUrl } = c.req.valid('json')
    const [created] = await db.insert(operators)
      .values({ propertyId: getPropertyId(), name, code, logoUrl: logoUrl || null })
      .returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/catalog/operators/:id
app.patch('/operators/:id', zValidator('json', z.object({
  name:    z.string().min(1).optional(),
  code:    z.string().min(1).optional(),
  logoUrl: z.string().url().nullable().optional().or(z.literal('')),
  active:  z.boolean().optional(),
})), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const existing = await db.query.operators.findFirst({ where: and(eq(operators.id, id), eq(operators.propertyId, getPropertyId())) })
    if (!existing) return notFound(c, 'Operador')

    const updates: Record<string, any> = { updatedAt: new Date() }
    if (body.name    !== undefined) updates.name    = body.name
    if (body.code    !== undefined) updates.code    = body.code
    if (body.logoUrl !== undefined) updates.logoUrl = body.logoUrl || null
    if (body.active  !== undefined) updates.active  = body.active

    const [updated] = await db.update(operators).set(updates).where(and(eq(operators.id, id), eq(operators.propertyId, getPropertyId()))).returning()
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// ── OTROS ─────────────────────────────────────────────────────────────────────

async function getBookingChannels(c: any) {
  try {
    const list = await db.select().from(bookingChannels).where(and(eq(bookingChannels.active, true), eq(bookingChannels.propertyId, getPropertyId())))
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
}

app.get('/booking-channels', getBookingChannels)
app.get('/channels',         getBookingChannels)

const saleItemSchema = z.object({
  title:                  z.string().min(1).max(100),
  description:            z.string().max(500).nullable().optional(),
  active:                 z.boolean().optional(),
  activeForBookingEngine: z.boolean().optional(),
  icon:                   z.string().max(10).nullable().optional(),
  defaultPrice:           z.number().nonnegative().nullable().optional(),
  pricingType:            z.enum(['per_stay', 'per_night', 'per_person', 'per_person_night']).optional(),
  maxQuantity:            z.number().int().min(1).max(99).optional(),
  taxRate:                z.number().nonnegative().nullable().optional(),
})

app.get('/sale-items', async (c) => {
  try {
    const list = await db.select().from(saleItems)
      .where(eq(saleItems.propertyId, getPropertyId()))
      .orderBy(asc(saleItems.title))
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

app.post('/sale-items', zValidator('json', saleItemSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const [item] = await db.insert(saleItems).values({
      propertyId:             getPropertyId(),
      title:                  body.title,
      description:            body.description ?? null,
      active:                 body.active ?? true,
      activeForBookingEngine: body.activeForBookingEngine ?? false,
      icon:                   body.icon ?? null,
      defaultPrice:           body.defaultPrice != null ? String(body.defaultPrice) : null,
      pricingType:            body.pricingType ?? 'per_stay',
      maxQuantity:            body.maxQuantity ?? 1,
      taxRate:                body.taxRate != null ? String(body.taxRate) : null,
    } as any).returning()
    return c.json({ data: item }, 201)
  } catch (err) { return serverError(c, err) }
})

app.patch('/sale-items/:id', zValidator('json', saleItemSchema.partial()), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const upd: Record<string, unknown> = { updatedAt: new Date() }
    if (body.title                  !== undefined) upd.title                  = body.title
    if (body.description            !== undefined) upd.description            = body.description
    if (body.active                 !== undefined) upd.active                 = body.active
    if (body.activeForBookingEngine !== undefined) upd.activeForBookingEngine = body.activeForBookingEngine
    if (body.icon                   !== undefined) upd.icon                   = body.icon
    if (body.defaultPrice           !== undefined) upd.defaultPrice           = body.defaultPrice != null ? String(body.defaultPrice) : null
    if (body.pricingType            !== undefined) upd.pricingType            = body.pricingType
    if (body.maxQuantity            !== undefined) upd.maxQuantity            = body.maxQuantity
    if (body.taxRate                !== undefined) upd.taxRate                = body.taxRate != null ? String(body.taxRate) : null
    const [item] = await db.update(saleItems).set(upd as any).where(and(eq(saleItems.id, id), eq(saleItems.propertyId, getPropertyId()))).returning()
    if (!item) return notFound(c)
    return c.json({ data: item })
  } catch (err) { return serverError(c, err) }
})

// GET /api/catalog/sale-items/sales — ventas registradas de extras (accesible a recepción)
app.get('/sale-items/sales', zValidator('query', z.object({
  dateFrom:   z.string().date().optional(),
  dateTo:     z.string().date().optional(),
  saleItemId: z.coerce.number().int().optional(),
  page:       z.coerce.number().int().min(1).default(1),
  limit:      z.coerce.number().int().max(200).default(50),
})), async (c) => {
  try {
    const { dateFrom, dateTo, saleItemId, page, limit } = c.req.valid('query')
    const offset = (page - 1) * limit

    const where = and(
      eq(reservations.propertyId, getPropertyId()),
      saleItemId ? eq(reservationSaleItems.saleItemId, saleItemId) : undefined,
      dateFrom   ? gte(reservationSaleItems.createdAt, new Date(dateFrom + 'T00:00:00')) : undefined,
      dateTo     ? lte(reservationSaleItems.createdAt, new Date(dateTo   + 'T23:59:59')) : undefined,
    )

    const rows = await db
      .select({
        id:             reservationSaleItems.id,
        reservationId:  reservationSaleItems.reservationId,
        quantity:       reservationSaleItems.quantity,
        unitPrice:      reservationSaleItems.unitPrice,
        date:           reservationSaleItems.date,
        notes:          reservationSaleItems.notes,
        createdAt:      reservationSaleItems.createdAt,
        saleItemId:     reservationSaleItems.saleItemId,
        saleItemTitle:  saleItems.title,
        saleItemIcon:   saleItems.icon,
        guestFirstName:      guests.firstName,
        guestLastName:       guests.lastName,
        roomCode:            rooms.code,
        reservationStatus:   reservations.status,
        createdByFirst: users.firstName,
        createdByLast:  users.lastName,
      })
      .from(reservationSaleItems)
      .innerJoin(reservations, eq(reservations.id, reservationSaleItems.reservationId))
      .innerJoin(saleItems,    eq(saleItems.id,    reservationSaleItems.saleItemId))
      .leftJoin(guests,        eq(guests.id,       reservations.guestId))
      .leftJoin(rooms,         eq(rooms.id,        reservations.roomId))
      .leftJoin(users,         eq(users.id,        reservationSaleItems.createdBy))
      .where(where)
      .orderBy(desc(reservationSaleItems.createdAt))
      .limit(limit).offset(offset)

    const [agg] = await db
      .select({
        total:       count(),
        totalAmount: sql<string>`COALESCE(SUM(${reservationSaleItems.unitPrice} * ${reservationSaleItems.quantity}), 0)`,
      })
      .from(reservationSaleItems)
      .innerJoin(reservations, eq(reservations.id, reservationSaleItems.reservationId))
      .where(where)

    return c.json({ data: rows, meta: { total: agg!.total, totalAmount: agg!.totalAmount, page, limit } })
  } catch (err) { return serverError(c, err) }
})

app.delete('/sale-items/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    await db.delete(saleItems).where(and(eq(saleItems.id, id), eq(saleItems.propertyId, getPropertyId())))
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

app.get('/deposit-items', async (c) => {
  try {
    const list = await db.select().from(depositItems).where(and(eq(depositItems.active, true), eq(depositItems.propertyId, getPropertyId())))
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

app.get('/currencies', async (c) => {
  try {
    const list = await db.select().from(currencies)
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// ── TEMPORADAS ────────────────────────────────────────────────────────────────

const seasonSchema = z.object({
  name:     z.string().min(1),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  minPrice: z.number().nonnegative().nullable().optional(),
  color:    z.string().optional(),
})

app.get('/seasons', async (c) => {
  try {
    const list = await db.select().from(seasons).where(eq(seasons.propertyId, getPropertyId())).orderBy(asc(seasons.dateFrom))
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

app.post('/seasons', zValidator('json', seasonSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const [row] = await db.insert(seasons).values({
      propertyId: getPropertyId(),
      name:       body.name,
      dateFrom:   body.dateFrom,
      dateTo:     body.dateTo,
      minPrice:   body.minPrice != null ? String(body.minPrice) : null,
      color:      body.color ?? '#3b82f6',
    }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

app.patch('/seasons/:id', zValidator('json', seasonSchema.partial()), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const patch: Record<string, any> = { updatedAt: new Date() }
    if (body.name     !== undefined) patch.name     = body.name
    if (body.dateFrom !== undefined) patch.dateFrom = body.dateFrom
    if (body.dateTo   !== undefined) patch.dateTo   = body.dateTo
    if (body.minPrice !== undefined) patch.minPrice = body.minPrice != null ? String(body.minPrice) : null
    if (body.color    !== undefined) patch.color    = body.color
    const [row] = await db.update(seasons).set(patch).where(and(eq(seasons.id, id), eq(seasons.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c)
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

app.delete('/seasons/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    await db.delete(seasons).where(and(eq(seasons.id, id), eq(seasons.propertyId, getPropertyId())))
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

// ── REGLAS DE PRECIO DINÁMICO ─────────────────────────────────────────────────

const pricingRuleSchema = z.object({
  name:         z.string().min(1),
  ruleType:     z.enum(['low_availability', 'lead_time_dip', 'local_min_dip', 'demand_pulse_dip', 'competitor_undercut', 'sold_out_upsell', 'evening_clearance_dip', 'booking_surge']).optional(),
  // thresholdPct: en booking_surge es la ventana en MINUTOS (no un %, ver
  // comentario en src/db/schema/pricing.ts) — por eso el máximo es 1440 (24h)
  // en vez de 100. El resto de tipos siguen limitados a 1-100.
  thresholdPct: z.number().int().min(1).max(1440).optional(),
  adjustType:   z.enum(['fixed', 'percentage']),
  adjustValue:  z.number().nonnegative(),
  // Solo demand_pulse_dip — ver comentario en src/db/schema/pricing.ts.
  minAdrFloorPct: z.number().int().min(1).max(100).optional(),
  // Solo demand_pulse_dip — minutos sin reservas nuevas por escalón, y
  // también cuánto se respeta un override manual antes de darlo por
  // caducado (ver src/db/schema/pricing.ts). Hasta 1440 (24h).
  pulseSilenceMinutes: z.number().int().min(1).max(1440).optional(),
  // Solo evening_clearance_dip — cuánto se respeta un override manual antes
  // de darlo por caducado (ver src/db/schema/pricing.ts).
  clearanceOverrideMinutes: z.number().int().min(1).max(1440).optional(),
  // Solo evening_clearance_dip — hora local del hotel (0-23, properties.timezone) a la que empieza
  // a actuar la regla cada día.
  clearanceStartHour: z.number().int().min(0).max(23).optional(),
  // Solo competitor_undercut — tarifa nuestra a comparar/ajustar.
  referenceRateId: z.number().int().positive().nullable().optional(),
  // Solo sold_out_upsell — tipo de habitación que se agota / que se rebaja.
  sourceRoomTypeId: z.number().int().positive().nullable().optional(),
  targetRoomTypeId: z.number().int().positive().nullable().optional(),
  // Prioridad: número menor = gana cuando varias reglas se cumplen la misma fecha.
  priority:     z.number().int().min(1).max(1000).optional(),
  active:       z.boolean().optional(),
})

app.get('/pricing-rules', async (c) => {
  try {
    const list = await db.select().from(pricingRules).where(eq(pricingRules.propertyId, getPropertyId())).orderBy(asc(pricingRules.id))
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

app.post('/pricing-rules', zValidator('json', pricingRuleSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    if (body.ruleType === 'competitor_undercut' && !body.referenceRateId) {
      return c.json({ error: 'Elige la tarifa de referencia a comparar con los competidores' }, 400)
    }
    if (body.ruleType === 'sold_out_upsell' && (!body.sourceRoomTypeId || !body.targetRoomTypeId)) {
      return c.json({ error: 'Elige el tipo de habitación que se agota y el que se rebaja' }, 400)
    }
    const [row] = await db.insert(pricingRules).values({
      propertyId:   getPropertyId(),
      name:           body.name,
      ruleType:       body.ruleType ?? 'low_availability',
      thresholdPct:   body.thresholdPct ?? 15,
      adjustType:     body.adjustType,
      adjustValue:    String(body.adjustValue),
      minAdrFloorPct: body.minAdrFloorPct ?? 90,
      pulseSilenceMinutes: body.pulseSilenceMinutes ?? 240,
      clearanceOverrideMinutes: body.clearanceOverrideMinutes ?? 60,
      clearanceStartHour: body.clearanceStartHour ?? 20,
      referenceRateId: body.referenceRateId ?? null,
      sourceRoomTypeId: body.sourceRoomTypeId ?? null,
      targetRoomTypeId: body.targetRoomTypeId ?? null,
      ...(body.priority !== undefined ? { priority: body.priority } : {}),
      active:         body.active ?? true,
    }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

app.patch('/pricing-rules/:id', zValidator('json', pricingRuleSchema.partial()), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const patch: Record<string, any> = { updatedAt: new Date() }
    if (body.name           !== undefined) patch.name           = body.name
    if (body.ruleType       !== undefined) patch.ruleType       = body.ruleType
    if (body.thresholdPct   !== undefined) patch.thresholdPct   = body.thresholdPct
    if (body.adjustType     !== undefined) patch.adjustType     = body.adjustType
    if (body.adjustValue    !== undefined) patch.adjustValue    = String(body.adjustValue)
    if (body.minAdrFloorPct !== undefined) patch.minAdrFloorPct = body.minAdrFloorPct
    if (body.pulseSilenceMinutes !== undefined) patch.pulseSilenceMinutes = body.pulseSilenceMinutes
    if (body.clearanceOverrideMinutes !== undefined) patch.clearanceOverrideMinutes = body.clearanceOverrideMinutes
    if (body.clearanceStartHour !== undefined) patch.clearanceStartHour = body.clearanceStartHour
    if (body.referenceRateId !== undefined) patch.referenceRateId = body.referenceRateId
    if (body.sourceRoomTypeId !== undefined) patch.sourceRoomTypeId = body.sourceRoomTypeId
    if (body.targetRoomTypeId !== undefined) patch.targetRoomTypeId = body.targetRoomTypeId
    if (body.priority       !== undefined) patch.priority       = body.priority
    if (body.active         !== undefined) patch.active         = body.active
    const [row] = await db.update(pricingRules).set(patch).where(and(eq(pricingRules.id, id), eq(pricingRules.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c)
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

app.delete('/pricing-rules/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    await db.delete(pricingRules).where(and(eq(pricingRules.id, id), eq(pricingRules.propertyId, getPropertyId())))
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

// ── CART RECOVERY SETTINGS ────────────────────────────────────────────────────

const discountTierSchema = z.object({
  threshold: z.number().int().min(0),
  pct:       z.number().int().min(1).max(99),
})

const cartRecoverySettingsSchema = z.object({
  enabled:           z.boolean().optional(),
  minAgeMin:         z.number().int().min(1).max(1440).optional(),
  maxAgeHours:       z.number().int().min(1).max(168).optional(),
  validityHours:     z.number().int().min(1).max(168).optional(),
  discountTiers:     z.array(discountTierSchema).min(1).optional(),
  targetNewPhone:    z.boolean().optional(),
  targetNewName:     z.boolean().optional(),
  targetFirstTime:   z.boolean().optional(),
})

// GET /api/catalog/cart-recovery-settings
app.get('/cart-recovery-settings', async (c) => {
  try {
    const row = await getCartRecoverySettings()
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/catalog/cart-recovery-settings
app.put('/cart-recovery-settings', zValidator('json', cartRecoverySettingsSchema), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const body = c.req.valid('json')
    const patch: Record<string, any> = { updatedAt: new Date() }
    if (body.enabled          !== undefined) patch.enabled          = body.enabled
    if (body.minAgeMin        !== undefined) patch.minAgeMin        = body.minAgeMin
    if (body.maxAgeHours      !== undefined) patch.maxAgeHours      = body.maxAgeHours
    if (body.validityHours    !== undefined) patch.validityHours    = body.validityHours
    if (body.discountTiers  !== undefined) patch.discountTiers  = body.discountTiers
    if (body.targetNewPhone !== undefined) patch.targetNewPhone = body.targetNewPhone
    if (body.targetNewName  !== undefined) patch.targetNewName  = body.targetNewName
    if (body.targetFirstTime !== undefined) patch.targetFirstTime = body.targetFirstTime

    const row = await patchCartRecoverySettings(patch)
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// ── CANCELLATION RECOVERY SETTINGS (reenganche de reservas canceladas) ────────

const cancellationRecoverySettingsSchema = z.object({
  enabled:       z.boolean().optional(),
  minAgeHours:   z.number().int().min(0).max(168).optional(),
  maxAgeHours:   z.number().int().min(1).max(720).optional(),
  validityHours: z.number().int().min(1).max(720).optional(),
  discountPct:   z.number().int().min(1).max(99).optional(),
})

// GET /api/catalog/cancellation-recovery-settings
app.get('/cancellation-recovery-settings', async (c) => {
  try {
    const row = await getCancellationRecoverySettings()
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/catalog/cancellation-recovery-settings
app.put('/cancellation-recovery-settings', zValidator('json', cancellationRecoverySettingsSchema), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const body = c.req.valid('json')
    const patch: Record<string, any> = { updatedAt: new Date() }
    if (body.enabled       !== undefined) patch.enabled       = body.enabled
    if (body.minAgeHours   !== undefined) patch.minAgeHours   = body.minAgeHours
    if (body.maxAgeHours   !== undefined) patch.maxAgeHours   = body.maxAgeHours
    if (body.validityHours !== undefined) patch.validityHours = body.validityHours
    if (body.discountPct   !== undefined) patch.discountPct   = body.discountPct

    const row = await patchCancellationRecoverySettings(patch)
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// ── TEMPORARY DISCOUNT SETTINGS (descuento temporal en la página de reserva) ──

const temporaryDiscountSettingsSchema = z.object({
  enabled:           z.boolean().optional(),
  activationMinutes: z.number().int().min(1).max(120).optional(),
  windowMinutes:     z.number().int().min(1).max(240).optional(),
  discountPct:       z.number().int().min(1).max(99).optional(),
})

// GET /api/catalog/temporary-discount-settings
app.get('/temporary-discount-settings', async (c) => {
  try {
    const row = await getTemporaryDiscountSettings()
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/catalog/temporary-discount-settings
app.put('/temporary-discount-settings', zValidator('json', temporaryDiscountSettingsSchema), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const body = c.req.valid('json')
    const patch: Record<string, any> = { updatedAt: new Date() }
    if (body.enabled           !== undefined) patch.enabled           = body.enabled
    if (body.activationMinutes !== undefined) patch.activationMinutes = body.activationMinutes
    if (body.windowMinutes     !== undefined) patch.windowMinutes     = body.windowMinutes
    if (body.discountPct       !== undefined) patch.discountPct       = body.discountPct

    const row = await patchTemporaryDiscountSettings(patch)
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

export default app
