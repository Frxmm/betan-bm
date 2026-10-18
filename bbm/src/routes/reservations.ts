import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, reservationNights, reservationNotes, reservationSaleItems, saleItems, guests, rooms, roomTypes, rates, rateDailyPrices, bookingChannels, financialTransactions, invoices, guestContracts, blockedBeds, currencies } from '../db/schema'
import { eq, and, gte, lte, lt, gt, ne, or, ilike, asc, desc, count, inArray, notInArray, isNotNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm'
import { notFound, conflict, serverError } from '../lib/errors'
import { isAdmin } from '../middleware/auth'
import { createPasscode, deletePasscode, isConfigured as ttlockConfigured } from '../lib/ttlock'
import { sendLockCode, sendCheckinLinkEmail, sendPaymentReminderEmail, sendBookingConfirmationEmail, sendThankYouEmail } from '../lib/email'
import { channelEnabled, portalLink } from '../lib/messaging'
import { isConfigured as nobedsConfigured, blockDates, unblockDates } from '../lib/nobeds'
import { revokeCard, isConfigured as zktecoConfigured } from '../lib/zkteco'
import { reenrollCard, roomsWithLock, propertyMs } from './ttlock'
import { logStatusChange } from '../lib/statusLog'
import { getPropertyId, getBranding, hasFeature, getSetting } from '../lib/property'
import { hasMinWords } from '../lib/textValidation'
import { resolvePrice, rateChainIds, roomTypeChainIds } from '../lib/price-resolver'
import { realPaidByReservation, pendingBalance as calcPendingBalance, currencySymbol } from '../lib/paymentAggregate'
import QRCode from 'qrcode'
import type { Context } from 'hono'

function getUserId(c: Context): number | undefined {
  const payload = c.get('jwtPayload') as { sub?: string | number } | undefined
  const id = Number(payload?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

function fmtD(d: string | null | undefined): string {
  if (!d) return '—'
  const [y, m, day] = d.split('-')
  return `${day}/${m}/${y}`
}

const app = new Hono()

// La reserva pertenece al tenant del JWT (tablas hijas sin property_id: extras, notas, noches…)
async function ownReservation(id: number): Promise<boolean> {
  return !!(await db.query.reservations.findFirst({
    where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())), columns: { id: true },
  }))
}

// Referencias de una reserva (huésped, habitación, tarifa, canal, habitaciones extra) deben ser del
// tenant: devuelve el mensaje de error si alguna no lo es (evita enlazar datos de otro hotel).
async function checkOwnRefs(refs: {
  guestId?: number; roomId?: number | null; rateId?: number | null; bookingChannelId?: number | null; extraRoomIds?: number[] | null
}): Promise<string | null> {
  const pid = getPropertyId()
  if (refs.guestId != null && !(await db.query.guests.findFirst({ where: and(eq(guests.id, refs.guestId), eq(guests.propertyId, pid)), columns: { id: true } }))) return 'Huésped no encontrado'
  if (refs.rateId != null && !(await db.query.rates.findFirst({ where: and(eq(rates.id, refs.rateId), eq(rates.propertyId, pid)), columns: { id: true } }))) return 'Tarifa no encontrada'
  if (refs.bookingChannelId != null && !(await db.query.bookingChannels.findFirst({ where: and(eq(bookingChannels.id, refs.bookingChannelId), eq(bookingChannels.propertyId, pid)), columns: { id: true } }))) return 'Canal no encontrado'
  const roomIds = [...(refs.roomId != null ? [refs.roomId] : []), ...(refs.extraRoomIds ?? [])]
  if (roomIds.length > 0) {
    const found = await db.select({ id: rooms.id }).from(rooms).where(and(eq(rooms.propertyId, pid), inArray(rooms.id, roomIds)))
    if (found.length !== new Set(roomIds).size) return 'Habitación no encontrada'
  }
  return null
}

// Hoy (YYYY-MM-DD) en la zona horaria del tenant
async function todayLocal(): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
}

// Id de la moneda del tenant (properties.currencyCode → currencies.id) para las noches de reserva
export async function tenantCurrencyId(): Promise<number> {
  const code = (await getBranding()).currencyCode
  const cur = await db.query.currencies.findFirst({ where: eq(currencies.code, code), columns: { id: true } })
  if (!cur) throw new Error(`Moneda ${code} no existe en la tabla currencies`)
  return cur.id
}

// ─── SCHEMAS DE VALIDACIÓN ────────────────────────────────────────────────────

const createSchema = z.object({
  guestId:          z.number().int().positive(),
  roomId:           z.number().int().positive(),
  rateId:           z.number().int().positive(),
  bookingChannelId: z.number().int().positive(),
  checkInDate:      z.string().date(),
  checkOutDate:     z.string().date(),
  nights:           z.number().int().min(1).optional(),
  people:           z.number().int().min(1).default(1),
  total:            z.number().min(0.01),
  externalCode:     z.string().optional(),
  extraField1:      z.string().optional(),
  extraField2:      z.string().optional(),
  groupName:        z.string().optional(),
  extraRoomIds:     z.array(z.number().int().positive()).optional(),
})

const updateSchema = createSchema.partial().extend({
  status: z.enum(['tentative', 'arriving', 'confirmed', 'checked_in', 'checking_out', 'checked_out', 'cancelled', 'no_show']).optional(),
  // Motivo obligatorio (min. 5 palabras reales, ver hasMinWords) SOLO cuando
  // el cambio de habitación es delicado: huésped ya en casa, o se pasa a un
  // tipo virtual — ver el bloque de historial más abajo, que es quien de
  // verdad exige y comprueba la longitud (aquí solo se acepta el campo).
  changeReason: z.string().max(500).optional(),
  // Habitaciones de la reserva marcadas como "cerradas" (ver lockedRoomIds en
  // el schema) — no exige motivo, es un simple toggle.
  lockedRoomIds: z.array(z.number().int().positive()).optional(),
})

const searchSchema = z.object({
  q:         z.string().optional(),
  status:    z.string().optional(),
  dateType:  z.enum(['checkIn', 'checkOut', 'createdAt', 'stayDate']).optional(),
  dateFrom:  z.string().date().optional(),
  dateTo:    z.string().date().optional(),
  rateId:    z.coerce.number().int().positive().optional(),
  channelId: z.coerce.number().int().positive().optional(),
  hasExtraRooms: z.coerce.boolean().optional(),
  // legacy single-date params (planning, etc.)
  checkIn:   z.string().date().optional(),
  checkOut:  z.string().date().optional(),
  createdAt: z.string().date().optional(),
  stayDate:  z.string().date().optional(),
  page:      z.coerce.number().int().min(1).default(1),
  // Tope de 1000: la vista puede pedir el tamaño de página que quiera (ya no
  // fijo), pero sin límite razonable una página gigante podría tumbar la BD.
  limit:     z.coerce.number().int().min(1).max(1000).default(50),
  sortCol:   z.enum(['code', 'guest', 'room', 'checkIn', 'checkOut', 'nights', 'people', 'createdAt', 'rate', 'channel', 'total', 'pending', 'status']).optional(),
  sortDir:   z.enum(['asc', 'desc']).optional(),
})

// Columna/expresión SQL por cada clave de ordenación aceptada — algunas viven
// en tablas relacionadas (huésped, habitación, tarifa, canal), por eso el
// listado usa joins explícitos en vez del query builder relacional de Drizzle
// (que no puede ordenar por columnas de relaciones "with").
function sortExprFor(col: string | undefined): SQLWrapper {
  switch (col) {
    case 'code':      return sql`coalesce(${reservations.externalCode}, ${reservations.id}::text)`
    case 'guest':      return sql`lower(coalesce(${guests.lastName}, '') || ' ' || coalesce(${guests.firstName}, ''))`
    case 'room':       return sql`${rooms.code}`
    case 'checkOut':   return reservations.checkOutDate
    case 'nights':     return reservations.nights
    case 'people':     return reservations.people
    case 'createdAt':  return reservations.createdAt
    case 'rate':       return sql`${rates.title}`
    case 'channel':    return sql`${bookingChannels.name}`
    case 'total':      return sql`${reservations.total}::numeric`
    // Igual criterio que el pendingBalance devuelto en los datos (ver
    // src/lib/paymentAggregate.ts): los depósitos retenidos sin cobrar no
    // cuentan como pago de la estancia.
    case 'pending':    return sql`(${reservations.total}::numeric - (
                                     SELECT COALESCE(SUM(amount) FILTER (WHERE payment_method NOT IN ('deposit','deposit_cc')), 0)
                                          + COALESCE(SUM(amount) FILTER (WHERE category = 'deposit_cobrado'), 0)
                                     FROM financial_transactions ft WHERE ft.reservation_id = ${reservations.id}
                                   ))`
    case 'status':     return sql`CASE ${reservations.status}
                                     WHEN 'arriving' THEN 0 WHEN 'tentative' THEN 0 WHEN 'confirmed' THEN 1
                                     WHEN 'checked_in' THEN 2 WHEN 'checking_out' THEN 3 WHEN 'checked_out' THEN 4
                                     WHEN 'no_show' THEN 5 WHEN 'cancelled' THEN 6 ELSE 9 END`
    case 'checkIn':
    default:           return reservations.checkInDate
  }
}

// ─── RUTAS ────────────────────────────────────────────────────────────────────

