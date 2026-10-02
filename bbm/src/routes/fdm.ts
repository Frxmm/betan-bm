import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { rates, rateDailyPrices, roomTypes, rooms, blockedBeds, fdmPushState } from '../db/schema'
import { eq, and, gte, lte, ilike, inArray, sql } from 'drizzle-orm'
import { isAdmin, canUseFdm } from '../middleware/auth'
import { getPropertyId, getBranding, hasFeature } from '../lib/property'
import { serverError } from '../lib/errors'
import { isConfigured, pushPricesToFdm, getToken, getFdmConfig, type PushEntry } from '../lib/fdm-push'
import { resolvePrice, rateChainIds, type RateForPricing, type RoomTypeForPricing, type DailyPriceRow } from '../lib/price-resolver'
import { guests, reservations, bookingChannels, financialTransactions, financialAccounts, invoices, currencies } from '../db/schema'
import { logStatusChange } from '../lib/statusLog'
import { sendBookingConfirmationEmail } from '../lib/email'
import { channelEnabled, portalLink } from '../lib/messaging'
import { sendWhatsappTemplate, isWhatsappConfigured } from '../lib/whatsapp'

// Mapas de cuentas FDM → cuentas/métodos locales: por tenant en settings fdm.accountMap (ver getFdmConfig)

const MOVIMIENTO_CAJA_CATEGORIES = new Set(['-10', '-14'])
const _movimientoCajaId = new Map<number, number>()   // por tenant
async function getMovimientoCajaId(): Promise<number> {
  const pid = getPropertyId()
  const cached = _movimientoCajaId.get(pid)
  if (cached) return cached
  const existing = await db.query.financialAccounts.findFirst({
    where: and(eq(financialAccounts.name, 'Movimiento de caja'), eq(financialAccounts.propertyId, pid)),
  })
  if (existing) { _movimientoCajaId.set(pid, existing.id); return existing.id }
  await db.execute(sql`SELECT setval('financial_accounts_id_seq', (SELECT MAX(id) FROM financial_accounts), true)`)
  const [row] = await db.insert(financialAccounts).values({
    propertyId: getPropertyId(), name: 'Movimiento de caja',
    isDefault: false, isCreditCard: false, isBankAccount: false, countInShift: false, active: true,
  }).returning({ id: financialAccounts.id })
  _movimientoCajaId.set(pid, row!.id)
  return row!.id
}

// Cuenta financiera por defecto del tenant (cuando la cuenta FDM no está en fdm.accountMap)
async function defaultAccountId(): Promise<number> {
  const pid = getPropertyId()
  const def = await db.query.financialAccounts.findFirst({ where: and(eq(financialAccounts.propertyId, pid), eq(financialAccounts.isDefault, true)), columns: { id: true } })
    ?? await db.query.financialAccounts.findFirst({ where: eq(financialAccounts.propertyId, pid), columns: { id: true }, orderBy: (t, { asc }) => [asc(t.id)] })
  if (!def) throw new Error('El tenant no tiene cuentas financieras')
  return def.id
}

// Moneda local del tenant (properties.currencyCode → currencies.id)
async function localCurrencyId(): Promise<number> {
  const code = (await getBranding()).currencyCode
  const cur = await db.query.currencies.findFirst({ where: eq(currencies.code, code), columns: { id: true } })
  if (!cur) throw new Error(`Moneda ${code} no existe en currencies`)
  return cur.id
}

const STATUS_MAP: Record<number, string> = {
  1: 'confirmed', 2: 'cancelled', 4: 'tentative',
  5: 'confirmed', 6: 'checked_in', 7: 'checked_out', 9: 'checked_out', 10: 'no_show', 11: 'confirmed',
}

function parseFdmDate(wcf: string): string {
  const ms = wcf.match(/\/Date\((\d+)\)\//)?.[1]
  if (!ms) throw new Error(`Invalid FDM date: ${wcf}`)
  return new Date(parseInt(ms)).toISOString().slice(0, 10)
}

function parseFdmTs(wcf: string | undefined): Date | null {
  if (!wcf) return null
  const ms = wcf.match(/\/Date\((\d+)\)\//)?.[1]
  return ms ? new Date(parseInt(ms)) : null
}

function parseName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/)
  return parts.length === 1
    ? { firstName: parts[0]!, lastName: '-' }
    : { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1]! }
}

function cleanName(raw: string): string {
  return raw.trim().replace(/\s+\(\d+\)$/, '').trim()
}

async function fdmFetch(path: string, token: string): Promise<any> {
  const { base } = await getFdmConfig()
  const resp = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!resp.ok) throw new Error(`FDM ${path}: ${resp.status} ${await resp.text()}`)
  return resp.json()
}

// FDM devuelve como mucho `limit` filas por página y NO avisa si hay más
// (no manda un total aparte) — hay que pedir páginas hasta que una venga
// incompleta. Sin esto, cualquier ventana de fechas con más de `limit`
// reservas se trunca en silencio: las que FDM ordena más al fondo (aparenta
// ser por LastModified, lo menos tocado recientemente queda último) se
// pierden siempre, sin error ni aviso — esto es lo que causaba que meses de
// temporada baja (con reservas antiguas, poco modificadas) faltasen en la
// sincronización mientras la temporada alta actual sí entraba entera.
async function fdmFetchAllPages(basePath: string, baseParams: Record<string, string>, token: string, pageSize: number): Promise<any[]> {
  let all: any[] = []
  let offset = 0
  const MAX_PAGES = 50   // salvaguarda: 50 * pageSize filas es más que de sobra; evita bucle infinito si la API no coopera
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ ...baseParams, offset: String(offset), limit: String(pageSize) })
    const data = await fdmFetch(`${basePath}?${params}`, token)
    const chunk: any[] = data.Collection ?? []
    all = all.concat(chunk)
    if (chunk.length < pageSize) break
    offset += pageSize
  }
  return all
}