// GET /api/reservations — listar con filtros (equivalente a reservationinfos)
app.get('/', zValidator('query', searchSchema), async (c) => {
  try {
    const { q, status, dateType, dateFrom, dateTo, rateId, channelId, hasExtraRooms, checkIn, checkOut, createdAt, stayDate, page, limit, sortCol, sortDir } = c.req.valid('query')
    const offset = (page - 1) * limit

    const conditions: SQL[] = [eq(reservations.propertyId, getPropertyId())]
    if (status)    conditions.push(eq(reservations.status, status as any))
    if (rateId)    conditions.push(eq(reservations.rateId, rateId))
    if (channelId) conditions.push(eq(reservations.bookingChannelId, channelId))
    // Reservas con al menos una habitación adicional (útil para localizar y
    // limpiar asignaciones erróneas, ej. las que generó el bug de sync FDM)
    if (hasExtraRooms) conditions.push(sql`jsonb_array_length(coalesce(${reservations.extraRoomIds}, '[]'::jsonb)) > 0`)

    // Rango de fechas según dateType
    if (dateFrom || dateTo) {
      switch (dateType ?? 'checkIn') {
        case 'checkIn':
          if (dateFrom) conditions.push(gte(reservations.checkInDate, dateFrom))
          if (dateTo)   conditions.push(lte(reservations.checkInDate, dateTo))
          break
        case 'checkOut':
          if (dateFrom) conditions.push(gte(reservations.checkOutDate, dateFrom))
          if (dateTo)   conditions.push(lte(reservations.checkOutDate, dateTo))
          break
        case 'createdAt':
          if (dateFrom) conditions.push(sql`${reservations.createdAt}::date >= ${dateFrom}::date`)
          if (dateTo)   conditions.push(sql`${reservations.createdAt}::date <= ${dateTo}::date`)
          break
        case 'stayDate':
          if (dateFrom) conditions.push(lte(reservations.checkInDate, dateTo ?? dateFrom))
          if (dateTo)   conditions.push(gte(reservations.checkOutDate, dateFrom ?? dateTo))
          break
      }
    }

    // Legacy single-date params
    if (checkIn)   conditions.push(eq(reservations.checkInDate, checkIn))
    if (checkOut)  conditions.push(eq(reservations.checkOutDate, checkOut))
    if (createdAt) conditions.push(sql`${reservations.createdAt}::date = ${createdAt}::date`)
    if (stayDate)  conditions.push(and(lte(reservations.checkInDate, stayDate), gte(reservations.checkOutDate, stayDate))!)

    const where = conditions.length > 0 ? and(...conditions) : undefined

    // Joins explícitos (en vez del query builder relacional) porque el orden
    // puede pedirse por columnas de huésped/habitación/tarifa/canal, no solo
    // de reservations — el API relacional de Drizzle no puede ordenar por
    // columnas de una relación "with".
    const sortExpr = sortExprFor(sortCol)
    const orderBy  = sortDir === 'asc' ? asc(sortExpr) : desc(sortExpr)

    const [rows, total] = await Promise.all([
      db.select({ reservation: reservations, guest: guests, room: rooms, rate: rates, bookingChannel: bookingChannels })
        .from(reservations)
        .leftJoin(guests,          and(eq(guests.id, reservations.guestId), eq(guests.propertyId, getPropertyId())))
        .leftJoin(rooms,           and(eq(rooms.id, reservations.roomId), eq(rooms.propertyId, getPropertyId())))
        .leftJoin(rates,           and(eq(rates.id, reservations.rateId), eq(rates.propertyId, getPropertyId())))
        .leftJoin(bookingChannels, and(eq(bookingChannels.id, reservations.bookingChannelId), eq(bookingChannels.propertyId, getPropertyId())))
        .where(where)
        .orderBy(orderBy)
        .limit(limit)
        .offset(offset),
      db.select({ count: count() }).from(reservations).where(where),
    ])
    const list = rows.map(r => ({ ...r.reservation, guest: r.guest, room: r.room, rate: r.rate, bookingChannel: r.bookingChannel }))

    // Resolver códigos de las habitaciones adicionales (extraRoomIds) para mostrarlas en el listado
    const extraIds = [...new Set(list.flatMap(r => (r.extraRoomIds ?? []) as number[]))]
    const extraRoomCodeById = new Map<number, string>()
    if (extraIds.length > 0) {
      const extraRooms = await db.select({ id: rooms.id, code: rooms.code }).from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, extraIds)))
      for (const rm of extraRooms) extraRoomCodeById.set(rm.id, rm.code)
    }

    // Saldo pendiente real: no cuenta los depósitos retenidos como si
    // pagaran la estancia (ver src/lib/paymentAggregate.ts) — solo cuando se
    // "cobran" de verdad.
    const realPaidById = await realPaidByReservation(list.map(r => r.id))
    const data = list.map(r => ({
      ...r,
      pendingBalance:  calcPendingBalance(r.total, realPaidById.get(r.id) ?? 0),
      extraRoomCodes: ((r.extraRoomIds ?? []) as number[]).map(id => extraRoomCodeById.get(id) ?? `#${id}`),
    }))

    return c.json({
      data,
      meta: { total: total[0]?.count ?? 0, page, limit },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/search?q= — búsqueda rápida global para el topbar
// Busca por: (1) ID/código externo con wildcard; (2) nombre/apellido; (3) habitación exacta
app.get('/search', zValidator('query', z.object({ q: z.string().min(1) })), async (c) => {
  try {
    const { q } = c.req.valid('query')

    // Normalizar wildcards: * → %
    const likeQ = `%${q.replace(/\*/g, '%')}%`
    const seen  = new Set<number>()
    const merge = (list: any[]) => list.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true })

    const MAX = 8

    // ── 1. ID numérico o código externo (wildcard) ───────────────────────────
    // Los códigos externos (ej. Booking.com) pueden ser numéricos pero más largos
    // que un int4 de Postgres (id es serial/int4, máx. 2147483647) — si se intenta
    // comparar contra reservations.id con un número fuera de rango, Postgres lanza
    // "out of range" y aborta TODA la consulta (incluida la parte de externalCode
    // que sí habría encontrado la reserva). Por eso el filtro por id solo se añade
    // cuando el número cabe en un int4.
    const isNumeric  = /^\d+$/.test(q)
    const fitsInInt4 = isNumeric && Number(q) <= 2147483647
    const codeConditions = [
      ilike(reservations.externalCode, likeQ),
      ...(fitsInInt4 ? [eq(reservations.id, parseInt(q))] : []),
    ]
    const byCode = await db.query.reservations.findMany({
      where: and(eq(reservations.propertyId, getPropertyId()), or(...codeConditions)),
      with: { guest: true, room: true },
      orderBy: desc(reservations.checkInDate),
      limit: MAX,
    })

    // ── 2. Nombre o apellido (parcial, soporta múltiples palabras) ──────────
    // Si hay espacios, cada token debe aparecer en firstName o lastName
    const tokens = q.trim().split(/\s+/).filter(Boolean)
    const guestWhere = tokens.length > 1
      ? and(...tokens.map(t => or(
          ilike(guests.firstName, `%${t}%`),
          ilike(guests.lastName,  `%${t}%`),
        )))
      : or(
          ilike(guests.firstName, likeQ),
          ilike(guests.lastName,  likeQ),
        )
    const matchGuests = await db.query.guests.findMany({
      where: and(eq(guests.propertyId, getPropertyId()), guestWhere),
      columns: { id: true },
      limit: 20,
    })
    const byName = matchGuests.length
      ? await db.query.reservations.findMany({
          where: and(eq(reservations.propertyId, getPropertyId()), or(...matchGuests.map(g => eq(reservations.guestId, g.id)))),
          with: { guest: true, room: true },
          orderBy: desc(reservations.checkInDate),
          limit: MAX,
        })
      : []

    // ── 3. Habitación exacta (solo si q es numérico) ─────────────────────────
    let byRoom: typeof byCode = []
    if (/^\d+$/.test(q)) {
      const matchRoom = await db.query.rooms.findFirst({
        where: and(eq(rooms.propertyId, getPropertyId()), eq(rooms.code, q)),
        columns: { id: true },
      })
      if (matchRoom) {
        byRoom = await db.query.reservations.findMany({
          where: and(
            eq(reservations.propertyId, getPropertyId()),
            eq(reservations.roomId, matchRoom.id),
            or(
              eq(reservations.status, 'confirmed'),
              eq(reservations.status, 'checked_in'),
            ),
          ),
          with: { guest: true, room: true },
          orderBy: desc(reservations.checkInDate),
          limit: 5,
        })
      }
    }

    // Orden: habitación exacta > nombre > código externo
    const combined = [
      ...merge(byRoom),
      ...merge(byName),
      ...merge(byCode),
    ].slice(0, MAX)

    return c.json({
      data: combined.map(r => ({
        id:           r.id,
        externalCode: r.externalCode,
        status:       r.status,
        checkInDate:  r.checkInDate,
        checkOutDate: r.checkOutDate,
        nights:       r.nights,
        guest: r.guest
          ? { firstName: r.guest.firstName, lastName: r.guest.lastName }
          : null,
        room: r.room ? { code: r.room.code } : null,
      })),
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/stats — contador de nuevas y problemáticas (reservationStatistic)
app.get('/stats', async (c) => {
  try {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
    const [newCount] = await Promise.all([
      db.select({ count: count() }).from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.checkInDate, today), eq(reservations.status, 'confirmed'))),
    ])
    return c.json({
      data: {
        newReservationCount: newCount[0]?.count ?? 0,
        problematicReservationCount: 0,
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/planning — reservas que se solapan con un rango de fechas (para Gantt)
app.get('/planning', zValidator('query', z.object({
  dateFrom: z.string().date(),
  dateTo:   z.string().date(),
})), async (c) => {
  try {
    const { dateFrom, dateTo } = c.req.valid('query')
    const list = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        lte(reservations.checkInDate, dateTo),
        gte(reservations.checkOutDate, dateFrom),
      ),
      with: {
        guest: true,
        room: { with: { roomType: true } },
      },
      orderBy: [reservations.checkInDate],
    })

    const resIds = list.map(r => r.id)

    // Obtener huéspedes adicionales (≠ titular) por reserva para mostrar en el planning
    const additionalGuestsMap: Record<number, { id: number; firstName: string; lastName: string; roomId: number }[]> = {}
    if (resIds.length > 0) {
      const agRows = await db
        .selectDistinct({
          reservationId: reservationNights.reservationId,
          guestId:   guests.id,
          firstName: guests.firstName,
          lastName:  guests.lastName,
          // En qué habitación del grupo duerme — para mostrar el nombre
          // correcto en las habitaciones extra del Planning, no solo en la principal.
          roomId:    reservationNights.roomId,
        })
        .from(reservationNights)
        .innerJoin(guests,       eq(reservationNights.guestId,       guests.id))
        .innerJoin(reservations, eq(reservationNights.reservationId, reservations.id))
        .where(and(
          inArray(reservationNights.reservationId, resIds),
          sql`${reservationNights.guestId} != ${reservations.guestId}`,
        ))
        .orderBy(reservationNights.reservationId, guests.id)
      for (const row of agRows) {
        if (!additionalGuestsMap[row.reservationId]) additionalGuestsMap[row.reservationId] = []
        // deduplication por si hay varias noches del mismo huésped
        if (!additionalGuestsMap[row.reservationId]!.find(g => g.id === row.guestId)) {
          additionalGuestsMap[row.reservationId]!.push({ id: row.guestId, firstName: row.firstName, lastName: row.lastName, roomId: row.roomId })
        }
      }
    }

    // Calcular deuda solo para reservas en checked_in — no cuenta los
    // depósitos retenidos sin cobrar como pago de la estancia (ver
    // src/lib/paymentAggregate.ts).
    const checkedInIds = list.filter(r => r.status === 'checked_in').map(r => r.id)
    const pendingMap: Record<number, number> = {}
    if (checkedInIds.length > 0) {
      const realPaidById = await realPaidByReservation(checkedInIds)
      for (const r of list) {
        if (r.status === 'checked_in') {
          pendingMap[r.id] = calcPendingBalance(r.total, realPaidById.get(r.id) ?? 0)
        }
      }
    }

    const data = list.map(r => {
      const additionalGuests = additionalGuestsMap[r.id] ?? []
      return {
        ...r,
        pendingAmount:    pendingMap[r.id] ?? 0,
        additionalGuests,
        guestCount:       1 + additionalGuests.length,
      }
    })
    return c.json({ data })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/calc-price?roomId=&rateId=&checkIn=&checkOut=
// Calcula el precio total de una estancia sumando los precios diarios de la tarifa.
// Para cada noche: busca precio específico por roomTypeId; si no hay, busca con roomTypeId=null.
app.get('/calc-price', zValidator('query', z.object({
  roomId:   z.coerce.number().int().positive(),
  rateId:   z.coerce.number().int().positive(),
  checkIn:  z.string().date(),
  checkOut: z.string().date(),
})), async (c) => {
  try {
    const { roomId, rateId, checkIn, checkOut } = c.req.valid('query')
    const nights = Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)
    if (nights <= 0) return c.json({ error: 'Fechas inválidas' }, 400)

    // Obtener roomTypeId de la habitación y datos de la tarifa (incluyendo posible tarifa base)
    const [room, rate] = await Promise.all([
      db.query.rooms.findFirst({ where: and(eq(rooms.id, roomId), eq(rooms.propertyId, getPropertyId())), columns: { roomTypeId: true } }),
      db.query.rates.findFirst({ where: and(eq(rates.id, rateId), eq(rates.propertyId, getPropertyId())) }),
    ])
    if (!room) return c.json({ error: 'Habitación no encontrada' }, 404)
    if (!rate) return c.json({ error: 'Tarifa no encontrada' }, 404)
    if (!room.roomTypeId) return c.json({ error: 'La habitación no tiene tipo configurado' }, 400)
    const roomTypeId = room.roomTypeId

    // Calcular las fechas de cada noche (check-in incluido, check-out excluido)
    const dates: string[] = []
    const cur = new Date(checkIn)
    for (let i = 0; i < nights; i++) {
      dates.push(cur.toISOString().slice(0, 10))
      cur.setDate(cur.getDate() + 1)
    }
    const lastDate = dates.at(-1)!

    // Resolver toda la cadena de derivación de tarifa y de tipo de habitación,
    // igual que en el motor de reservas (public.ts) — misma lógica compartida
    const roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.id, roomTypeId), eq(roomTypes.propertyId, getPropertyId())) })
    if (!roomType) return c.json({ error: 'Tipo de habitación no encontrado' }, 404)

    const [allRates, allRoomTypes] = await Promise.all([
      db.query.rates.findMany({ where: eq(rates.propertyId, rate.propertyId) }),
      db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, roomType.propertyId) }),
    ])
    const ratesById     = new Map(allRates.map(r => [r.id, r]))
    const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))

    const rateIdsToFetch     = rateChainIds(rate, ratesById)
    const roomTypeIdsToFetch = roomTypeChainIds(roomType, roomTypesById)

    const priceRows = await db.select({
      rateId:     rateDailyPrices.rateId,
      date:       rateDailyPrices.date,
      price:      rateDailyPrices.price,
      roomTypeId: rateDailyPrices.roomTypeId,
    }).from(rateDailyPrices).where(
      and(
        inArray(rateDailyPrices.rateId, rateIdsToFetch),
        gte(rateDailyPrices.date, checkIn),
        lte(rateDailyPrices.date, lastDate),
        or(
          inArray(rateDailyPrices.roomTypeId, roomTypeIdsToFetch),
          sql`${rateDailyPrices.roomTypeId} IS NULL`,
        ),
      )
    )

    const occupancy = roomType.maxOccupancy ?? 1
    const breakdown = dates.map(d => ({
      date: d,
      price: resolvePrice(ratesById, roomTypesById, priceRows, rateId, roomTypeId, d, occupancy),
    }))
    const knownNights = breakdown.filter(b => b.price !== null)
    const total = knownNights.reduce((s, b) => s + b.price!, 0)

    return c.json({ total: parseFloat(total.toFixed(2)), nights, breakdown, missingDates: nights - knownNights.length })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/:id — detalle completo
app.get('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with: {
        guest:          true,
        room:           { with: { roomType: true } },
        bookingChannel: true,
        rate:           true,
        nightRows:      { with: { guest: true, room: { with: { roomType: true } } } },
        notes:          { with: { author: true } },
      },
    })
    if (!reservation) return notFound(c, 'Reserva')
    return c.json({ data: reservation })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/reservations/:id/extras — extras de la reserva
app.get('/:id/extras', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    if (!(await ownReservation(id))) return notFound(c, 'Reserva')
    const list = await db.query.reservationSaleItems.findMany({
      where: eq(reservationSaleItems.reservationId, id),
      with: { saleItem: true },
      orderBy: desc(reservationSaleItems.createdAt),
    })
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/extras — añadir extra
app.post('/:id/extras', zValidator('json', z.object({
  saleItemId: z.number().int().positive(),
  quantity:   z.number().int().min(1).default(1),
  unitPrice:  z.number().nonnegative(),
  date:       z.string().date().optional(),
  notes:      z.string().optional(),
})), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')
    if (!(await ownReservation(id))) return notFound(c, 'Reserva')
    // El producto debe ser del catálogo del tenant
    const item = await db.query.saleItems.findFirst({ where: and(eq(saleItems.id, body.saleItemId), eq(saleItems.propertyId, getPropertyId())), columns: { id: true } })
    if (!item) return notFound(c, 'Producto')
    const [row] = await db.insert(reservationSaleItems).values({
      reservationId: id,
      saleItemId:    body.saleItemId,
      quantity:      body.quantity,
      unitPrice:     String(body.unitPrice),
      date:          body.date,
      notes:         body.notes,
      createdBy:     getUserId(c) ?? null,
    }).returning()
    // Actualizar total de la reserva sumando el extra
    const extra = body.quantity * body.unitPrice
    await db.update(reservations)
      .set({ total: String(parseFloat((await db.query.reservations.findFirst({
        where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())), columns: { total: true },
      }))?.total ?? '0') + extra), updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/reservations/:id/extras/:extId — quitar extra
app.delete('/:id/extras/:extId', async (c) => {
  try {
    const extId = Number(c.req.param('extId'))
    const resId = Number(c.req.param('id'))
    if (!(await ownReservation(resId))) return notFound(c, 'Reserva')
    const item = await db.query.reservationSaleItems.findFirst({
      where: and(eq(reservationSaleItems.id, extId), eq(reservationSaleItems.reservationId, resId)),
    })
    if (!item) return notFound(c, 'Extra')
    await db.delete(reservationSaleItems).where(eq(reservationSaleItems.id, extId))
    // Restar del total
    const subtracted = parseFloat(item.unitPrice) * item.quantity
    const current = await db.query.reservations.findFirst({ where: and(eq(reservations.id, resId), eq(reservations.propertyId, getPropertyId())), columns: { total: true } })
    const newTotal = Math.max(0, parseFloat(current?.total ?? '0') - subtracted)
    await db.update(reservations).set({ total: String(newTotal), updatedAt: new Date() }).where(and(eq(reservations.id, resId), eq(reservations.propertyId, getPropertyId())))
    return c.json({ data: item })
  } catch (err) { return serverError(c, err) }
})

// GET /api/reservations/:id/history — línea de tiempo de cambios
app.get('/:id/history', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with: { notes: { with: { author: true } }, checkedInByUser: true },
    })
    if (!res) return notFound(c, 'Reserva')

    type Event = { ts: string; icon: string; label: string; detail?: string }
    const events: Event[] = []
    const cur = currencySymbol((await getBranding()).currencyCode)

    const add = (ts: Date | string | null | undefined, icon: string, label: string, detail?: string) => {
      if (!ts) return
      events.push({ ts: new Date(ts).toISOString(), icon, label, detail })
    }

    // Cargar logs de cambio de estado (con usuario)
    type StatusLog = { from_status: string | null; to_status: string; source: string; changed_at: string; first_name: string | null; last_name: string | null }
    let statusLogs: StatusLog[] = []
    try {
      statusLogs = await db.execute(sql`
        SELECT rsl.from_status, rsl.to_status, rsl.source, rsl.changed_at,
               u.first_name, u.last_name
        FROM reservation_status_logs rsl
        LEFT JOIN users u ON u.id = rsl.user_id
        WHERE rsl.reservation_id = ${id}
        ORDER BY rsl.changed_at ASC
      `) as unknown as StatusLog[]
    } catch { /* tabla aún no existe — ignorar */ }

    const logHas = (pred: (l: StatusLog) => boolean) => statusLogs.some(pred)

    const STATUS_ICON: Record<string, string> = {
      checked_in: '🏠', checked_out: '🚪', cancelled: '✕', no_show: '⊘',
      confirmed: '📋', tentative: '📋', checking_out: '🏠',
    }
    const SOURCE_LABEL: Record<string, string> = {
      user: 'Usuario', fdm: 'FDM sync', import: 'FDM importación',
      checkin: 'Check-in', checkout: 'Check-out', cancel: 'Cancelación',
      revert: 'Reversión', auto: 'Sistema',
    }
    const STATUS_LABEL: Record<string, string> = {
      confirmed: 'Confirmada', tentative: 'Tentativa', checked_in: 'En casa',
      checking_out: 'Check-out pendiente', checked_out: 'Ha salido',
      cancelled: 'Cancelada', no_show: 'No show',
    }

    for (const l of statusLogs) {
      const icon  = STATUS_ICON[l.to_status] ?? '✏'
      const label = l.from_status == null
        ? (l.source === 'import' ? 'Importada desde FDM' : 'Reserva creada')
        : `${STATUS_LABEL[l.from_status] ?? l.from_status} → ${STATUS_LABEL[l.to_status] ?? l.to_status}`
      const who   = l.first_name ? `${l.first_name} ${l.last_name ?? ''}`.trim() : SOURCE_LABEL[l.source] ?? l.source
      add(l.changed_at, icon, label, who)
    }

    // Eventos sintéticos — solo si no están cubiertos por status logs
    if (!logHas(l => l.from_status == null)) {
      add(res.bookedAt ?? res.createdAt, '📋', 'Reserva creada')
    }
    if (!logHas(l => l.to_status === 'checked_in' && l.source === 'checkin')) {
      add(res.checkedInAt, '🏠', 'Check-in realizado',
        res.checkedInByUser ? `${res.checkedInByUser.firstName} ${res.checkedInByUser.lastName}` : undefined)
    }
    if (!logHas(l => l.to_status === 'checked_out')) {
      add(res.checkedOutAt, '🚪', 'Check-out realizado')
    }
    if (res.status === 'cancelled' && !logHas(l => l.to_status === 'cancelled')) {
      add(res.updatedAt, '✕', 'Reserva cancelada')
    }
    if (res.status === 'no_show' && !logHas(l => l.to_status === 'no_show')) {
      add(res.updatedAt, '⊘', 'No show')
    }

    // Notas y cambios registrados — excluir los que son redundantes con eventos de estado
    const REDUNDANT_NOTES = new Set(['Check-out realizado', 'Reserva cancelada'])
    for (const n of res.notes ?? []) {
      const author = n.author ? `${n.author.firstName} ${n.author.lastName}` : undefined
      if ((n as any).type === 'change') {
        const lines = n.note.split('\n').filter(l => !REDUNDANT_NOTES.has(l.trim()))
        if (lines.length === 0) continue
        add(n.createdAt, '✏', 'Modificación',
          `${author ? author + ': ' : ''}${lines.join(' · ')}`)
      } else {
        add(n.createdAt, '📝', 'Nota',
          author ? `${author}: "${n.note.slice(0, 120)}${n.note.length > 120 ? '…' : ''}"` : `"${n.note.slice(0, 120)}${n.note.length > 120 ? '…' : ''}"`)
      }
    }

    // Depósitos — se guardan como financial_transactions con paymentMethod
    // 'deposit'/'deposit_cc' (ver pestaña Depósitos en ReservationDetailView).
    // "Cobrar" un depósito ACTUALIZA la fila (category → 'deposit_cobrado'),
    // no crea una nueva — así que createdAt/createdByUser siguen marcando el
    // registro ORIGINAL, no la resolución (para eso están resolvedAt/resolvedBy).
    // La devolución sí es una fila nueva propia, con category 'deposit_return'.
    const DEPOSIT_TYPE_LABEL: Record<string, string> = {
      deposit_preauth: 'Preautorización', deposit_cash: 'Efectivo',
      deposit_card: 'Datos de tarjeta', deposit_cobrado: 'Cobrado',
    }
    const deposits = await db.query.financialTransactions.findMany({
      where: and(
        eq(financialTransactions.propertyId, getPropertyId()),
        eq(financialTransactions.reservationId, id),
        inArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
      ),
      with: { createdByUser: true, resolvedByUser: true },
    })
    for (const d of deposits) {
      const who = d.createdByUser ? `${(d.createdByUser as any).firstName} ${(d.createdByUser as any).lastName}` : undefined
      const amount = parseFloat(String(d.amount))
      if (d.category === 'deposit_return') {
        add(d.createdAt, '↩️', 'Depósito devuelto',
          `${Math.abs(amount).toFixed(2)} ${cur}${who ? ' · ' + who : ''}`)
      } else {
        const typeLabel = DEPOSIT_TYPE_LABEL[d.category ?? ''] ?? d.paymentMethod
        const amountStr = d.category === 'deposit_card' && amount === 0 ? 'sin importe' : `${amount.toFixed(2)} ${cur}`
        add(d.createdAt, '💰', 'Depósito registrado',
          `${typeLabel} · ${amountStr}${who ? ' · ' + who : ''}`)
        if (d.category === 'deposit_cobrado' && d.resolvedAt) {
          const resolvedByName = d.resolvedByUser ? `${(d.resolvedByUser as any).firstName} ${(d.resolvedByUser as any).lastName}` : undefined
          add(d.resolvedAt, '✅', 'Depósito cobrado',
            `${amount.toFixed(2)} ${cur}${resolvedByName ? ' · ' + resolvedByName : ''}`)
        }
      }
    }

    events.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
    return c.json({ data: events })
  } catch (err) { return serverError(c, err) }
})

// Verifica solapamiento de reservas en una misma habitación (excluye
// canceladas y no-shows — un no-show significa que nadie se presentó, así
// que esas fechas quedan libres de verdad; mismo criterio que ya usa Planning
// para pintar la habitación como libre, ver frontend/views/PlanningView.tsx
// activeRes = !['cancelled','no_show'].includes(r.status)).
// Las habitaciones virtuales (isVirtual=true) admiten varias reservas simultáneas.
// Exportada — también la usa el portal de cliente (src/routes/customer.ts) para
// comprobar disponibilidad al ampliar una estancia.
export async function hasRoomOverlap(
  roomId: number,
  checkInDate: string,
  checkOutDate: string,
  excludeId?: number,
): Promise<{ id: number; externalCode: string | null } | null> {
  const room = await db.query.rooms.findFirst({
    where: and(eq(rooms.id, roomId), eq(rooms.propertyId, getPropertyId())),
    with: { roomType: { columns: { isVirtual: true } } },
    columns: { id: true },
  })
  if ((room?.roomType as any)?.isVirtual) return null

  const conds = [
    eq(reservations.roomId, roomId),
    lt(reservations.checkInDate, checkOutDate),
    gt(reservations.checkOutDate, checkInDate),
    notInArray(reservations.status, ['cancelled', 'no_show']),
  ]
  if (excludeId !== undefined) conds.push(ne(reservations.id, excludeId))
  const [hit] = await db
    .select({ id: reservations.id, externalCode: reservations.externalCode })
    .from(reservations)
    .where(and(...conds))
    .limit(1)
  return hit ?? null
}