async function buildChannelMap(token: string): Promise<{ channelMap: Map<number, number>; agodaFdmIds: Set<number> }> {
  const { property: FDM_PROPERTY } = await getFdmConfig()
  const { Collection } = await fdmFetch(`/HSOPService.svc/properties/${FDM_PROPERTY}/bookingMethods`, token)
  const localList = await db.select({ id: bookingChannels.id, name: bookingChannels.name })
    .from(bookingChannels).where(eq(bookingChannels.propertyId, getPropertyId()))
  const byName = new Map(localList.map(c => [c.name.toLowerCase().trim(), c.id]))
  const channelMap = new Map<number, number>()
  const agodaFdmIds = new Set<number>()
  for (const m of (Collection ?? [])) {
    const key = (m.Name as string).toLowerCase().trim()
    let localId = byName.get(key)
    if (!localId) {
      const [row] = await db.insert(bookingChannels)
        .values({ propertyId: getPropertyId(), name: m.Name, isDefault: false, active: true })
        .returning({ id: bookingChannels.id })
      localId = row!.id; byName.set(key, localId)
    }
    channelMap.set(m.Id, localId)
    if (key.includes('agoda')) agodaFdmIds.add(m.Id)
  }
  return { channelMap, agodaFdmIds }
}

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('fdm')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// GET /api/fdm/status
app.get('/status', async (c) => {
  return c.json({ configured: await isConfigured() })
})