// POST /api/reservations — crear reserva
app.post('/', zValidator('json', createSchema), async (c) => {
  try {
    const body   = c.req.valid('json')
    const userId = getUserId(c)
    const checkIn = new Date(body.checkInDate)
    const checkOut = new Date(body.checkOutDate)
    const nights = Math.round((checkOut.getTime() - checkIn.getTime()) / 86400000)

    if (nights <= 0) {
      return c.json({ error: 'La fecha de salida debe ser posterior a la de entrada' }, 400)
    }

    const refErr = await checkOwnRefs(body)
    if (refErr) return c.json({ error: refErr }, 404)

    const overlap = await hasRoomOverlap(body.roomId, body.checkInDate, body.checkOutDate)
    if (overlap) {
      const code = overlap.externalCode ? ` (${overlap.externalCode})` : ` #${overlap.id}`
      return c.json({ error: `La habitación ya tiene una reserva en esas fechas${code}` }, 409)
    }

    for (const extraRoomId of (body.extraRoomIds ?? [])) {
      const extraOverlap = await hasRoomOverlap(extraRoomId, body.checkInDate, body.checkOutDate)
      if (extraOverlap) {
        const code = extraOverlap.externalCode ? ` (${extraOverlap.externalCode})` : ` #${extraOverlap.id}`
        return c.json({ error: `La habitación extra ${extraRoomId} ya tiene una reserva en esas fechas${code}` }, 409)
      }
    }

    const { extraRoomIds, total: totalBody, ...restBody } = body
    const [reservation] = await db.insert(reservations).values({
      ...restBody,
      propertyId: getPropertyId(),
      nights,
      status: 'confirmed',
      currencyId: await tenantCurrencyId(),
      total: totalBody != null ? String(totalBody) : '0',
      extraRoomIds: (extraRoomIds && extraRoomIds.length > 0 ? extraRoomIds : []) as any,
    }).returning()

    await logStatusChange(reservation!.id, null, 'confirmed', 'user', userId)

    // Bloquear disponibilidad en Nobeds (best-effort, no falla la reserva)
    if (body.roomId && (await hasFeature('nobeds')) && (await nobedsConfigured())) {
      db.query.rooms.findFirst({ where: and(eq(rooms.id, body.roomId), eq(rooms.propertyId, getPropertyId())), with: { roomType: { columns: { nobedsRoomId: true } } } })
        .then(r => { if (r?.roomType?.nobedsRoomId) blockDates(r.roomType.nobedsRoomId, body.checkInDate, body.checkOutDate).catch(() => {}) })
        .catch(() => {})
    }

    return c.json({ data: reservation }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/reservations/:id — modificar reserva (registra cambios en historial)
app.patch('/:id', zValidator('json', updateSchema, (result, c) => {
  if (!result.success) {
    const msg = result.error.issues[0]?.message ?? 'Datos inválidos'
    return c.json({ error: `Validación: ${msg}` }, 400)
  }
}), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const body   = c.req.valid('json')
    const userId = getUserId(c)

    // Cambiar el estado a mano (fuera de los flujos de check-in/check-out/
    // cancelación) es una operación de admin — se salta cualquier efecto
    // secundario de esos flujos, así que solo el administrador puede forzarlo.
    if (body.status !== undefined && !isAdmin(c)) {
      return c.json({ error: 'Sin permisos para cambiar el estado directamente' }, 403)
    }

    // Leer estado actual antes de actualizar
    const current = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with: { room: { with: { roomType: true } }, rate: true, bookingChannel: true },
    })
    if (!current) return notFound(c, 'Reserva')
    {
      const refErr = await checkOwnRefs({ guestId: body.guestId, roomId: body.roomId, rateId: body.rateId, bookingChannelId: body.bookingChannelId, extraRoomIds: body.extraRoomIds })
      if (refErr) return c.json({ error: refErr }, 404)
    }

    // Calcular noches si cambian las fechas
    const newRoomId   = body.roomId       ?? current.roomId!
    const newCheckIn  = body.checkInDate  ?? current.checkInDate
    const newCheckOut = body.checkOutDate ?? current.checkOutDate
    const newNights   = Math.round(
      (new Date(newCheckOut).getTime() - new Date(newCheckIn).getTime()) / 86400000
    )

    // Mover una reserva de un día a otro (arrastrándola en el Planning, que
    // siempre manda checkInDate ahí) solo lo puede hacer admin/dirección —
    // cambiar de habitación el mismo día sigue abierto a recepción, igual
    // que ampliar la estancia (ExtendReservationModal, que solo toca
    // checkOutDate y no pasa por aquí con checkInDate). Comprobado en el
    // backend, no solo en el frontend, para que no se pueda saltar llamando
    // a la API directamente.
    if (body.checkInDate !== undefined && body.checkInDate !== current.checkInDate && !isAdmin(c)) {
      return c.json({ error: 'Solo admin/dirección puede cambiar la fecha de entrada de una reserva' }, 403)
    }

    // Validar solapamiento si cambia habitación o fechas
    const roomOrDateChanged = body.roomId !== undefined || body.checkInDate !== undefined || body.checkOutDate !== undefined
    if (roomOrDateChanged && current.status !== 'cancelled') {
      const overlap = await hasRoomOverlap(newRoomId, newCheckIn, newCheckOut, id)
      if (overlap) {
        const code = overlap.externalCode ? ` (${overlap.externalCode})` : ` #${overlap.id}`
        return c.json({ error: `La habitación ya tiene una reserva en esas fechas${code}` }, 409)
      }
    }

    // Cambio de habitación delicado: huésped ya en casa (checked_in), o el
    // tipo nuevo es virtual (solo permitido tras el check-out, ver abajo) —
    // en ambos casos exige un motivo de al menos 5 palabras reales
    // (hasMinWords, ignora puntuación suelta) que quede en el historial.
    // Se resuelve ANTES del update para poder rechazarlo sin escribir nada
    // si falta el motivo.
    const roomChanging = body.roomId !== undefined && body.roomId !== current.roomId
    let newRoomWithType: (typeof current.room & { roomType: any }) | null = null
    if (roomChanging) {
      newRoomWithType = await db.query.rooms.findFirst({
        where: and(eq(rooms.id, body.roomId!), eq(rooms.propertyId, getPropertyId())), with: { roomType: true },
      }) as any
      const targetIsVirtual = !!(newRoomWithType as any)?.roomType?.isVirtual
      // Mover a una habitación virtual (agrupación de facturación) solo
      // tiene sentido una vez la estancia real ha terminado — si no, se
      // perdería el seguimiento normal de la reserva (check-in, ZKTeco,
      // limpieza...) mientras el huésped sigue físicamente alojado.
      if (targetIsVirtual && current.status !== 'checked_out') {
        return c.json({ error: 'La reserva debe estar en estado "Ha salido" (check-out) antes de moverla a una habitación virtual' }, 400)
      }
      const needsReason = current.status === 'checked_in' || targetIsVirtual
      if (needsReason && !hasMinWords(body.changeReason, 5)) {
        const why = current.status === 'checked_in' ? 'el huésped ya está en casa' : 'el nuevo tipo es virtual'
        return c.json({ error: `Este cambio de habitación necesita una explicación de al menos 5 palabras (${why})` }, 400)
      }
    }

    // Habitaciones extra añadidas/quitadas (reservas de grupo) — quitar una
    // exige el mismo motivo de al menos 5 palabras que un cambio de
    // habitación delicado (comparte el campo changeReason). Añadir no lo exige.
    const oldExtraIds = ((current.extraRoomIds as number[] | null) ?? [])
    const newExtraIds = body.extraRoomIds !== undefined ? body.extraRoomIds : oldExtraIds
    const removedExtraIds = oldExtraIds.filter(x => !newExtraIds.includes(x))
    const addedExtraIds   = newExtraIds.filter(x => !oldExtraIds.includes(x))
    if (removedExtraIds.length > 0 && !hasMinWords(body.changeReason, 5)) {
      return c.json({ error: 'Quitar una habitación extra necesita una explicación de al menos 5 palabras' }, 400)
    }

    // Añadir habitación extra: dirección puede hacerlo siempre, sin motivo
    // (igual que hasta ahora). Recepción puede hacerlo para cualquier canal
    // de reserva (antes solo Walk-in hecho hoy mismo), pero exige la misma
    // explicación de al menos 5 palabras reales que ya se usa para quitar
    // una habitación extra o un cambio de habitación delicado — queda en el
    // historial de quién añadió qué y por qué.
    if (addedExtraIds.length > 0 && !isAdmin(c) && !hasMinWords(body.changeReason, 5)) {
      return c.json({ error: 'Añadir una habitación extra necesita una explicación de al menos 5 palabras' }, 400)
    }

    const { total: totalBody2, changeReason, ...bodyRest } = body

    // Habitación(es) extra añadidas: calcular su precio para las mismas
    // fechas de la reserva, con la misma tarifa, y sumarlo al total — si no,
    // el saldo pendiente (que es solo total - pagado, ver paymentAggregate.ts)
    // nunca reflejaba la habitación nueva hasta que alguien lo corregía a
    // mano. Se respeta un total explícito si el cliente ya lo manda en este
    // mismo PATCH (editar precio a mano sigue pudiendo anular esto). Misma
    // lógica que GET /calc-price, replicada aquí porque hace falta ANTES del
    // update (para incluirla en el total nuevo), no después.
    let addedRoomsTotal = 0
    if (addedExtraIds.length > 0 && totalBody2 == null && current.rateId) {
      const addedRooms = await db.select({ id: rooms.id, roomTypeId: rooms.roomTypeId })
        .from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, addedExtraIds)))
      const roomTypeIds = addedRooms.map(r => r.roomTypeId).filter((x): x is number => x != null)

      if (roomTypeIds.length === addedRooms.length && roomTypeIds.length > 0) {
        const nightDates: string[] = []
        const cur = new Date(newCheckIn)
        for (let i = 0; i < newNights; i++) { nightDates.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }
        const lastDate = nightDates.at(-1)

        const propertyId = getPropertyId()
        const [allRates, allRoomTypes] = await Promise.all([
          db.query.rates.findMany({ where: eq(rates.propertyId, propertyId) }),
          db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, propertyId) }),
        ])
        const ratesById     = new Map(allRates.map(r => [r.id, r]))
        const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
        const rate = ratesById.get(current.rateId)

        if (rate && lastDate) {
          const rateIdsToFetch = rateChainIds(rate, ratesById)
          const roomTypeIdsToFetch = new Set<number>()
          for (const rtId of roomTypeIds) {
            const rt = roomTypesById.get(rtId)
            if (rt) for (const chainId of roomTypeChainIds(rt, roomTypesById)) roomTypeIdsToFetch.add(chainId)
          }
          const priceRows = await db.select({
            rateId: rateDailyPrices.rateId, date: rateDailyPrices.date,
            price: rateDailyPrices.price, roomTypeId: rateDailyPrices.roomTypeId,
          }).from(rateDailyPrices).where(and(
            inArray(rateDailyPrices.rateId, rateIdsToFetch),
            gte(rateDailyPrices.date, newCheckIn), lte(rateDailyPrices.date, lastDate),
            or(inArray(rateDailyPrices.roomTypeId, [...roomTypeIdsToFetch]), sql`${rateDailyPrices.roomTypeId} IS NULL`),
          ))

          for (const rtId of roomTypeIds) {
            const occupancy = roomTypesById.get(rtId)?.maxOccupancy ?? 1
            for (const d of nightDates) {
              const price = resolvePrice(ratesById, roomTypesById, priceRows, current.rateId, rtId, d, occupancy)
              if (price !== null) addedRoomsTotal += price
            }
          }
          addedRoomsTotal = Math.round(addedRoomsTotal * 100) / 100
        }
      }
    }

    const newTotal = totalBody2 != null
      ? String(totalBody2)
      : addedRoomsTotal > 0 ? String(Math.round((parseFloat(current.total) + addedRoomsTotal) * 100) / 100) : undefined

    // Si la nueva fecha de salida queda en el futuro y el estado es checking_out, revertir a checked_in
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
    const statusCorrection =
      current.status === 'checking_out' && newCheckOut > today
        ? { status: 'checked_in' as const }
        : {}

    // Ampliación de estancia (ver también la marca "🛏️ Ampliación" más abajo,
    // que usa la alerta extension-unpaid): guardar un snapshot de ANTES de
    // esta ampliación para poder deshacer solo-esta (un nivel), mientras no
    // se haya cobrado — ver POST /:id/undo-extension. Se sobrescribe en cada
    // ampliación nueva, así que solo la última es deshacible.
    const extended = body.checkOutDate !== undefined && newCheckOut > current.checkOutDate
    const pendingExtensionUpdate = extended
      ? { pendingExtension: { prevCheckOutDate: current.checkOutDate, prevNights: current.nights, prevTotal: current.total, extendedAt: new Date().toISOString() } }
      : {}

    const [updated] = await db.update(reservations)
      .set({ ...bodyRest, ...statusCorrection, ...pendingExtensionUpdate, nights: newNights, updatedAt: new Date(), ...(newTotal !== undefined ? { total: newTotal } : {}) })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    // ── Registrar cambios en historial ─────────────────────────────────────────
    const changes: string[] = []

    if (roomChanging) {
      const newRoom = newRoomWithType
      changes.push(`Habitación: ${current.room?.code ?? '—'} → ${newRoom?.code ?? body.roomId}`)
      // Además de la habitación en sí, si cambia de TIPO (p.ej. de Doble a
      // Superior) se registra aparte — es lo que de verdad importa para
      // ocupación/precio, y el código de habitación por sí solo no lo deja claro.
      const oldTypeId = current.room?.roomTypeId ?? null
      const newTypeId = newRoom?.roomTypeId ?? null
      if (oldTypeId !== newTypeId) {
        changes.push(`Tipo: ${(current.room as any)?.roomType?.name ?? '—'} → ${(newRoom as any)?.roomType?.name ?? '—'}`)
      }
      // Motivo del cambio — solo existe cuando era obligatorio (huésped en
      // casa o tipo virtual), pero si lo mandan igualmente aunque no fuera
      // obligatorio, se registra también.
      if (changeReason && hasMinWords(changeReason, 1)) {
        changes.push(`Motivo del cambio de habitación: ${changeReason}`)
      }
    }
    if (removedExtraIds.length > 0 || addedExtraIds.length > 0) {
      const codeIds = [...removedExtraIds, ...addedExtraIds]
      const codeRows = codeIds.length > 0
        ? await db.select({ id: rooms.id, code: rooms.code }).from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, codeIds)))
        : []
      const codeById = new Map(codeRows.map(r => [r.id, r.code]))
      if (addedExtraIds.length > 0) {
        changes.push(`Habitación(es) extra añadida(s): ${addedExtraIds.map(id => codeById.get(id) ?? `#${id}`).join(', ')}`)
        if (totalBody2 != null) {
          // Total ya venía fijado a mano en este mismo PATCH — no se intenta calcular nada.
        } else if (addedRoomsTotal > 0) {
          changes.push(`Importe añadido al total por la(s) habitación(es) extra: +${addedRoomsTotal.toFixed(2)} ${currencySymbol((await getBranding()).currencyCode)}`)
        } else {
          changes.push('Sin precio configurado para calcular el importe de la(s) habitación(es) extra — revisa el total a mano')
        }
        // Motivo — solo es obligatorio para recepción (ver comprobación de
        // arriba), pero si lo manda igual (p.ej. dirección) se registra también.
        if (changeReason && hasMinWords(changeReason, 1)) {
          changes.push(`Motivo de la habitación extra añadida: ${changeReason}`)
        }
      }
      if (removedExtraIds.length > 0) {
        changes.push(`Habitación(es) extra quitada(s): ${removedExtraIds.map(id => codeById.get(id) ?? `#${id}`).join(', ')}`)
        changes.push(`Motivo de la habitación extra quitada: ${changeReason}`)
      }
    }
    if (body.checkInDate !== undefined && body.checkInDate !== current.checkInDate) {
      changes.push(`Entrada: ${fmtD(current.checkInDate)} → ${fmtD(body.checkInDate)}`)
    }
    if (body.checkOutDate !== undefined && body.checkOutDate !== current.checkOutDate) {
      // Marca "🛏️ Ampliación" (en vez de solo "Salida") cuando la fecha de
      // salida se alarga — la usa GET /api/alerts/urgent (extension-unpaid)
      // para detectar reservas ampliadas que se quedan sin cobrar, sin
      // necesitar una columna nueva para "fecha de salida original".
      const extended = body.checkOutDate > current.checkOutDate
      changes.push(`${extended ? '🛏️ Ampliación' : 'Salida'}: ${fmtD(current.checkOutDate)} → ${fmtD(body.checkOutDate)}`)
    }
    if (body.people !== undefined && body.people !== current.people) {
      changes.push(`Personas: ${current.people} → ${body.people}`)
    }
    if (body.rateId !== undefined && body.rateId !== current.rateId) {
      const [oldRate, newRate] = await Promise.all([
        current.rateId ? db.query.rates.findFirst({ where: and(eq(rates.id, current.rateId), eq(rates.propertyId, getPropertyId())), columns: { title: true } }) : null,
        body.rateId    ? db.query.rates.findFirst({ where: and(eq(rates.id, body.rateId), eq(rates.propertyId, getPropertyId())),    columns: { title: true } }) : null,
      ])
      changes.push(`Tarifa: ${oldRate?.title ?? '—'} → ${newRate?.title ?? '—'}`)
    }
    if (body.bookingChannelId !== undefined && body.bookingChannelId !== current.bookingChannelId) {
      const newCh = body.bookingChannelId
        ? await db.query.bookingChannels.findFirst({ where: and(eq(bookingChannels.id, body.bookingChannelId), eq(bookingChannels.propertyId, getPropertyId())), columns: { name: true } })
        : null
      changes.push(`Canal: ${current.bookingChannel?.name ?? '—'} → ${newCh?.name ?? 'Directo'}`)
    }
    if (body.externalCode !== undefined && body.externalCode !== current.externalCode) {
      changes.push(`Código externo: ${current.externalCode ?? '—'} → ${body.externalCode ?? '—'}`)
    }
    if (body.groupName !== undefined && body.groupName !== current.groupName) {
      changes.push(`Grupo: ${current.groupName ?? '—'} → ${body.groupName ?? '—'}`)
    }
    if (changes.length > 0) {
      await db.insert(reservationNotes).values({
        reservationId: id,
        authorId:      userId,
        note:          changes.join('\n'),
        type:          'change',
      })
    }

    // Registrar cambio de estado en log
    if (statusCorrection.status) {
      await logStatusChange(id, current.status, statusCorrection.status, 'auto', userId)
    } else if (body.status && body.status !== current.status) {
      await logStatusChange(id, current.status, body.status as string, 'user', userId)
    }

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/undo-extension — deshacer la ÚLTIMA ampliación
// de estancia (ver pendingExtension en el schema), solo si lo ampliado sigue
// sin cobrar. Un solo nivel: si se amplió dos veces sin cobrar, esto solo
// revierte la segunda.
app.post('/:id/undo-extension', async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const reservation = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!reservation) return notFound(c, 'Reserva')

    const pending = reservation.pendingExtension
    // El checkOutDate actual debe seguir siendo posterior al de antes de la
    // ampliación — si no, algo más (partir reserva, otra edición manual) ya
    // movió la fecha después de ampliar y este snapshot ya no es fiable.
    if (!pending || !(reservation.checkOutDate > pending.prevCheckOutDate)) {
      return conflict(c, 'No hay ninguna ampliación pendiente de deshacer')
    }
    if (['checked_out', 'cancelled'].includes(reservation.status)) {
      return conflict(c, `No se puede deshacer una ampliación en estado '${reservation.status}'`)
    }

    const realPaid = (await realPaidByReservation([id])).get(id) ?? 0
    const due = calcPendingBalance(reservation.total, realPaid)
    if (due <= 0.10) {
      return conflict(c, 'Esta ampliación ya está cobrada — no se puede deshacer')
    }

    const [updated] = await db.update(reservations)
      .set({
        checkOutDate:     pending.prevCheckOutDate,
        nights:           pending.prevNights,
        total:            pending.prevTotal,
        pendingExtension: null,
        updatedAt:        new Date(),
      })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    await db.insert(reservationNotes).values({
      reservationId: id,
      authorId:      userId,
      note:          `↩️ Ampliación deshecha (sin cobrar): salida ${fmtD(reservation.checkOutDate)} → ${fmtD(pending.prevCheckOutDate)}, total ${reservation.total} ${currencySymbol((await getBranding()).currencyCode)} → ${pending.prevTotal} ${currencySymbol((await getBranding()).currencyCode)}`,
      type:          'change',
    })

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/check-in — hacer check-in (con datos del huésped opcionales)
const checkInGuestSchema = z.object({
  checkinStartedAt:   z.string().datetime().optional(), // timestamp ISO del cliente, primer intento
  firstName:          z.string().min(1).optional(),
  lastName:           z.string().min(1).optional(),
  secondLastName:     z.string().optional(),
  gender:             z.enum(['male', 'female', 'non_binary', 'unspecified']).optional(),
  dateOfBirth:        z.string().date().optional(),
  nationality:        z.string().optional(),
  phone:              z.string().optional(),
  email:              z.string().email().optional().or(z.literal('')),
  idDocType:          z.enum(['dni', 'nie', 'passport', 'driving_licence', 'other']).optional(),
  idDocNumber:        z.string().optional(),
  idDocSupportNumber: z.string().optional(),
  idDocIssuer:        z.string().optional(),
  idDocExpiryDate:    z.string().date().optional(),
  address1:           z.string().optional(),
  zipCode:            z.string().optional(),
  city:               z.string().optional(),
  countryId:          z.number().int().optional(),
  people:             z.number().int().positive().optional(),
}).optional()

app.post('/:id/check-in', zValidator('json', checkInGuestSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const guestData = c.req.valid('json')

    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true },
    })
    if (!reservation) return notFound(c, 'Reserva')
    if (!['confirmed', 'arriving', 'tentative'].includes(reservation.status)) {
      return conflict(c, `No se puede hacer check-in en estado '${reservation.status}'`)
    }
    // Bloquear check-in con el email alias de Booking: hay que capturar el real
    const guestEmail = (reservation as any).guest?.email as string | undefined
    if (guestEmail && /@guest\.booking\.com$/i.test(guestEmail.trim())) {
      return conflict(c, 'El huésped tiene el email temporal de Booking — registra su email real antes del check-in')
    }

    // Bloquear check-in si hay contrato pendiente sin firmar
    const contracts = await db.select({ status: guestContracts.status })
      .from(guestContracts)
      .where(eq(guestContracts.reservationId, id))
    if (contracts.length > 0 && !contracts.some(ct => ct.status === 'signed')) {
      return conflict(c, 'El contrato de admisión no ha sido firmado — el huésped debe firmar antes del check-in')
    }

    // Bloquear check-in sin depósito registrado: debe haber al menos una
    // transacción de depósito (efectivo/CC/preauth) que no esté ya devuelta.
    // Misma lógica de "devuelto" que la pestaña Depósitos del frontend:
    // una fila con category='deposit_return' y description=`dep:<id original>`.
    const depositTx = await db.select({ id: financialTransactions.id, category: financialTransactions.category, description: financialTransactions.description })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.reservationId, id),
        inArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
      ))
    const returnedIds = new Set(
      depositTx.filter(t => t.category === 'deposit_return' && t.description?.startsWith('dep:'))
        .map(t => Number(t.description!.slice(4)))
    )
    const hasActiveDeposit = depositTx.some(t => t.category !== 'deposit_return' && !returnedIds.has(t.id))
    if (!hasActiveDeposit) {
      return conflict(c, 'No hay ningún depósito registrado — añade uno en la pestaña "Depósitos" antes del check-in')
    }

    // Enrolado automático por reserva consecutiva: mismo huésped TITULAR
    // (identificado por su documento — idDocType+idDocNumber, no por guestId,
    // que puede tener duplicados) en la MISMA habitación, entrando el mismo
    // día en que sale la reserva anterior — y SOLO si esa anterior sigue
    // 'checked_in' en este momento (no vale una ya cerrada ni una futura).
    // No hace falta volver a pasar la tarjeta física: se reutiliza la que ya
    // tenía enrolada.
    let autoEnrolledFromReservationId: number | null = null
    if (!reservation.zktecoCardNo && reservation.roomId) {
      const effDocNumber = (guestData as any)?.idDocNumber ?? (reservation.guest as any)?.idDocNumber
      const effDocType   = (guestData as any)?.idDocType   ?? (reservation.guest as any)?.idDocType
      if (effDocNumber && effDocType) {
        const [prev] = await db.select({
          id: reservations.id, zktecoCardNo: reservations.zktecoCardNo,
          zktecoCardBe: reservations.zktecoCardBe, ttlockCardIds: reservations.ttlockCardIds,
          checkInDate: reservations.checkInDate,
        }).from(reservations)
          .innerJoin(guests, eq(reservations.guestId, guests.id))
          .where(and(
            eq(reservations.roomId, reservation.roomId),
            eq(reservations.checkOutDate, reservation.checkInDate),
            // La anterior puede seguir checked_in (aún no ha salido) o ya
            // estar checked_out (recepción ya cerró esa y ahora abre esta) —
            // en ambos casos zktecoCardNo/zktecoCardBe sobreviven (solo se
            // marca zktecoCardRevokedAt, no se borran, ver schema).
            inArray(reservations.status, ['checked_in', 'checked_out']),
            ne(reservations.id, id),
            isNotNull(reservations.zktecoCardNo),
            eq(guests.idDocType, effDocType),
            eq(guests.idDocNumber, effDocNumber),
          ))
          .orderBy(desc(reservations.checkOutDate)).limit(1)
        if (prev) {
          await db.update(reservations)
            .set({ zktecoCardNo: prev.zktecoCardNo, zktecoCardBe: prev.zktecoCardBe, zktecoEnrolledAt: new Date(), updatedAt: new Date() })
            .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
          reservation.zktecoCardNo = prev.zktecoCardNo
          autoEnrolledFromReservationId = prev.id
          // Re-programa la MISMA tarjeta física en la cerradura, con la
          // ventana completa: desde el check-in de la primera reserva hasta
          // el check-out de esta segunda.
          const primaryRoom = reservation.room as any
          if (primaryRoom?.lockType === 'ttlock' && primaryRoom?.ttlockId && (await hasFeature('ttlock')) && (await ttlockConfigured()) && prev.zktecoCardBe) {
            const lockRooms = await roomsWithLock(primaryRoom, (reservation.extraRoomIds ?? []) as number[])
            // Ventana completa: desde el check-in de la PRIMERA reserva hasta
            // el check-out de esta segunda — no solo las fechas de esta última.
            await reenrollCard(
              { id, zktecoCardBe: prev.zktecoCardBe, ttlockCardIds: prev.ttlockCardIds, zktecoExtraCards: (prev as any).zktecoExtraCards ?? null, guest: reservation.guest as any },
              lockRooms, await propertyMs(prev.checkInDate, 14), await propertyMs(reservation.checkOutDate, 12),
            ).catch(() => {})
          }
          await db.insert(reservationNotes).values({
            reservationId: id, authorId: userId,
            note: `🔑 Tarjeta ZKTeco reutilizada automáticamente de la reserva #${prev.id} (mismo huésped titular, misma habitación, entrada consecutiva a esa salida) — reprogramada del ${prev.checkInDate} al ${reservation.checkOutDate}`,
            type: 'change',
          })
        }
      }
    }

    // Registrar estado de pasos opcionales en el momento del check-in
    const hadContract    = contracts.some(ct => ct.status === 'signed')
    const zktecoEnrolled = !!(reservation as any).zktecoCardNo && !(reservation as any).zktecoCardRevokedAt
    const sesSent        = !!(reservation as any).sesSubmittedAt

    // Actualizar datos del huésped si se enviaron
    if (guestData && reservation.guestId) {
      const { people, ...guestFields } = guestData
      const cleanFields = Object.fromEntries(
        Object.entries(guestFields).filter(([, v]) => v !== undefined && v !== '')
      )
      if (Object.keys(cleanFields).length > 0) {
        await db.update(guests)
          .set({ ...cleanFields, updatedAt: new Date() })
          .where(and(eq(guests.id, reservation.guestId), eq(guests.propertyId, getPropertyId())))
      }
      if (people) {
        await db.update(reservations).set({ people }).where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      }
    }

    // Usar el timestamp del cliente como inicio del check-in si no había uno previo
    const startedAt = reservation.checkinStartedAt
      ?? (guestData?.checkinStartedAt ? new Date(guestData.checkinStartedAt) : new Date())

    const [updated] = await db.update(reservations)
      .set({
        status: 'checked_in',
        previousStatus: reservation.status,
        checkedInAt: new Date(),
        checkedInBy: userId,
        checkinStartedAt:      startedAt,
        checkinHadContract:    hadContract,
        checkinZktecoEnrolled: zktecoEnrolled,
        checkinSesSent:        sesSent,
        checkinAbandonedAt:    null,
        checkinAbandonedBy:    null,
        updatedAt: new Date(),
      })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    // ── TTLock: generar código si la habitación tiene cerradura TTLock configurada
    let ttlockResult: { code: string; sentTo?: string } | undefined
    let ttlockError: string | undefined
    const room = reservation.room as any
    if (room?.lockType === 'ttlock' && room?.ttlockId && (await hasFeature('ttlock')) && (await ttlockConfigured())) {
      try {
        const guest   = reservation.guest as any
        const startMs = new Date(reservation.checkInDate  + 'T14:00:00').getTime()
        const endMs   = new Date(reservation.checkOutDate + 'T12:00:00').getTime()
        const { code, keyboardPwdId } = await createPasscode({
          lockId:  room.ttlockId,
          name:    `Reserva #${id} - ${guest?.firstName ?? ''} ${guest?.lastName ?? ''}`.trim(),
          startMs,
          endMs,
        })
        await db.update(reservations)
          .set({ ttlockCode: code, ttlockCodeId: keyboardPwdId, updatedAt: new Date() })
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
        ttlockResult = { code }
        if (guest?.email) {
          await sendLockCode({
            to:        guest.email,
            guestName: `${guest.firstName} ${guest.lastName}`,
            roomCode:  room.code,
            code:      code + '#',
            checkIn:   reservation.checkInDate,
            checkOut:  reservation.checkOutDate,
          })
          await db.update(reservations)
            .set({ ttlockSentAt: new Date(), updatedAt: new Date() })
            .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
          ttlockResult.sentTo = guest.email
        }
      } catch (e: any) {
        ttlockError = e.message
      }
    }

    await logStatusChange(id, reservation.status, 'checked_in', 'checkin', userId)

    return c.json({ data: updated, ttlock: ttlockResult, ttlockError, autoEnrolledFromReservationId })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/check-out — hacer check-out
const checkOutSchema = z.object({
  // Valoración nuestra del huésped (1-5), preguntada al recepcionista antes de
  // cerrar. Con 5★ se manda un email de agradecimiento + petición de reseña.
  guestRating: z.number().int().min(1).max(5).optional(),
}).optional()

app.post('/:id/check-out', zValidator('json', checkOutSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const body   = c.req.valid('json')
    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true },
    })
    if (!reservation) return notFound(c, 'Reserva')
    if (reservation.status !== 'checked_in' && reservation.status !== 'checking_out') {
      return conflict(c, `No se puede hacer check-out en estado '${reservation.status}'`)
    }

    // Bloquear check-out si queda algún depósito con dinero de por medio (efectivo
    // o preautorización CC) sin resolver — debe quedar cobrado o devuelto antes de
    // salir. 'deposit_card' (solo datos de tarjeta, sin importe) queda fuera: no
    // hay nada que cobrar ni devolver. Misma lógica de "devuelto" que en check-in.
    const depositTx = await db.select({ id: financialTransactions.id, category: financialTransactions.category, description: financialTransactions.description })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.reservationId, id),
        inArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
      ))
    const returnedIds = new Set(
      depositTx.filter(t => t.category === 'deposit_return' && t.description?.startsWith('dep:'))
        .map(t => Number(t.description!.slice(4)))
    )
    const hasUnresolvedDeposit = depositTx.some(t =>
      t.category !== 'deposit_return' && t.category !== 'deposit_cobrado' && t.category !== 'deposit_card' &&
      !returnedIds.has(t.id)
    )
    if (hasUnresolvedDeposit) {
      return conflict(c, 'Hay depósitos sin cobrar ni devolver — resuélvelos en la pestaña "Depósitos" antes del check-out')
    }

    const [updated] = await db.update(reservations)
      .set({
        status: 'checked_out',
        previousStatus: reservation.status,
        checkedOutAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    await logStatusChange(id, reservation.status, 'checked_out', 'checkout', userId)

    // Revocar tarjeta ZKTeco (best-effort). user_id en bridge_win = reservation ID.
    // Ya NO se borra zktecoCardNo/zktecoCardBe — se marca revocada (ver
    // schema), para poder reutilizarla en una reserva consecutiva del mismo
    // huésped en la misma habitación sin que la vuelva a pasar.
    if (reservation.zktecoCardNo && !reservation.zktecoCardRevokedAt) {
      if ((await hasFeature('zkteco')) && (await zktecoConfigured())) {
        revokeCard(String(id)).catch(e => console.error('[ZKTeco] revoke on checkout:', e))
      }
      await db.update(reservations)
        .set({ zktecoCardRevokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    }

    // Valoración del huésped (opcional) + agradecimiento por email si es 5★.
    // Best-effort: un fallo aquí no debe deshacer un check-out ya confirmado.
    if (body?.guestRating && reservation.guestId) {
      try {
        await db.update(guests).set({ guestRating: body.guestRating, updatedAt: new Date() }).where(and(eq(guests.id, reservation.guestId), eq(guests.propertyId, getPropertyId())))
        const g = reservation.guest as any
        if (body.guestRating === 5 && g?.email && !/@guest\.booking\.com$/i.test(g.email.trim())) {
          if (await channelEnabled('guest_thank_you', 'email', reservation.bookingChannelId)) {
            await sendThankYouEmail({ to: g.email, name: `${g.firstName} ${g.lastName}` })
          }
        }
      } catch (e) { console.error('[check-out] valoración/email de agradecimiento:', e) }
    }

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/cancel — cancelar reserva
app.post('/:id/cancel', async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    })
    if (!reservation) return notFound(c, 'Reserva')
    if (['checked_out', 'cancelled'].includes(reservation.status)) {
      return conflict(c, `No se puede cancelar una reserva en estado '${reservation.status}'`)
    }

    const body = await c.req.json().catch(() => ({})) as { changeReason?: string }

    // Recepción no puede cancelar una reserva con el huésped ya alojado
    // (checked_in) — eso requiere intervención de admin/dirección. Y para
    // cualquier cancelación de recepción se exige un motivo real de al
    // menos 10 palabras, que queda en el historial de la reserva.
    // Admin/dirección queda sin estas restricciones.
    if (!isAdmin(c)) {
      if (reservation.status === 'checked_in') {
        return conflict(c, 'No se puede cancelar una reserva con el huésped ya alojado (checked-in) — pide a admin/dirección que la cancele')
      }
      if (!hasMinWords(body.changeReason, 10)) {
        return c.json({ error: 'Para cancelar una reserva hace falta un motivo de al menos 10 palabras' }, 400)
      }
    }

    const [updated] = await db.update(reservations)
      .set({ status: 'cancelled', previousStatus: reservation.status, updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    if (hasMinWords(body.changeReason, 1)) {
      await db.insert(reservationNotes).values({
        reservationId: id,
        authorId:      userId,
        note:          `Motivo de la cancelación: ${body.changeReason}`,
        type:          'change',
      })
    }

    await logStatusChange(id, reservation.status, 'cancelled', 'cancel', userId)

    // Revocar tarjeta ZKTeco si la había (best-effort). user_id = reservation ID.
    // Igual que en checkout: se marca revocada, no se borra (ver schema).
    if (reservation.zktecoCardNo && !reservation.zktecoCardRevokedAt) {
      if ((await hasFeature('zkteco')) && (await zktecoConfigured())) {
        revokeCard(String(id)).catch(e => console.error('[ZKTeco] revoke on cancel:', e))
      }
      await db.update(reservations)
        .set({ zktecoCardRevokedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    }

    // Liberar disponibilidad en Nobeds (best-effort)
    if (reservation.roomId && (await hasFeature('nobeds')) && (await nobedsConfigured())) {
      db.query.rooms.findFirst({ where: and(eq(rooms.id, reservation.roomId), eq(rooms.propertyId, getPropertyId())), with: { roomType: { columns: { nobedsRoomId: true } } } })
        .then(r => { if (r?.roomType?.nobedsRoomId) unblockDates(r.roomType.nobedsRoomId, reservation.checkInDate, reservation.checkOutDate).catch(() => {}) })
        .catch(() => {})
    }

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/revert-checkin — revertir a checked_in (solo si no ha pasado la fecha de check-out)
app.post('/:id/revert-checkin', async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    })
    if (!reservation) return notFound(c, 'Reserva')

    const revertible = ['checked_out', 'no_show', 'cancelled']
    if (!revertible.includes(reservation.status)) {
      return conflict(c, `No se puede revertir una reserva en estado '${reservation.status}'`)
    }

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
    if (reservation.checkOutDate < today) {
      return conflict(c, 'No se puede revertir: la fecha de check-out ya ha pasado')
    }

    const [updated] = await db.update(reservations)
      .set({
        status: 'checked_in',
        previousStatus: reservation.status,
        checkedOutAt: null as any,
        updatedAt: new Date(),
      })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning()

    await logStatusChange(id, reservation.status, 'checked_in', 'revert', userId)

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/reservations/:id/checkin-abandon — registrar abandono de proceso de check-in
app.post('/:id/checkin-abandon', async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    if (!(await ownReservation(id))) return notFound(c, 'Reserva')
    await db.update(reservations)
      .set({ checkinAbandonedAt: new Date(), checkinAbandonedBy: userId, updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/checkin-email — enlace de check-in online por email
app.post('/:id/checkin-email', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true },
    })
    if (!res) return notFound(c, 'Reserva')
    const g = res.guest as any
    if (!g?.email) return c.json({ error: 'El huésped no tiene email registrado' }, 422)
    if (!await channelEnabled('checkin_link', 'email', res.bookingChannelId)) {
      return c.json({ error: 'Deshabilitado para este mensaje o canal de venta (Ajustes → Mensajes)' }, 422)
    }

    const url = await portalLink(g.email)
    await sendCheckinLinkEmail({
      to: g.email, name: `${g.firstName} ${g.lastName}`,
      checkIn: res.checkInDate, checkOut: res.checkOutDate, resId: id, portalUrl: url,
    })
    return c.json({ data: { sent: true } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/payment-email — recordatorio de saldo pendiente por email
app.post('/:id/payment-email', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, bookingChannel: true },
    })
    if (!res) return notFound(c, 'Reserva')
    const g = res.guest as any
    if (!g?.email) return c.json({ error: 'El huésped no tiene email registrado' }, 422)

    // No cuenta los depósitos retenidos sin cobrar como pago de la estancia
    // (ver src/lib/paymentAggregate.ts) — si no, el recordatorio al huésped
    // podría ocultar saldo real pendiente.
    const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const due = calcPendingBalance(res.total, realPaid)
    if (due <= 0.01) return c.json({ error: 'La reserva no tiene saldo pendiente' }, 422)
    if ((res.bookingChannel?.name ?? '').toLowerCase().includes('booking')) {
      return c.json({ error: 'Reserva de Booking: el pago puede haberse hecho por el canal — no se envían recordatorios de pago' }, 422)
    }
    if (!await channelEnabled('payment_reminder', 'email', res.bookingChannelId)) {
      return c.json({ error: 'Deshabilitado para este mensaje o canal de venta (Ajustes → Mensajes)' }, 422)
    }

    const url = await portalLink(g.email)
    await sendPaymentReminderEmail({
      to: g.email, name: `${g.firstName} ${g.lastName}`,
      due: due.toFixed(2), resId: id, portalUrl: url,
    })
    return c.json({ data: { sent: true, due } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/send-confirmation — envía confirmación de reserva al huésped (acción manual del staff)
app.post('/:id/send-confirmation', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true, rate: true },
    })
    if (!res)      return notFound(c, 'Reserva')
    const g = res.guest as any
    if (!g?.email) return c.json({ error: 'El huésped no tiene email registrado' }, 422)
    if (!await channelEnabled('booking_confirmation', 'email', res.bookingChannelId)) {
      return c.json({ error: 'Deshabilitado para este mensaje o canal de venta (Ajustes → Mensajes)' }, 422)
    }
    const portalUrl = await portalLink(g.email)
    const realPaidConfirm = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const balance = calcPendingBalance(res.total, realPaidConfirm).toFixed(2)
    await sendBookingConfirmationEmail({
      to:       g.email,
      name:     `${g.firstName} ${g.lastName}`,
      checkIn:  res.checkInDate,
      checkOut: res.checkOutDate,
      room:     (res.room as any)?.code ?? 'Por asignar',
      total:    String(res.total),
      balance,
      resId:    id,
      portalUrl,
    })
    return c.json({ data: { sent: true, to: g.email } })
  } catch (err) { return serverError(c, err) }
})

// GET /api/reservations/:id/confirmation-print — HTML de confirmación listo para imprimir / guardar PDF
app.get('/:id/confirmation-print', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: { with: { roomType: { columns: { name: true } } } }, rate: true, bookingChannel: true },
    })
    if (!res) return notFound(c, 'Reserva')
    const g      = res.guest as any
    const room   = res.room  as any
    const rate   = res.rate  as any
    const ch     = (res as any).bookingChannel as any
    const total  = parseFloat(String(res.total))
    const paid   = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const balance = calcPendingBalance(res.total, paid)
    const brand = await getBranding()
    const cur   = currencySymbol(brand.currencyCode)
    const esc   = (t: string) => t.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!))
    const brandContact = [brand.fullAddress, [brand.receptionEmail, brand.websiteUrl].filter(Boolean).join(' · ')].filter(Boolean).map(esc).join('<br>')

    const fmt = (d: string) => {
      const [y, m, day] = d.split('-')
      return `${day}/${m}/${y}`
    }
    const today = fmt(new Intl.DateTimeFormat('en-CA', { timeZone: brand.timezone }).format(new Date()))

    const row = (label: string, value: string) =>
      `<tr><td>${label}</td><td>${value}</td></tr>`

    const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Confirmación #${id} — ${esc(brand.name)}</title>