// POST /api/fdm/push-prices
app.post('/push-prices', zValidator('json', z.object({
  from:  z.string().date(),
  to:    z.string().date(),
  mode:  z.enum(['prices_only', 'prices_and_avail']).default('prices_and_avail'),
  // force: ignora el caché de fdm_push_state y reenvía TODO el rango, aunque
  // no haya cambiado — para resincronizar a mano si algo quedó desalineado.
  force: z.boolean().optional().default(false),
})), async (c) => {
  if (!canUseFdm(c)) return c.json({ error: 'Sin permisos' }, 403)
  if (!await isConfigured()) return c.json({ error: 'FDM no configurado (settings fdm.* y credenciales FDM_*)' }, 400)

  try {
    const { from, to, mode, force } = c.req.valid('json')

    // ── Resolver tipos de habitación locales ──────────────────────────────────
    // localRoomTypeId → fdmRoomUseId
    const roomTypeMapping: { localRoomTypeId: number; fdmRoomUseId: number; label: string }[] = []
    const fdmCfg = await getFdmConfig()
    for (const ru of fdmCfg.roomUses) {
      const m = { contains: ru.contains, fdmRoomUseId: ru.id, label: ru.label }
      const rt = await db.query.roomTypes.findFirst({
        where: and(ilike(roomTypes.name, `%${m.contains}%`), eq(roomTypes.propertyId, getPropertyId())),
        columns: { id: true, name: true },
      })
      if (!rt) { console.warn(`FDM push: tipo "${m.contains}" no encontrado en BD`); continue }
      roomTypeMapping.push({ localRoomTypeId: rt.id, fdmRoomUseId: m.fdmRoomUseId, label: m.label })
    }
    if (!roomTypeMapping.length) return c.json({ error: 'No se encontró ningún tipo de habitación en la BD' }, 404)

    // ── Resolver tarifas locales ──────────────────────────────────────────────
    // fdmRateId → localRateId
    const rateMapping: { fdmRateId: number; localRateId: number; localCode: string }[] = []
    for (const { fdmRateId, localCode } of fdmCfg.rates) {
      const rate = await db.query.rates.findFirst({ where: and(eq(rates.code, localCode), eq(rates.propertyId, getPropertyId())), columns: { id: true } })
      if (!rate) { console.warn(`FDM push: tarifa "${localCode}" no encontrada en BD`); continue }
      rateMapping.push({ fdmRateId, localRateId: rate.id, localCode })
    }
    if (!rateMapping.length) return c.json({ error: 'No se encontró ninguna tarifa en la BD' }, 404)

    // ── Resolver de precios con jerarquía (tarifas y tipos de habitación derivados) ──
    // Los tipos derivados (baseRoomTypeId != null) no tienen filas propias en
    // rateDailyPrices; resolvePrice() camina la cadena de derivación y aplica el ajuste.
    const [allRatesData, allRoomTypesData] = await Promise.all([
      db.select({ id: rates.id, baseRateId: rates.baseRateId, adjustType: rates.adjustType, adjustValue: rates.adjustValue })
        .from(rates).where(eq(rates.propertyId, getPropertyId())),
      db.select({ id: roomTypes.id, baseRoomTypeId: roomTypes.baseRoomTypeId, adjustType: roomTypes.adjustType, adjustValue: roomTypes.adjustValue, maxOccupancy: roomTypes.maxOccupancy })
        .from(roomTypes).where(eq(roomTypes.propertyId, getPropertyId())),
    ])
    const ratesById       = new Map<number, RateForPricing>(allRatesData.map(r => [r.id, r as RateForPricing]))
    const roomTypesById   = new Map<number, RoomTypeForPricing>(allRoomTypesData.map(r => [r.id, r as RoomTypeForPricing]))
    const occupancyByRt   = new Map<number, number>(allRoomTypesData.map(r => [r.id, r.maxOccupancy ?? 1]))

    // Recoger todos los rateIds en las cadenas de derivación
    const neededRateIds = new Set<number>()
    for (const { localRateId } of rateMapping) {
      const rate = ratesById.get(localRateId)
      if (rate) for (const id of rateChainIds(rate, ratesById)) neededRateIds.add(id)
    }

    const allPriceRows = await db.select({
      rateId:     rateDailyPrices.rateId,
      roomTypeId: rateDailyPrices.roomTypeId,
      date:       rateDailyPrices.date,
      price:      rateDailyPrices.price,
      closed:     rateDailyPrices.closed,
    }).from(rateDailyPrices).where(and(
      inArray(rateDailyPrices.rateId, [...neededRateIds]),
      gte(rateDailyPrices.date, from),
      lte(rateDailyPrices.date, to),
    ))

    // closed: heredar del ancestro más cercano con fila en rateDailyPrices
    const closedLookup = new Map<string, boolean>()
    for (const r of allPriceRows) {
      if (r.roomTypeId != null) closedLookup.set(`${r.rateId}:${r.roomTypeId}:${r.date}`, r.closed)
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

    const priceRows: DailyPriceRow[] = allPriceRows.map(r => ({
      rateId: r.rateId, roomTypeId: r.roomTypeId, date: r.date, price: r.price,
    }))

    // ── Disponibilidad por tipo de habitación y fecha ─────────────────────────
    // Idéntico a catalog.ts: reservas activas + bloqueos de camas (sin duplicados)
    const localRoomTypeIds = roomTypeMapping.map(m => m.localRoomTypeId)

    const totalByTypeRows = await db
      .select({ roomTypeId: rooms.roomTypeId, total: sql<number>`COUNT(*)::int` })
      .from(rooms)
      .where(and(eq(rooms.active, true), inArray(rooms.roomTypeId, localRoomTypeIds)))
      .groupBy(rooms.roomTypeId)
    const totalByType: Record<number, number> = {}
    for (const r of totalByTypeRows) totalByType[r.roomTypeId] = r.total

    const occupiedRaw = await db.execute(sql`
      WITH dr AS (
        SELECT generate_series(${from}::date, ${to}::date, '1 day'::interval)::date AS date
      )
      SELECT room_type_id, date, COUNT(DISTINCT room_id)::int AS occupied
      FROM (
        SELECT ro.room_type_id, d.date::text AS date, r.room_id
        FROM reservations r
        JOIN rooms ro ON ro.id = r.room_id
        CROSS JOIN dr d
        WHERE r.room_id IS NOT NULL
          AND r.status NOT IN ('cancelled', 'no_show')
          AND r.check_in_date  <= d.date
          AND r.check_out_date >  d.date
          AND ro.room_type_id IN (${sql.join(localRoomTypeIds.map(id => sql`${id}`), sql`,`)})
        UNION
        SELECT ro2.room_type_id, d.date::text AS date, eid::int AS room_id
        FROM reservations r
        CROSS JOIN jsonb_array_elements_text(r.extra_room_ids) eid
        JOIN rooms ro2 ON ro2.id = eid::int
        CROSS JOIN dr d
        WHERE r.status NOT IN ('cancelled', 'no_show')
          AND r.check_in_date  <= d.date
          AND r.check_out_date >  d.date
          AND ro2.room_type_id IN (${sql.join(localRoomTypeIds.map(id => sql`${id}`), sql`,`)})
        UNION
        SELECT bb.room_type_id, bb.block_date::text AS date, bb.room_id
        FROM blocked_beds bb
        WHERE bb.property_id = ${getPropertyId()}
          AND bb.block_date BETWEEN ${from}::date AND ${to}::date
          AND bb.room_type_id IN (${sql.join(localRoomTypeIds.map(id => sql`${id}`), sql`,`)})
      ) sub
      GROUP BY room_type_id, date
    `) as unknown as { room_type_id: number; date: string; occupied: number }[]
    const occupiedMap: Record<number, Record<string, number>> = {}
    for (const r of occupiedRaw) {
      ;(occupiedMap[r.room_type_id] ??= {})[r.date] = r.occupied
    }

    // Overrides manuales de disponibilidad (cap máximo por fecha y tipo)
    const availOverridesRaw = await db.execute(sql`
      SELECT room_type_id, date::text AS date, max_avail
      FROM room_avail_overrides
      WHERE property_id = ${getPropertyId()}
        AND date BETWEEN ${from}::date AND ${to}::date
        AND room_type_id IN (${sql.join(localRoomTypeIds.map(id => sql`${id}`), sql`,`)})
    `) as unknown as { room_type_id: number; date: string; max_avail: number }[]
    const availOverridesMap: Record<number, Record<string, number>> = {}
    for (const r of availOverridesRaw) {
      ;(availOverridesMap[r.room_type_id] ??= {})[r.date] = r.max_avail
    }

    // ── Generar entries: fecha × tarifa × tipo habitación ────────────────────
    const entries: PushEntry[] = []
    const cur = new Date(from + 'T12:00:00')
    const end = new Date(to   + 'T12:00:00')
    while (cur <= end) {
      const y = cur.getFullYear(), m = String(cur.getMonth()+1).padStart(2,'0'), d = String(cur.getDate()).padStart(2,'0')
      const date = `${y}-${m}-${d}`

      for (const { fdmRateId, localRateId } of rateMapping) {
        for (const { localRoomTypeId, fdmRoomUseId } of roomTypeMapping) {
          const occupancy     = occupancyByRt.get(localRoomTypeId) ?? 1
          const resolvedPrice = resolvePrice(ratesById, roomTypesById, priceRows, localRateId, localRoomTypeId, date, occupancy)
          if (resolvedPrice === null) continue  // sin precio en la cadena → saltar

          const closed   = lookupClosed(localRateId, localRoomTypeId, date)
          const total    = totalByType[localRoomTypeId] ?? 0
          const occupied = occupiedMap[localRoomTypeId]?.[date] ?? 0
          const override = availOverridesMap[localRoomTypeId]?.[date]
          const computed = Math.max(0, total - occupied)
          // El override SUSTITUYE a la disponibilidad calculada (igual que en
          // el calendario, ver buildSummaryRow en PriceCalendarView.tsx) — no
          // es un tope hacia abajo. Antes se usaba Math.min(override,
          // computed), así que un override MAYOR que lo calculado (p.ej.
          // corregir un recuento) se ignoraba y se mandaba igualmente el
          // valor calculado, más bajo.
          entries.push({
            date,
            price:  resolvedPrice,
            avail:  closed ? 0 : (override !== undefined ? Math.max(0, override) : computed),
            closed,
            fdmRateId,
            fdmRoomUseId,
          })
        }
      }
      cur.setDate(cur.getDate() + 1)
    }

    if (!entries.length) return c.json({ error: 'No hay precios para el rango y tarifas solicitados' }, 404)

    // ── Filtrar a solo lo que cambió desde el último push con éxito ──────────
    // fdm_push_state guarda el último {price, avail, closed} que se empujó por
    // fecha × tarifa FDM × tipo de habitación FDM. La disponibilidad puede
    // cambiar sin que cambie ningún precio (reserva nueva, cancelación,
    // bloqueo) — por eso se compara el vector completo, no solo el precio.
    let toSend = entries
    if (!force) {
      const cached = await db.select().from(fdmPushState).where(and(
        eq(fdmPushState.propertyId, getPropertyId()),
        gte(fdmPushState.date, from), lte(fdmPushState.date, to),
      ))
      const cacheKey = (r: { date: string; fdmRateId: number; fdmRoomUseId: number }) => `${r.date}|${r.fdmRateId}|${r.fdmRoomUseId}`
      const cacheByKey = new Map(cached.map(r => [cacheKey(r), r]))
      toSend = entries.filter(e => {
        const c = cacheByKey.get(cacheKey(e))
        if (!c) return true
        return Math.abs(parseFloat(c.price) - e.price) >= 0.005 || c.avail !== e.avail || c.closed !== e.closed
      })
    }

    if (!toSend.length) {
      return c.json({ data: { pushed: 0, skipped: entries.length, errors: 0, errorList: [], succeeded: [], skippedNoChanges: true, total: entries.length, from, to, mode } })
    }

    const result = await pushPricesToFdm(toSend, from, to, mode)

    if (result.succeeded.length > 0) {
      await db.insert(fdmPushState).values(result.succeeded.map(e => ({
        propertyId: getPropertyId(), date: e.date, fdmRateId: e.fdmRateId, fdmRoomUseId: e.fdmRoomUseId,
        price: e.price.toFixed(2), avail: e.avail, closed: e.closed, pushedAt: new Date(),
      }))).onConflictDoUpdate({
        target: [fdmPushState.propertyId, fdmPushState.date, fdmPushState.fdmRateId, fdmPushState.fdmRoomUseId],
        set: { price: sql`excluded.price`, avail: sql`excluded.avail`, closed: sql`excluded.closed`, pushedAt: sql`excluded.pushed_at` },
      })
    }

    return c.json({ data: { ...result, skipped: entries.length - toSend.length, total: entries.length, from, to, mode } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/fdm/sync-reservations — sincroniza reservas FDM para una fecha (por defecto hoy)
app.post('/sync-reservations', zValidator('json', z.object({
  from:  z.string().date().optional(),
  to:    z.string().date().optional(),
  debug: z.boolean().optional(),   // si true, la respuesta incluye `changes`: el detalle campo a campo de cada patch aplicado
})), async (c) => {
  if (!canUseFdm(c)) return c.json({ error: 'Sin permisos' }, 403)
  if (!await isConfigured()) return c.json({ error: 'FDM no configurado (settings fdm.* y credenciales FDM_*)' }, 400)

  try {
    const d = new Date()
    const todayISO = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
    const { from = todayISO, to = todayISO, debug = false } = c.req.valid('json')
    // changes: detalle de cada reserva creada/actualizada por este sync, solo se
    // rellena si `debug` viene a true (para no cargar la respuesta normal del cron).
    const changes: { code: string; resId: number; action: 'create' | 'update'; patch: Record<string, unknown>; before?: Record<string, unknown> }[] = []
    const date = from  // alias para el log de respuesta

    const { property: FDM_PROPERTY, accountLocal, accountPayMethod } = await getFdmConfig()
    const currencyId = await localCurrencyId()
    const token = await getToken()
    const { channelMap, agodaFdmIds } = await buildChannelMap(token)

    // Mapa FDM rateId → local rateId (via Code)
    const fdmRateData = await fdmFetch(`/HSOPService.svc/properties/${FDM_PROPERTY}/rates`, token)
    const fdmRateList: any[] = fdmRateData.Collection ?? []
    const localRateList = await db.select({ id: rates.id, code: rates.code }).from(rates).where(eq(rates.propertyId, getPropertyId()))
    const localRateByCode = new Map(localRateList.map(r => [r.code, r.id]))
    const fdmRateIdToLocalId = new Map<number, number>()
    for (const fr of fdmRateList) {
      const code = (fr.Code ?? '').trim()
      const localId = localRateByCode.get(code)
      if (fr.Id && localId) fdmRateIdToLocalId.set(fr.Id, localId)
    }

    // Cargar mapa local de habitaciones y reservas
    const roomList = await db.select({ id: rooms.id, code: rooms.code, roomTypeId: rooms.roomTypeId })
      .from(rooms).where(eq(rooms.propertyId, getPropertyId()))
    const roomMap     = new Map(roomList.map(r => [r.code, r]))
    const roomById    = new Map(roomList.map(r => [r.id, r]))

    const resList = await db.select({ id: reservations.id, code: reservations.externalCode, status: reservations.status, channelId: reservations.bookingChannelId, roomId: reservations.roomId, extraRoomIds: reservations.extraRoomIds, checkInDate: reservations.checkInDate, checkOutDate: reservations.checkOutDate, rateId: reservations.rateId, lastModifiedAt: reservations.lastModifiedAt, total: reservations.total, amountPaid: reservations.amountPaid, bookedAt: reservations.bookedAt })
      .from(reservations).where(eq(reservations.propertyId, getPropertyId()))
    const resMap = new Map(resList.filter(r => r.code).map(r => [r.code!, r]))

    // Índice de ocupación en memoria: roomId → [{ci, co, resId}]
    // Incluye habitación principal Y habitaciones adicionales (extra_room_ids)
    const ACTIVE_STATUSES = new Set(['confirmed', 'arriving', 'tentative', 'checked_in', 'checking_out'])
    const roomOccupancy = new Map<number, { ci: string; co: string; resId: number }[]>()
    const occupyRoom_ = (roomId: number, ci: string, co: string, resId: number) => {
      const list = roomOccupancy.get(roomId) ?? []
      list.push({ ci, co, resId }); roomOccupancy.set(roomId, list)
    }
    for (const res of resList) {
      if (!ACTIVE_STATUSES.has(res.status)) continue
      if (res.roomId) occupyRoom_(res.roomId, res.checkInDate, res.checkOutDate, res.id)
      for (const xid of (res.extraRoomIds ?? []) as number[]) {
        occupyRoom_(xid, res.checkInDate, res.checkOutDate, res.id)
      }
    }

    // Cargar bloqueos de habitaciones: roomId → Set<date>
    const blockedDates = new Map<number, Set<string>>()
    const blockRows = await db.select({ roomId: blockedBeds.roomId, blockDate: blockedBeds.blockDate })
      .from(blockedBeds)
      .where(and(eq(blockedBeds.propertyId, getPropertyId()), gte(blockedBeds.blockDate, from), lte(blockedBeds.blockDate, to)))
    for (const b of blockRows) {
      const s = blockedDates.get(b.roomId) ?? new Set<string>()
      s.add(b.blockDate); blockedDates.set(b.roomId, s)
    }

    // roomTypeId → [roomId] para buscar alternativas
    const roomsByType = new Map<number, number[]>()
    for (const rm of roomList) {
      const arr = roomsByType.get(rm.roomTypeId) ?? []
      arr.push(rm.id); roomsByType.set(rm.roomTypeId, arr)
    }

    function isRoomFree(roomId: number, ci: string, co: string, excludeResId?: number): boolean {
      for (const occ of roomOccupancy.get(roomId) ?? []) {
        if (occ.resId === excludeResId) continue
        if (ci < occ.co && co > occ.ci) return false
      }
      // Verificar que ninguna noche de la reserva coincida con un bloqueo
      const blocked = blockedDates.get(roomId)
      if (blocked) {
        let d = new Date(ci + 'T00:00:00Z')
        const end = new Date(co + 'T00:00:00Z')
        while (d < end) {
          if (blocked.has(d.toISOString().slice(0, 10))) return false
          d.setUTCDate(d.getUTCDate() + 1)
        }
      }
      return true
    }
    // Devuelve el id de la habitación preferida si está libre, si no busca alternativa del mismo tipo.
    function pickRoom(preferred: { id: number; roomTypeId: number } | undefined, ci: string, co: string, excludeResId?: number): number | null {
      if (!preferred) return null
      if (isRoomFree(preferred.id, ci, co, excludeResId)) return preferred.id
      for (const rid of roomsByType.get(preferred.roomTypeId) ?? []) {
        if (rid === preferred.id) continue
        if (isRoomFree(rid, ci, co, excludeResId)) return rid
      }
      return null  // sin habitación disponible
    }
    function occupyRoom(roomId: number, ci: string, co: string, resId: number) {
      const list = roomOccupancy.get(roomId) ?? []
      list.push({ ci, co, resId }); roomOccupancy.set(roomId, list)
    }
    function freeRoom(roomId: number, resId: number) {
      const list = roomOccupancy.get(roomId)
      if (list) roomOccupancy.set(roomId, list.filter(o => o.resId !== resId))
    }

    // Fetch desde FDM — paginado (ver fdmFetchAllPages): una sola página con
    // límite fijo se trunca en silencio si hay más reservas de las que caben.
    const fdmList = await fdmFetchAllPages(
      `/HSOPService.svc/properties/${FDM_PROPERTY}/reservationinfos`,
      { start: from, end: to, dateType: '', bookingType: '', status: '', bookingMethodId: '', isBookLocalTab: '', includeCancelled: '', expand: 'Guests' },
      token, 3000,
    )

    let imported = 0, updated = 0, skipped = 0, errors = 0
    const fdmIdMap = new Map<number, number>()  // FDM internal res ID → local res ID

    for (const r of fdmList) {
      const code: string = r.ReservationCode
      if (!code) { skipped++; continue }

      const localStatus  = STATUS_MAP[r.Status as number] ?? 'confirmed'
      const channelId    = r.BookingMethodId ? (channelMap.get(r.BookingMethodId) ?? null) : null
      const isAgoda      = r.BookingMethodId ? agodaFdmIds.has(r.BookingMethodId) : false
      const rawTotal     = isAgoda ? (r.BalanceDue ?? r.Total) : r.Total
      const fdmTotal     = typeof rawTotal === 'number' ? rawTotal : parseFloat(rawTotal ?? '0')
      const fdmPaid      = typeof r.Paid   === 'number' ? r.Paid   : parseFloat(r.Paid  ?? '0')
      // Comisión que la propia FDM/canal reporta para esta reserva (más precisa
      // que aplicar un % nuestro) — solo se usa al CREAR, nunca se toca después.
      const fdmBmCommission = typeof r.BMCommission === 'number' ? r.BMCommission : parseFloat(r.BMCommission ?? '0')
      const bookingMs    = r.BookingDate ? parseInt(r.BookingDate.replace(/[^\d]/g, '')) : NaN
      const bookedAt     = !isNaN(bookingMs) && bookingMs > 0 ? new Date(bookingMs) : undefined

      // Habitación(es) de la reserva en FDM: el campo `Room` de la RESERVA (no el
      // de cada ReservationNight) trae TODAS las habitaciones separadas por coma,
      // ej. "307,308" para una reserva de 2 habitaciones — confirmado con datos
      // reales de FDM (reserva #32796, 4 huéspedes en 307+308). `ReservationNights[].Room`
      // en cambio es "código.cama" por CADA noche y cama (ej. "307.1A"), pensado
      // para huéspedes individuales dentro de una habitación compartida, no para
      // saber cuántas habitaciones tiene la reserva — usar solo [0] de ahí fue el
      // origen del bug de habitaciones adicionales que se corrigió.
      const roomCodesTop = ((r.Room ?? '') as string).split(',').map(s => (s.split('.')[0] ?? '').trim()).filter(Boolean)
      const roomEntries  = roomCodesTop.map(c => roomMap.get(c)).filter((x): x is NonNullable<typeof x> => !!x)
      const roomEntry    = roomEntries[0]   // la principal, para lo que solo necesita una (emails, etc.)

      const localRateId   = r.RateId ? (fdmRateIdToLocalId.get(r.RateId) ?? null) : null
      const fdmModified   = parseFdmTs(r.LastModified)

      const existing = resMap.get(code)
      if (existing) {
        const currentRoomIds    = new Set([existing.roomId, ...(existing.extraRoomIds ?? [])].filter((x): x is number => x != null))
        const missingRoomEntries = roomEntries.filter(re => !currentRoomIds.has(re.id))

        // Skip si no ha cambiado en FDM desde la última vez que sincronizamos —
        // salvo que FDM traiga alguna habitación que la reserva local no tiene aún
        const bringsNewRoom = missingRoomEntries.length > 0
        if (!bringsNewRoom && fdmModified && existing.lastModifiedAt && fdmModified <= existing.lastModifiedAt) {
          if (r.Id) fdmIdMap.set(r.Id, existing.id)
          skipped++
          continue
        }

        const patch: Record<string, unknown> = {}
        // Status: solo se actualiza si FDM la cancela
        if (existing.status !== localStatus && localStatus === 'cancelled') patch.status = localStatus
        if (channelId && !existing.channelId)                        patch.bookingChannelId = channelId
        // total: al igual que con la habitación y las fechas (ver comentarios más
        // abajo), una vez la reserva existe localmente su precio total NUNCA se
        // sobreescribe desde FDM. `total` es el precio vivo, editable localmente
        // (ampliaciones, extras, descuentos...); lo que FDM reporta como Total en
        // el momento de importar se guarda aparte en `originalTotal` (solo se
        // rellena al crear, nunca se toca después) y es esa la base que usa el
        // informe de comisiones — precisamente para no mezclar cambios locales de
        // precio con lo que la OTA cobró de comisión. Si aquí se pisara `total`
        // con el de FDM, cualquier ampliación/ajuste de precio local se revertiría
        // en el siguiente sync en cuanto la reserva se reprocesara por cualquier
        // motivo ajeno al precio.
        // amountPaid: solo se sube, nunca se baja. `existing.amountPaid` es la suma real de
        // financial_transactions (recalculada en financial.ts en cada cobro/edición/borrado) —
        // incluye pagos metidos solo en local (efectivo, etc.) que FDM no conoce. Si aquí se
        // sobreescribiera sin más con el `Paid` que reporta FDM (que puede no incluir esos
        // pagos), un cobro ya hecho se "perdería" en cuanto la reserva se reprocesara por
        // cualquier motivo ajeno al pago (p.ej. un cambio de precio) — eso es lo que disparaba
        // la alerta de "sin cobrar" en reservas que en realidad ya estaban saldadas.
        if (fdmPaid > 0) {
          const fdmPaidStr = fdmPaid.toFixed(2)
          if (fdmPaidStr !== existing.amountPaid && fdmPaid > parseFloat(existing.amountPaid ?? '0')) {
            patch.amountPaid = fdmPaidStr
          }
        }
        // Solo se patchea si de verdad cambia — antes se reescribía en cada pasada
        // (siempre que FDM trajera BookingDate, sin comparar contra el valor
        // actual, que ni siquiera se leía), lo que hacía que `patch` nunca
        // quedara vacío para ninguna reserva con bookedAt y el sync la marcara
        // como "actualizada" indefinidamente sin que hubiera cambio real.
        if (bookedAt && (!existing.bookedAt || existing.bookedAt.getTime() !== bookedAt.getTime())) {
          patch.bookedAt = bookedAt
        }
        // Fechas: al igual que con la habitación (ver comentario debajo), una vez
        // la reserva existe localmente sus fechas NUNCA se sobreescriben desde FDM.
        // Ampliar/recortar una reserva es una operación local (ExtendReservationModal
        // etc.) que no se empuja de vuelta a FDM — si se dejara pisar aquí, cualquier
        // evento ajeno a la fecha en FDM (p.ej. el cobro automático de una tarjeta
        // virtual de Booking.com, que también actualiza LastModified) haría que el
        // siguiente sync revirtiera la ampliación a la fecha vieja de FDM sin dejar
        // rastro en el historial. Si algún día se necesita reflejar cambios de fecha
        // hechos directamente en FDM, hace falta un mecanismo explícito de conflicto,
        // no este sync automático.
        if (localRateId && existing.rateId == null)                  patch.rateId            = localRateId
        // Habitaciones: si ya tenía principal, NUNCA se sobreescribe desde la
        // sincronización FDM (una reasignación manual local siempre gana). Lo que
        // SÍ se hace es completar habitaciones que faltan: si el campo `Room` de
        // FDM (ej. "307,308") trae más habitaciones de las que la reserva tiene
        // asignadas localmente, las que falten se añaden — como principal si aún
        // no tenía ninguna, si no como adicionales (extraRoomIds).
        // Tope de seguridad: nunca se asignan más habitaciones de las que FDM
        // realmente pide (roomEntries.length) — evita que una sustitución de
        // habitación por ocupación (pickRoom eligiendo una alternativa del mismo
        // tipo) se vaya sumando de más en sync sucesivos.
        const addedExtraIds: number[] = []
        if (missingRoomEntries.length > 0) {
          let assignedCount = currentRoomIds.size

          for (const missing of missingRoomEntries) {
            if (assignedCount >= roomEntries.length) break
            const candidate = pickRoom(missing, existing.checkInDate, existing.checkOutDate, existing.id)
            if (!candidate) continue
            if (candidate === existing.roomId || (existing.extraRoomIds ?? []).includes(candidate) || addedExtraIds.includes(candidate)) continue

            if (existing.roomId == null) {
              patch.roomId    = candidate
              existing.roomId = candidate
            } else {
              addedExtraIds.push(candidate)
            }
            assignedCount++
          }

          if (addedExtraIds.length > 0) {
            const newExtra = [...(existing.extraRoomIds ?? []), ...addedExtraIds]
            patch.extraRoomIds    = newExtra
            existing.extraRoomIds = newExtra
          }
        }

        if (r.Id) fdmIdMap.set(r.Id, existing.id)
        if (Object.keys(patch).length > 0) {
          if (debug) {
            const before: Record<string, unknown> = {}
            for (const k of Object.keys(patch)) {
              before[k] = (existing as Record<string, unknown>)[k === 'bookingChannelId' ? 'channelId' : k]
            }
            changes.push({ code, resId: existing.id, action: 'update', patch, before })
          }
          try {
            await db.update(reservations).set({ ...patch, updatedAt: new Date() } as any).where(and(eq(reservations.id, existing.id), eq(reservations.propertyId, getPropertyId())))
            if (patch.status) await logStatusChange(existing.id, existing.status, patch.status as string, 'fdm')
            // Actualizar índice de ocupación
            if (existing.roomId) freeRoom(existing.roomId, existing.id)
            const finalRoomId = (patch.roomId as number | null | undefined) ?? existing.roomId
            if (finalRoomId && ACTIVE_STATUSES.has((patch.status as string | undefined) ?? existing.status)) {
              occupyRoom(finalRoomId, existing.checkInDate, existing.checkOutDate, existing.id)
            }
            for (const xid of addedExtraIds) {
              if (ACTIVE_STATUSES.has((patch.status as string | undefined) ?? existing.status)) {
                occupyRoom(xid, existing.checkInDate, existing.checkOutDate, existing.id)
              }
            }
            updated++
          } catch { errors++ }
        } else { skipped++ }
        if (fdmModified) {
          try { await db.update(reservations).set({ lastModifiedAt: fdmModified }).where(and(eq(reservations.id, existing.id), eq(reservations.propertyId, getPropertyId()))) } catch {}
        }
        continue
      }

      // Nueva reserva
      try {
        const mainName = cleanName(r.GuestName ?? '')
        if (!mainName || mainName.length < 2) { skipped++; continue }
        const { firstName, lastName } = parseName(mainName)

        const [guestRow] = await db.insert(guests)
          .values({ propertyId: getPropertyId(), firstName, lastName, email: r.Email || null, phone: r.Phone || null })
          .returning({ id: guests.id })
        const guestId = guestRow!.id

        const checkInDate  = parseFdmDate(r.CheckInDate)
        const checkOutDate = parseFdmDate(r.CheckOutDate)
        const nights = Math.max(1, Math.round(
          (new Date(checkOutDate + 'T12:00:00Z').getTime() - new Date(checkInDate + 'T12:00:00Z').getTime()) / 86400000
        ))

        // Buscar habitación disponible (la de FDM si está libre, si no una alternativa del mismo tipo)
        const assignedRoomId = pickRoom(roomEntry, checkInDate, checkOutDate)

        // Resto de habitaciones (reserva multi-habitación, ej. Room: "307,308" en FDM) —
        // se resuelven después del insert porque pickRoom necesita excluir el id de esta
        // misma reserva para no chocar consigo misma en isRoomFree.
        const extraRoomIds: number[] = []

        const [newRes] = await db.insert(reservations).values({
          propertyId:       getPropertyId(),
          guestId,
          roomId:           assignedRoomId,
          checkInDate,
          checkOutDate,
          nights,
          people:           r.People ?? 1,
          externalCode:     code,
          status:           localStatus as any,
          currencyId:       currencyId,
          total:            fdmTotal.toFixed(2),
          originalTotal:    fdmTotal.toFixed(2),   // precio en el momento de importar, antes de extras/ampliaciones
          bmCommission:     fdmBmCommission.toFixed(2),
          amountPaid:       fdmPaid.toFixed(2),
          bookingChannelId: channelId,
          rateId:           localRateId,
          lastModifiedAt:   fdmModified ?? undefined,
          ...(bookedAt ? { bookedAt, createdAt: bookedAt } : {}),
        }).returning({ id: reservations.id })
        if (r.Id && newRes) fdmIdMap.set(r.Id, newRes.id)
        await logStatusChange(newRes!.id, null, localStatus, 'import')
        // Marcar habitación como ocupada en el índice
        if (assignedRoomId && ACTIVE_STATUSES.has(localStatus)) {
          occupyRoom(assignedRoomId, checkInDate, checkOutDate, newRes!.id)
        }
        for (const extraEntry of roomEntries.slice(1)) {
          const candidate = pickRoom(extraEntry, checkInDate, checkOutDate, newRes!.id)
          if (!candidate || candidate === assignedRoomId || extraRoomIds.includes(candidate)) continue
          extraRoomIds.push(candidate)
          if (ACTIVE_STATUSES.has(localStatus)) occupyRoom(candidate, checkInDate, checkOutDate, newRes!.id)
        }
        if (extraRoomIds.length > 0) {
          await db.update(reservations).set({ extraRoomIds }).where(and(eq(reservations.id, newRes!.id), eq(reservations.propertyId, getPropertyId())))
        }
        resMap.set(code, { id: newRes!.id, code, status: localStatus as any, channelId, roomId: assignedRoomId, extraRoomIds, rateId: localRateId, checkInDate, checkOutDate, lastModifiedAt: fdmModified, total: fdmTotal.toFixed(2), amountPaid: fdmPaid.toFixed(2), bookedAt: bookedAt ?? new Date() })
        imported++
        if (debug) {
          changes.push({ code, resId: newRes!.id, action: 'create', patch: {
            status: localStatus, roomId: assignedRoomId, extraRoomIds, checkInDate, checkOutDate,
            total: fdmTotal.toFixed(2), amountPaid: fdmPaid.toFixed(2), bookingChannelId: channelId,
          } })
        }

        // Confirmación propia (email/WhatsApp) para reservas nuevas de cualquier
        // canal — incluye el enlace de gestión, clave para capturar el email real
        // de huéspedes de Booking.com (que llegan con el alias @guest.booking.com)
        const resId = newRes!.id
        console.log('[fdm/sync] nueva reserva importada, evaluando confirmación', { resId, code, email: r.Email, phone: r.Phone, channelId })
        ;(async () => {
          try {
            const portalUrl = r.Email ? await portalLink(r.Email) : null
            const emailOk = r.Email && portalUrl && await channelEnabled('booking_confirmation', 'email', channelId)
            console.log('[fdm/sync] confirmación email', { resId, emailOk, hasEmail: !!r.Email, hasPortalUrl: !!portalUrl })
            if (emailOk) {
              await sendBookingConfirmationEmail({
                to: r.Email, name: mainName,
                checkIn: checkInDate, checkOut: checkOutDate,
                room: roomEntry?.code ?? 'Por asignar',
                total: fdmTotal.toFixed(2),
                balance: (fdmTotal - fdmPaid).toFixed(2),
                resId, portalUrl: portalUrl!,
              })
              console.log('[fdm/sync] confirmación email enviada', { resId, to: r.Email })
            }
            const waOk = r.Phone && portalUrl && await isWhatsappConfigured() && await channelEnabled('booking_confirmation', 'whatsapp', channelId)
            if (waOk) {
              const wa = await sendWhatsappTemplate({
                to: r.Phone, template: 'confirmacion',
                params: [firstName, checkInDate, checkOutDate, roomEntry?.code ?? 'Por asignar', portalUrl!],
              })
              console.log('[fdm/sync] confirmación whatsapp', { resId, ok: wa.ok, error: wa.error })
            }
          } catch (err) {
            console.error('[fdm/sync] confirmación falló', resId, err)
          }
        })()
      } catch { errors++ }
    }

    // ── Sincronizar facturas ──────────────────────────────────────────────
    const existingInvNums = await db.select({ n: invoices.invoiceNumber })
      .from(invoices).where(eq(invoices.propertyId, getPropertyId()))
      .then(rows => new Set(rows.map(r => r.n)))

    const invParams = new URLSearchParams({
      startDate: from, endDate: to, defaultInvoices: 'false',
      expand: 'CurrencyId,ReservationInvoices,FiskalDetail,IntegrationInvoice,BillingInformation,BillingInformationExtra,InvoiceFiskalyDetail',
    })
    const invData = await fdmFetch(`/HSOPService.svc/properties/${FDM_PROPERTY}/invoices?${invParams}`, token)
    const invList: any[] = invData.Collection ?? []

    let invImported = 0, invErrors = 0
    for (const inv of invList) {
      const invoiceNumber: string = inv.InvoiceNumber
      if (!invoiceNumber || existingInvNums.has(invoiceNumber)) continue
      try {
        const fdmResId: number | undefined = inv.Reservation?.Id
        const reservationId = fdmResId ? (fdmIdMap.get(fdmResId) ?? null) : null
        const total     = parseFloat(inv.PaidToDate ?? '0')
        const taxAmount = (inv.InvoiceTaxes ?? []).reduce((s: number, t: any) => s + (parseFloat(t.TaxRateValue) || 0), 0)
        const noteParts: string[] = []
        if (inv.BilledTo)      noteParts.push(`Emitida a: ${inv.BilledTo}`)
        if (inv.OwnerIdNumber) noteParts.push(`NIF/NIE: ${inv.OwnerIdNumber}`)
        if (fdmResId)          noteParts.push(`Reserva FDM: ${fdmResId}`)
        await db.insert(invoices).values({
          propertyId:    getPropertyId(),
          invoiceNumber,
          issuedAt:      parseFdmDate(inv.InvoiceDate),
          reservationId,
          guestId:       null,
          subtotal:      (total - taxAmount).toFixed(2),
          taxAmount:     taxAmount.toFixed(2),
          total:         total.toFixed(2),
          currencyId:    currencyId,
          notes:         noteParts.join(' | ') || null,
        })
        existingInvNums.add(invoiceNumber)
        invImported++
      } catch { invErrors++ }
    }

    // ── Sincronizar transacciones ─────────────────────────────────────────
    const existingTxKeys = await db.select({ oid: financialTransactions.onlinePaymentId })
      .from(financialTransactions).where(eq(financialTransactions.propertyId, getPropertyId()))
      .then(rows => new Set(rows.map(r => r.oid).filter(Boolean) as string[]))

    const txList = await fdmFetchAllPages(
      `/HSOPService.svc/properties/${FDM_PROPERTY}/financialTransactions`,
      {
        expand: 'ReservationCode,GuestNameAndId,AccountId,FinancialAccountId,CurrencyRef,CreateInfo(Modified),User',
        start: from, end: to, reportingDate: 'false', searchString: '', onlyVisible: 'true', financialAccount: '',
      },
      token, 10000,
    )

    let txImported = 0, txErrors = 0
    for (const tx of txList) {
      const fdmKey = `FDM:${tx.Id}`
      if (existingTxKeys.has(fdmKey)) continue
      try {
        const isMovimiento  = MOVIMIENTO_CAJA_CATEGORIES.has(String(tx.CategoryId ?? ''))
        const fdmAccountId  = tx.FinancialAccount?.Id ?? 0
        const resCode: string | undefined = tx.Reservation?.ReservationCode
        const reservationId = resCode ? (resMap.get(resCode)?.id ?? null) : null
        const rawDate = tx.PaymentDate ?? tx.ReportingDate ?? null
        const txMs    = rawDate ? parseInt(rawDate.replace(/[^\d]/g, '')) : NaN
        const fdmTime = !isNaN(txMs) && txMs > 0 ? new Date(txMs) : new Date()
        const accountId = isMovimiento ? await getMovimientoCajaId() : (accountLocal[fdmAccountId] ?? await defaultAccountId())
        await db.insert(financialTransactions).values({
          propertyId:          getPropertyId(),
          reservationId,
          financialAccountId:  accountId,
          amount:              parseFloat(tx.Amount ?? '0').toFixed(2),
          currencyId:          currencyId,
          paymentMethod:       isMovimiento ? 'other' : (accountPayMethod[fdmAccountId] ?? 'other'),
          category:            isMovimiento ? 'movimiento_caja' : (tx.CategoryId != null ? String(tx.CategoryId) : null),
          description:         tx.Description || null,
          user:                tx.User?.FirstName || null,
          transactionDate:     fdmTime.toISOString().slice(0, 10),
          createdAt:           fdmTime,
          onlinePaymentId:     fdmKey,
          onlinePaymentStatus: null,
          shiftId:             null,
          createdBy:           null,
        } as any)
        existingTxKeys.add(fdmKey)
        txImported++
      } catch { txErrors++ }
    }

    return c.json({ data: { imported, updated, skipped, errors, invImported, invErrors, txImported, txErrors, total: fdmList.length, from, to, ...(debug ? { changes } : {}) } })
  } catch (err) { return serverError(c, err) }
})

export default app