<style>
  @page { size: A4; margin: 20mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, sans-serif; color: #111; font-size: 13px; line-height: 1.6; margin: 0; padding: 20px; }
  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 16px; border-bottom: 2px solid #0f172a; margin-bottom: 20px; }
  .hotel-name { font-size: 22px; font-weight: 700; color: #0f172a; }
  .hotel-sub { color: #555; font-size: 11px; margin-top: 4px; line-height: 1.5; }
  .doc-title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .5px; text-align: right; }
  .doc-num { font-size: 20px; font-weight: 700; color: #0f172a; text-align: right; }
  .doc-date { font-size: 11px; color: #888; text-align: right; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #555; margin: 18px 0 6px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 4px 0; vertical-align: top; }
  td:first-child { color: #555; width: 150px; font-size: 12px; }
  td:last-child { font-weight: 600; }
  .totals tr:last-child td { border-top: 1px solid #e5e7eb; padding-top: 6px; }
  .badge-paid { color: #166534; background: #dcfce7; padding: 1px 8px; border-radius: 4px; font-size: 11px; }
  .badge-pending { color: #92400e; background: #fef3c7; padding: 1px 8px; border-radius: 4px; font-size: 11px; }
  .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e5e7eb; text-align: center; font-size: 11px; color: #888; }
  .no-print { position: fixed; top: 12px; right: 12px; display: flex; gap: 8px; }
  .btn { padding: 8px 16px; border: none; border-radius: 6px; font-size: 13px; cursor: pointer; }
  @media print { .no-print { display: none !important; } body { padding: 0; } }
</style>
</head>
<body>
<div class="no-print">
  <button class="btn" style="background:#0f172a;color:#fff" onclick="window.print()">Imprimir / PDF</button>
  <button class="btn" style="background:#e5e7eb;color:#111" onclick="window.close()">Cerrar</button>
</div>

<div class="header">
  <div>
    <div class="hotel-name">${esc(brand.name)}</div>
    <div class="hotel-sub">${brandContact}</div>
  </div>
  <div>
    <div class="doc-title">Confirmación de reserva</div>
    <div class="doc-num">#${id}</div>
    <div class="doc-date">Emitida el ${today}</div>
  </div>
</div>

<h2>Huésped</h2>
<table>
  ${row('Nombre', `${g?.firstName ?? ''} ${g?.lastName ?? ''}`.trim() || '—')}
  ${g?.email ? row('Email', g.email) : ''}
  ${g?.phone ? row('Teléfono', g.phone) : ''}
</table>

<h2>Detalles de la estancia</h2>
<table>
  ${room?.code ? row('Habitación', `${room.code}${room.roomType?.name ? ' — ' + room.roomType.name : ''}`) : ''}
  ${row('Entrada', fmt(res.checkInDate))}
  ${row('Salida', fmt(res.checkOutDate))}
  ${row('Noches', String(res.nights))}
  ${row('Personas', String(res.people))}
  ${rate?.title ? row('Tarifa', rate.title) : ''}
  ${ch?.name ? row('Canal', ch.name) : ''}
  ${res.externalCode ? row('Referencia', res.externalCode) : ''}
</table>

<h2>Resumen de pago</h2>
<table class="totals">
  ${row('Total', total.toFixed(2) + ' ' + cur)}
  ${row('Pagado', paid.toFixed(2) + ' ' + cur)}
  <tr><td>Pendiente</td><td>${balance > 0.01
    ? `<span class="badge-pending">${balance.toFixed(2)} ${cur}</span>`
    : '<span class="badge-paid">Pagado</span>'}</td></tr>
</table>

<div class="footer">
  ${esc(brand.name)}${brandContact ? ' · ' + brandContact.replace(/<br>/g, ' · ') : ''}<br>
  Este documento es una confirmación de la reserva. Por favor, preséntelo a su llegada.
</div>
</body>
</html>`

    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/split — parte la estancia en una fecha de corte,
// truncando la reserva actual y creando una reserva-continuación en otra habitación
// (mismo huésped, fechas y precio se reparten proporcionalmente por noches)
const splitSchema = z.object({
  splitDate:  z.string().date(),
  newRoomId:  z.number().int().positive(),
})
app.post('/:id/split', zValidator('json', splitSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const { splitDate, newRoomId } = c.req.valid('json')

    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { room: true },
    })
    if (!res) return notFound(c, 'Reserva')
    if (res.status !== 'checked_in') {
      return c.json({ error: 'Solo se puede partir una reserva con check-in ya realizado' }, 422)
    }
    if (!res.roomId) return c.json({ error: 'La reserva no tiene habitación asignada' }, 422)
    if ((res.extraRoomIds ?? []).length > 0) {
      return c.json({ error: 'No se puede partir una reserva con habitaciones adicionales' }, 422)
    }
    if (newRoomId === res.roomId) return c.json({ error: 'Selecciona una habitación distinta a la actual' }, 422)
    if (splitDate <= res.checkInDate || splitDate >= res.checkOutDate) {
      return c.json({ error: 'La fecha de corte debe estar entre el check-in y el check-out' }, 422)
    }

    const newRoom = await db.query.rooms.findFirst({ where: and(eq(rooms.id, newRoomId), eq(rooms.propertyId, getPropertyId())) })
    if (!newRoom || !newRoom.active) return c.json({ error: 'Habitación no válida' }, 422)

    // Disponibilidad de la habitación destino para el tramo [splitDate, checkOutDate)
    const conflict = await db.query.reservations.findFirst({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        ne(reservations.id, id),
        ne(reservations.status, 'cancelled'),
        lt(reservations.checkInDate, res.checkOutDate),
        gt(reservations.checkOutDate, splitDate),
        or(
          eq(reservations.roomId, newRoomId),
          sql`${reservations.extraRoomIds} @> ${JSON.stringify([newRoomId])}::jsonb`,
        ),
      ),
    })
    if (conflict) return c.json({ error: 'La habitación destino ya está ocupada en esas fechas' }, 409)

    const tailDates: string[] = []
    for (let d = new Date(splitDate); d < new Date(res.checkOutDate); d.setDate(d.getDate() + 1)) {
      tailDates.push(d.toISOString().slice(0, 10))
    }
    if (tailDates.length > 0) {
      const blocked = await db.query.blockedBeds.findFirst({
        where: and(eq(blockedBeds.propertyId, getPropertyId()), eq(blockedBeds.roomId, newRoomId), inArray(blockedBeds.blockDate, tailDates)),
      })
      if (blocked) return c.json({ error: 'La habitación destino tiene camas bloqueadas en esas fechas' }, 409)
    }

    // Reparto proporcional por noches (no hay precio fiable por noche que prorratear)
    const totalNights  = res.nights
    const beforeNights = Math.round((new Date(splitDate).getTime() - new Date(res.checkInDate).getTime()) / 86400000)
    const afterNights  = totalNights - beforeNights
    const ratio        = beforeNights / totalNights

    const total       = parseFloat(res.total)
    const commission  = parseFloat(res.bmCommission)
    const originalTotal      = Math.round(total * ratio * 100) / 100
    const originalCommission = Math.round(commission * ratio * 100) / 100
    const tailTotal      = Math.round((total - originalTotal) * 100) / 100
    const tailCommission = Math.round((commission - originalCommission) * 100) / 100

    // Pagos reales (sin depósitos aún sin cobrar — ver src/lib/paymentAggregate.ts)
    // repartidos con el mismo criterio que el total: si no se mueven, la
    // reserva partida (el tramo que sigue) queda sin ningún pago registrado
    // y el saldo pendiente calculado a partir de financial_transactions (lo
    // que usa ya toda la app) la marca como totalmente impagada, aunque el
    // huésped ya hubiera pagado parte o todo por adelantado.
    const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const originalRealPaidTarget = Math.round(realPaid * ratio * 100) / 100
    const tailRealPaidTarget     = Math.round((realPaid - originalRealPaidTarget) * 100) / 100

    // Cuenta/caja donde reflejar la transferencia interna: la del cobro real
    // más reciente de la reserva (si hay algo que mover, tiene que haber
    // habido al menos uno).
    const lastRealTx = tailRealPaidTarget > 0
      ? await db.query.financialTransactions.findFirst({
          where: and(
            eq(financialTransactions.reservationId, id),
            sql`${financialTransactions.paymentMethod} NOT IN ('deposit', 'deposit_cc')`,
          ),
          orderBy: desc(financialTransactions.id),
        })
      : null

    // Depósitos aún ABIERTOS (ni cobrados ni ya devueltos) de la reserva
    // original — se "devuelven" ahí y se vuelven a registrar en el tramo
    // partido, que es el que de verdad va a hacer check-out. Los ya
    // cobrados (su importe ya forma parte de realPaid, repartido arriba
    // junto al resto de pagos) o ya devueltos se quedan tal cual, son
    // historial cerrado que no afecta a la reserva que sigue.
    const allDepositTx = await db.query.financialTransactions.findMany({
      where: and(
        eq(financialTransactions.reservationId, id),
        inArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
      ),
    })
    const returnedDepositIds = new Set(
      allDepositTx.filter(t => t.category === 'deposit_return' && t.description?.startsWith('dep:'))
        .map(t => Number(t.description!.slice(4))),
    )
    const openDeposits = allDepositTx.filter(t =>
      t.category !== 'deposit_return' && t.category !== 'deposit_cobrado' && !returnedDepositIds.has(t.id),
    )

    const [created] = await db.transaction(async (tx) => {
      const [tail] = await tx.insert(reservations).values({
        propertyId:       res.propertyId,
        guestId:          res.guestId,
        status:           res.status,
        checkInDate:      splitDate,
        checkOutDate:     res.checkOutDate,
        nights:           afterNights,
        people:           res.people,
        bookingChannelId: res.bookingChannelId,
        operatorId:       res.operatorId,
        rateId:           res.rateId,
        roomId:           newRoomId,
        currencyId:       res.currencyId,
        total:            tailTotal.toFixed(2),
        amountPaid:       '0',
        bmCommission:     tailCommission.toFixed(2),
        groupName:        res.groupName,
        source:           res.source,
        createdBy:        res.createdBy,
        externalCode:     res.externalCode,
        splitFromReservationId: id,
      } as any).returning()

      // Nota de auditoría: de dónde viene esta reserva y cuál era el precio
      // total antes de partirla (después del reparto proporcional, ni el
      // tramo original ni este muestran ya ese total completo).
      await tx.insert(reservationNotes).values({
        reservationId: tail!.id,
        authorId:      userId,
        note:          `Reserva partida de la original #${id} — precio total original: ${total.toFixed(2)}${currencySymbol((await getBranding()).currencyCode)}`,
        type:          'change',
      })

      await tx.update(reservations).set({
        checkOutDate:  splitDate,
        nights:        beforeNights,
        total:         originalTotal.toFixed(2),
        bmCommission:  originalCommission.toFixed(2),
        splitToReservationId: tail!.id,
        ttlockCode:    null,
        ttlockCodeId:  null,
        ttlockSentAt:  null,
        updatedAt:     new Date(),
      } as any).where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

      // Traspasar (transferencia interna, neta cero el mismo día — no
      // representa dinero nuevo) la parte de los pagos reales que le toca al
      // tramo partido, para que su saldo pendiente calculado a partir de
      // financial_transactions sea correcto.
      if (tailRealPaidTarget > 0 && lastRealTx) {
        const transferDate = await todayLocal()
        await tx.insert(financialTransactions).values([
          {
            propertyId:         res.propertyId,
            reservationId:      id,
            financialAccountId: lastRealTx.financialAccountId,
            amount:             (-tailRealPaidTarget).toFixed(2),
            currencyId:         lastRealTx.currencyId,
            paymentMethod:      'split_transfer',
            category:           'split_transfer',
            description:        `Transferido a la reserva partida #${tail!.id}`,
            transactionDate:    transferDate,
            createdBy:          userId,
          },
          {
            propertyId:         res.propertyId,
            reservationId:      tail!.id,
            financialAccountId: lastRealTx.financialAccountId,
            amount:             tailRealPaidTarget.toFixed(2),
            currencyId:         lastRealTx.currencyId,
            paymentMethod:      'split_transfer',
            category:           'split_transfer',
            description:        `Transferido desde la reserva original #${id}`,
            transactionDate:    transferDate,
            createdBy:          userId,
          },
        ] as any)
      }

      // Depósitos abiertos → se marcan devueltos en el tramo original (igual
      // convención que "Marcar devuelto" en la pestaña Depósitos: fila nueva
      // category='deposit_return', description=`dep:<id original>`, importe
      // en negativo) y se vuelven a registrar en el tramo partido, que es el
      // que de verdad va a hacer check-out — si no, el aviso de "depósito sin
      // resolver" al check-out no los detectaría, porque ya no estarían en
      // la reserva que sale.
      for (const d of openDeposits) {
        await tx.insert(financialTransactions).values({
          propertyId:         res.propertyId,
          reservationId:      id,
          financialAccountId: d.financialAccountId,
          amount:             (-parseFloat(String(d.amount))).toFixed(2),
          currencyId:         d.currencyId,
          paymentMethod:      d.paymentMethod,
          category:           'deposit_return',
          description:        `dep:${d.id}`,
          transactionDate:    await todayLocal(),
          createdBy:          userId,
        } as any)
        await tx.insert(financialTransactions).values({
          propertyId:         res.propertyId,
          reservationId:      tail!.id,
          financialAccountId: d.financialAccountId,
          amount:             d.amount,
          currencyId:         d.currencyId,
          paymentMethod:      d.paymentMethod,
          category:           d.category,
          description:        `Trasladado de la reserva original #${id} al partir (dep original #${d.id})`,
          transactionDate:    await todayLocal(),
          createdBy:          userId,
        } as any)
      }

      // Recalcular amountPaid de ambos tramos a partir de sus
      // financial_transactions reales, ya movidas/repartidas.
      for (const resId of [id, tail!.id]) {
        const [agg] = await tx.select({ total: sql<string>`coalesce(sum(amount),0)` })
          .from(financialTransactions)
          .where(eq(financialTransactions.reservationId, resId))
        await tx.update(reservations).set({ amountPaid: agg!.total }).where(and(eq(reservations.id, resId), eq(reservations.propertyId, getPropertyId())))
      }

      // Huéspedes adicionales cuyas noches caen en el tramo movido
      await tx.update(reservationNights).set({
        reservationId: tail!.id,
        roomId:        newRoomId,
      }).where(and(eq(reservationNights.reservationId, id), gte(reservationNights.date, splitDate)))

      return [tail]
    })

    // Revocar código TTLock existente (accesorio: puede fallar si no hay gateway configurado)
    if (res.ttlockCodeId && (res.room as any)?.ttlockId) {
      try { await deletePasscode((res.room as any).ttlockId, res.ttlockCodeId) }
      catch (err) { console.warn('[reservations/split] no se pudo revocar el código TTLock', id, err) }
    }

    // Recargar ambos tramos — el amountPaid final se recalcula DENTRO de la
    // transacción (tras mover los pagos reales), así que `created` en este
    // punto todavía llevaría el amountPaid '0' provisional con el que se creó.
    const [updated, createdFresh] = await Promise.all([
      db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) }),
      db.query.reservations.findFirst({ where: and(eq(reservations.id, created!.id), eq(reservations.propertyId, getPropertyId())) }),
    ])
    return c.json({ data: { original: updated, created: createdFresh } }, 201)
  } catch (err) { return serverError(c, err) }
})

// GET /api/reservations/:id/guests — huéspedes adicionales (excluye titular)
app.get('/:id/guests', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      columns: { guestId: true },
      with: { nightRows: { with: { guest: true, room: { columns: { code: true } } } } },
    })
    if (!res) return notFound(c, 'Reserva')

    const seen = new Set<number>()
    if (res.guestId) seen.add(res.guestId)
    const additional: any[] = []
    for (const night of res.nightRows ?? []) {
      if (night.guest && !seen.has(night.guest.id)) {
        seen.add(night.guest.id)
        // roomId/roomCode de este huésped dentro del grupo — se toma de su
        // primera noche (todas sus noches comparten habitación salvo que se
        // reasigne con PATCH .../guests/:guestId/room, que las actualiza todas).
        additional.push({ ...night.guest, roomId: night.roomId, roomCode: (night.room as any)?.code ?? null })
      }
    }
    return c.json({ data: additional })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/guests — añadir huésped adicional
const addGuestSchema = z.object({
  guestId:            z.number().int().positive().optional(),
  firstName:          z.string().min(1).optional(),
  lastName:           z.string().min(1).optional(),
  secondLastName:     z.string().optional(),
  gender:             z.enum(['male', 'female', 'non_binary', 'unspecified']).optional(),
  dateOfBirth:        z.string().date().optional(),
  nationality:        z.string().optional(),
  phone:              z.string().optional(),
  email:              z.string().email().optional().or(z.literal('')),
  idDocType:          z.enum(['dni', 'nie', 'passport', 'driving_licence', 'other']).optional(),
  idDocNumber:        z.string().optional(),
  idDocSupportNumber: z.string().optional(),
  idDocIssueDate:     z.string().date().optional(),
  idDocExpiryDate:    z.string().date().optional(),
  address1:           z.string().optional(),
  zipCode:            z.string().optional(),
  city:               z.string().optional(),
  cityIneCode:        z.string().optional(),
  addressCountryCode: z.string().optional(),
  // Solo tiene sentido en reservas de grupo (extra_room_ids no vacío): en qué
  // habitación concreta del grupo duerme este huésped. Si no se manda, cae en
  // la habitación principal (comportamiento de siempre).
  roomId:             z.number().int().positive().optional(),
})
app.post('/:id/guests', zValidator('json', addGuestSchema), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')

    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { room: true },
    })
    if (!reservation) return notFound(c, 'Reserva')

    // La habitación elegida tiene que ser una de las del grupo (principal o
    // extra) — no cualquier habitación del hotel.
    const groupRoomIds = [reservation.roomId, ...((reservation.extraRoomIds as number[] | null) ?? [])].filter((x): x is number => x != null)
    if (body.roomId != null && !groupRoomIds.includes(body.roomId)) {
      return c.json({ error: 'Esa habitación no pertenece a esta reserva' }, 400)
    }

    // Crear o usar huésped existente
    let guestId = body.guestId
    if (!guestId) {
      if (!body.firstName || !body.lastName) {
        return c.json({ error: 'Se requiere guestId o firstName + lastName' }, 400)
      }
      const { guestId: _omit, ...guestFields } = body
      const cleanFields = Object.fromEntries(
        Object.entries(guestFields).filter(([, v]) => v !== undefined && v !== '')
      )
      const inserted = await db.insert(guests)
        .values({ ...(cleanFields as any), propertyId: getPropertyId() })
        .returning({ id: guests.id })
      guestId = inserted[0]!.id
    }

    // El huésped existente debe ser del tenant
    if (!(await db.query.guests.findFirst({ where: and(eq(guests.id, guestId), eq(guests.propertyId, getPropertyId())), columns: { id: true } }))) return notFound(c, 'Huésped')

    // Verificar que no está ya vinculado a esta reserva
    const existing = await db.query.reservationNights.findFirst({
      where: and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)),
    })
    if (existing) return conflict(c, 'El huésped ya está en esta reserva')

    // Habitación de este huésped dentro del grupo: la elegida, o la principal
    // por defecto (mismo comportamiento de siempre si no se manda roomId).
    const targetRoomId = body.roomId ?? reservation.roomId
    const targetRoom = body.roomId != null && body.roomId !== reservation.roomId
      ? await db.query.rooms.findFirst({ where: and(eq(rooms.id, body.roomId), eq(rooms.propertyId, getPropertyId())), columns: { roomTypeId: true } })
      : (reservation.room as any)
    if (!targetRoom?.roomTypeId) return c.json({ error: 'La habitación no tiene tipo configurado' }, 400)

    // Insertar una fila por noche
    const currencyId = await tenantCurrencyId()
    const checkIn  = new Date(reservation.checkInDate)
    const checkOut = new Date(reservation.checkOutDate)
    const rows = []
    for (let d = new Date(checkIn); d < checkOut; d.setDate(d.getDate() + 1)) {
      rows.push({
        reservationId: id,
        date:          d.toISOString().slice(0, 10),
        guestId:       guestId!,
        roomId:        targetRoomId,
        roomTypeId:    targetRoom.roomTypeId,
        price:         '0',
        commission:    '0',
        currencyId,
        isOriginal:    false,
      })
    }
    await db.insert(reservationNights).values(rows as any)

    await db.execute(sql`
      UPDATE reservations
      SET people = (
        SELECT COUNT(DISTINCT guest_id)::int
        FROM reservation_nights
        WHERE reservation_id = ${id}
      ) + 1
      WHERE id = ${id} AND property_id = ${getPropertyId()}
    `)

    const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, guestId!), eq(guests.propertyId, getPropertyId())) })
    return c.json({ data: guest }, 201)
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/reservations/:id/guests/:guestId — quitar huésped adicional
app.delete('/:id/guests/:guestId', async (c) => {
  try {
    const id      = Number(c.req.param('id'))
    const guestId = Number(c.req.param('guestId'))

    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      columns: { guestId: true, lockedRoomIds: true },
    })
    if (!reservation) return notFound(c, 'Reserva')
    if (reservation.guestId === guestId) {
      return c.json({ error: 'No se puede quitar al huésped titular' }, 400)
    }

    const guestNight = await db.query.reservationNights.findFirst({
      where: and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)),
      columns: { roomId: true },
    })
    if (guestNight?.roomId != null && ((reservation.lockedRoomIds as number[] | null) ?? []).includes(guestNight.roomId)) {
      return c.json({ error: 'Esa habitación está cerrada — no se puede quitar a este huésped' }, 403)
    }

    await db.delete(reservationNights)
      .where(and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)))

    await db.execute(sql`
      UPDATE reservations
      SET people = GREATEST(1, (
        SELECT COUNT(DISTINCT guest_id)::int
        FROM reservation_nights
        WHERE reservation_id = ${id}
      ) + 1)
      WHERE id = ${id} AND property_id = ${getPropertyId()}
    `)

    return c.json({ data: { deleted: true } })
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/reservations/:id/guests/:guestId/room — mover a un huésped
// adicional a otra habitación DEL MISMO GRUPO (principal o una de las
// extra_room_ids) — para colocar a cada uno en su habitación concreta en
// reservas de grupo. Actualiza TODAS sus noches en esta reserva.
app.patch('/:id/guests/:guestId/room', zValidator('json', z.object({
  roomId: z.number().int().positive(),
})), async (c) => {
  try {
    const id      = Number(c.req.param('id'))
    const guestId = Number(c.req.param('guestId'))
    const { roomId } = c.req.valid('json')

    const reservation = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!reservation) return notFound(c, 'Reserva')
    if (reservation.guestId === guestId) {
      return c.json({ error: 'El titular ocupa siempre la habitación principal — usa "Cambiar titular" o mueve la reserva entera' }, 400)
    }

    const groupRoomIds = [reservation.roomId, ...((reservation.extraRoomIds as number[] | null) ?? [])].filter((x): x is number => x != null)
    if (!groupRoomIds.includes(roomId)) return c.json({ error: 'Esa habitación no pertenece a esta reserva' }, 400)
    if (((reservation.lockedRoomIds as number[] | null) ?? []).includes(roomId)) {
      return c.json({ error: 'Esa habitación está marcada como cerrada — no se pueden mover huéspedes a ella' }, 403)
    }

    const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, roomId), eq(rooms.propertyId, getPropertyId())), columns: { code: true, roomTypeId: true } })
    if (!room?.roomTypeId) return c.json({ error: 'La habitación no tiene tipo configurado' }, 400)

    const nights = await db.query.reservationNights.findFirst({
      where: and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)),
      with: { room: { columns: { code: true } } },
    })
    if (!nights) return notFound(c, 'Huésped en esta reserva')
    const oldRoomCode = (nights.room as any)?.code ?? '—'
    if (nights.roomId === roomId) return c.json({ data: { moved: false } })

    await db.update(reservationNights)
      .set({ roomId, roomTypeId: room.roomTypeId })
      .where(and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)))

    const g = await db.query.guests.findFirst({ where: and(eq(guests.id, guestId), eq(guests.propertyId, getPropertyId())), columns: { firstName: true, lastName: true } })
    const userId = getUserId(c)
    await db.insert(reservationNotes).values({
      reservationId: id, authorId: userId,
      note: `🛏 ${g?.firstName ?? ''} ${g?.lastName ?? ''} movido de hab. ${oldRoomCode} → ${room.code} (dentro del grupo)`.trim(),
      type: 'change',
    })

    return c.json({ data: { moved: true, roomCode: room.code } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/change-primary-guest — cambiar huésped titular
// Acepta guestId (existente) o los datos para crear uno nuevo, igual que
// POST /:id/guests (huésped adicional). El titular anterior NO se borra ni se
// desvincula por su cuenta — si ya tenía filas propias en reservation_nights
// (p.ej. porque hizo el check-in), sigue aaí y a partir de ahora aparecerá
// como huésped adicional (guestId != reservations.guestId es justo el
// criterio que ya usa GET /:id/additional-guests). Queda constancia del
// cambio como nota, con el titular anterior.
app.post('/:id/change-primary-guest', zValidator('json', addGuestSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const body   = c.req.valid('json')
    const userId = getUserId(c)

    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: { columns: { id: true, firstName: true, lastName: true } } },
    })
    if (!reservation) return notFound(c, 'Reserva')

    let guestId = body.guestId
    if (!guestId) {
      if (!body.firstName || !body.lastName) {
        return c.json({ error: 'Se requiere guestId o firstName + lastName' }, 400)
      }
      const { guestId: _omit, ...guestFields } = body
      const cleanFields = Object.fromEntries(
        Object.entries(guestFields).filter(([, v]) => v !== undefined && v !== '')
      )
      const inserted = await db.insert(guests)
        .values({ ...(cleanFields as any), propertyId: getPropertyId() })
        .returning({ id: guests.id })
      guestId = inserted[0]!.id
    }

    if (guestId === reservation.guestId) {
      return c.json({ error: 'Ese huésped ya es el titular de la reserva' }, 400)
    }

    const newGuest = await db.query.guests.findFirst({
      where: and(eq(guests.id, guestId), eq(guests.propertyId, getPropertyId())), columns: { id: true, firstName: true, lastName: true },
    })
    if (!newGuest) return notFound(c, 'Huésped')

    const oldGuest = reservation.guest as { id: number; firstName: string; lastName: string } | null

    await db.update(reservations).set({ guestId, updatedAt: new Date() }).where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    await db.insert(reservationNotes).values({
      reservationId: id,
      authorId:      userId,
      note: `🔄 Huésped titular cambiado: ${oldGuest ? `${oldGuest.firstName} ${oldGuest.lastName}` : 'sin titular'} → ${newGuest.firstName} ${newGuest.lastName}`,
      type: 'change',
    })

    return c.json({ data: newGuest })
  } catch (err) { return serverError(c, err) }
})

// POST /api/reservations/:id/notes — añadir nota
app.post('/:id/notes', zValidator('json', z.object({
  note: z.string().min(1),
  popupAt: z.string().datetime().optional(),
})), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const { note, popupAt } = c.req.valid('json')
    if (!(await ownReservation(id))) return notFound(c, 'Reserva')
    const [created] = await db.insert(reservationNotes).values({
      reservationId: id,
      note,
      popupAt: popupAt ? new Date(popupAt) : undefined,
    }).returning()
    return c.json({ data: created }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── DELETE /api/reservations/:id — borrado total (solo dirección) ────────────

app.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    if (!id) return notFound(c)

    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)

    const existing = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!existing) return notFound(c)

    await db.transaction(async (tx) => {
      await tx.delete(reservationNights).where(eq(reservationNights.reservationId, id))
      await tx.delete(reservationNotes).where(eq(reservationNotes.reservationId, id))
      await tx.delete(reservationSaleItems).where(eq(reservationSaleItems.reservationId, id))
      await tx.delete(financialTransactions).where(eq(financialTransactions.reservationId, id))
      await tx.delete(invoices).where(eq(invoices.reservationId, id))
      await tx.delete(guestContracts).where(eq(guestContracts.reservationId, id))
      await tx.delete(reservations).where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    })

    return c.json({ ok: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── POST /:id/contract — generar enlace de firma del contrato ────────────────

app.post('/:id/contract', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!res) return notFound(c, 'Reserva no encontrada')

    // Invalidar enlaces pendientes anteriores de esta reserva
    await db.update(guestContracts)
      .set({ status: 'cancelled' })
      .where(and(eq(guestContracts.propertyId, getPropertyId()), eq(guestContracts.reservationId, id), eq(guestContracts.status, 'pending')))

    const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
    const [contract] = await db.insert(guestContracts).values({
      propertyId:    res.propertyId,
      reservationId: id,
      guestId:       res.guestId,
      token,
      expiresAt:     new Date(Date.now() + 24 * 60 * 60 * 1000),
      createdBy:     getUserId(c),
    }).returning({ id: guestContracts.id })

    const url = `${process.env.PUBLIC_URL ?? ''}/sign?t=${token}`
    const qr  = await QRCode.toDataURL(url, { width: 260, margin: 1 })
    return c.json({ data: { id: contract!.id, url, qr } })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /:id/contracts — listado de contratos de la reserva ──────────────────

app.get('/:id/contracts', async (c) => {
  try {
    const id = parseInt(c.req.param('id'))
    const list = await db.select({
      id:        guestContracts.id,
      status:    guestContracts.status,
      signedAt:  guestContracts.signedAt,
      createdAt: guestContracts.createdAt,
    }).from(guestContracts)
      .where(and(eq(guestContracts.propertyId, getPropertyId()), eq(guestContracts.reservationId, id)))
      .orderBy(desc(guestContracts.id))
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /:id/contracts/:cid/html — ver contrato firmado ──────────────────────

app.get('/:id/contracts/:cid/html', async (c) => {
  try {
    const id  = parseInt(c.req.param('id'))
    const cid = parseInt(c.req.param('cid'))
    const contract = await db.query.guestContracts.findFirst({
      where: and(eq(guestContracts.id, cid), eq(guestContracts.reservationId, id), eq(guestContracts.propertyId, getPropertyId())),
    })
    if (!contract?.contractHtml) return notFound(c, 'Contrato no encontrado o sin firmar')
    return c.html(contract.contractHtml)
  } catch (err) { return serverError(c, err) }
})

// ─── POST /:id/checkin-start — registrar inicio del proceso de check-in ──────

app.post('/:id/checkin-start', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const reservation = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!reservation) return notFound(c, 'Reserva')
    if (reservation.checkinStartedAt) return c.json({ data: { ok: true } })
    await db.update(reservations)
      .set({ checkinStartedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

export default app
