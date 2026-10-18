import { Hono } from 'hono'
import { db } from '../db'
import { reservations, rooms, properties } from '../db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { timingSafeEqual } from 'node:crypto'
import { runWithProperty, getPropertyId, hasFeature, settingOf } from '../lib/property'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { revokeCard, enrollCardToDevice, isConfigured, getStatus, openDoor, getCards, syncCards, getEvents } from '../lib/zkteco'
import { enrollCard, isConfigured as ttlockConfigured } from '../lib/ttlock'
import { storeCards, parseStoredCards, propertyMs } from './ttlock'
import { notFound, serverError } from '../lib/errors'
import { env } from '../lib/env'

const app = new Hono()

// ── Resolución de tenant ──────────────────────────────────────────────────────
// Este router se monta antes de requireAuth, así que resuelve el tenant él mismo:
//  · /enroller/*  → cabecera X-Enroller-Key = secreto ZKTECO_ENROLLER_SECRET de UN tenant
//                   (settings secrets.ZKTECO_ENROLLER_SECRET; barrido de properties)
//  · resto        → JWT del personal (propertyId del token)
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

async function tenantByEnrollerKey(key: string | undefined): Promise<number | null> {
  if (!key) return null
  const rows = await db.select().from(properties).where(eq(properties.active, true))
  for (const p of rows) {
    const secret = settingOf<string>(p, 'secrets.ZKTECO_ENROLLER_SECRET')
    if (secret && safeEq(secret, key)) return p.id
  }
  return null
}

app.use('*', async (c, next) => {
  let pid: number | null = null
  // enroller.exe (X-Enroller-Key) o, sin esa cabecera, JWT de administración desde la UI
  const enrollerKey = c.req.header('X-Enroller-Key')
  const isEnrollerPath = /\/enroller\/\d+\/?$/.test(c.req.path)
  if (isEnrollerPath && enrollerKey) {
    pid = await tenantByEnrollerKey(enrollerKey)
    if (!pid) return c.json({ error: 'No autorizado' }, 401)
  } else {
    const token = getCookie(c, 'auth_token') ?? c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'No autenticado' }, 401)
    try {
      const payload = await verify(token, env.JWT_SECRET, 'HS256') as { propertyId?: number }
      pid = Number(payload.propertyId) || null
      c.set('jwtPayload', payload)
    } catch { return c.json({ error: 'Sesión caducada' }, 401) }
    if (!pid) return c.json({ error: 'Sesión sin tenant — vuelve a iniciar sesión' }, 401)
    if (isEnrollerPath) {
      const { isAdmin } = await import('../middleware/auth')
      if (!isAdmin(c)) return c.json({ error: 'No autorizado' }, 401)
    }
  }
  return runWithProperty(pid, async () => {
    if (!await hasFeature('zkteco')) return c.json({ error: 'Módulo no activado' }, 404)
    return next()
  })
})

// ── GET /api/zkteco/enroller/:id ──────────────────────────────────────────────
// El enroller.exe llama esto al escribir el nº de reserva para auto-rellenar
// nombre del huésped y habitación.
app.get('/enroller/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with: {
        guest:  { columns: { firstName: true, lastName: true } },
        room:   { columns: { code: true } },
      },
    })
    if (!res) return notFound(c, 'Reserva')
    const guest      = res.guest as any
    const room       = (res as any).room
    const extraCards = ((res as any).zktecoExtraCards ?? []) as Array<{ cardNo: string; cardBe: string; pin: string; enrolledAt: string }>
    const cardCount  = (res.zktecoCardNo && !res.zktecoCardRevokedAt ? 1 : 0) + extraCards.length
    const nextPin    = String(res.id + cardCount * 1_000_000_000)
    return c.json({
      data: {
        id:         res.id,
        guest_name: `${guest?.firstName ?? ''} ${guest?.lastName ?? ''}`.trim(),
        room:       room?.code ?? '',
        check_in:   res.checkInDate,
        check_out:  res.checkOutDate,
        has_card:   cardCount > 0,
        card_count: cardCount,
        next_pin:   nextPin,
      },
    })
  } catch (err) { return serverError(c, err) }
})

// ── POST /api/zkteco/enroller/:id ─────────────────────────────────────────────
// El enroller.exe llama esto tras enrollar la tarjeta en bridge_win.
// Guarda la vinculación tarjeta↔reserva del tenant.
// user_id en bridge_win = reservation ID (estable e inmutable).
app.post('/enroller/:id', async (c) => {

  try {
    const id = Number(c.req.param('id'))
    const body = await c.req.json<{ card_no: string; card_code_be?: string }>()
    if (!body.card_no) return c.json({ error: 'card_no requerido' }, 400)

    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { room: true },
    })
    if (!res) return notFound(c, 'Reserva')

    const cardBe      = body.card_code_be ?? ''
    const isMifare    = /^[0-9A-Fa-f]{8}$/.test(cardBe)
    const room        = (res as any).room
    const isPrimary   = !res.zktecoCardNo || !!res.zktecoCardRevokedAt
    const extraCards  = ((res as any).zktecoExtraCards ?? []) as Array<{ cardNo: string; cardBe: string; pin: string; enrolledAt: string }>

    type TtlockRoomResult = { room: string; enrolled: boolean; cardId?: string; reason?: string }

    // ── Helper: enrola una tarjeta física en todas las cerraduras TTLock ──────
    async function enrollCardInLocks(hexBe: string, cardLabel: string): Promise<{ results: TtlockRoomResult[]; entries: Array<{ room: string; lockId: string; cardId: string }> }> {
      const prop = await db.query.properties.findFirst({ where: eq(properties.id, getPropertyId()), columns: { ttlockCardEnrollEnabled: true } })
      const enrollEnabled = prop?.ttlockCardEnrollEnabled ?? true
      const lockRooms: Array<{ code: string; lockId: string }> = []
      if (room?.ttlockId) lockRooms.push({ code: room.code, lockId: room.ttlockId })
      const extraIds = (res!.extraRoomIds ?? []) as number[]
      if (extraIds.length > 0) {
        const extraRooms = await db.select({ id: rooms.id, code: rooms.code, ttlockId: rooms.ttlockId })
          .from(rooms).where(and(inArray(rooms.id, extraIds), eq(rooms.propertyId, getPropertyId())))
        for (const r of extraRooms) if (r.ttlockId) lockRooms.push({ code: r.code, lockId: r.ttlockId })
      }
      const results: TtlockRoomResult[] = []
      const entries: Array<{ room: string; lockId: string; cardId: string }> = []
      const reason = !hexBe || !/^[0-9A-Fa-f]{8}$/.test(hexBe) ? 'not_mifare'
        : !(await ttlockConfigured()) ? 'not_configured'
        : !enrollEnabled ? 'disabled'
        : !lockRooms.length ? 'no_lock'
        : null
      if (reason) {
        results.push({ room: room?.code ?? '?', enrolled: false, reason })
        return { results, entries }
      }
      const checkInMs  = await propertyMs(res!.checkInDate, 14)
      const checkOutMs = await propertyMs(res!.checkOutDate, 12)
      for (const lr of lockRooms) {
        try {
          const result = await enrollCard({ lockId: lr.lockId, cardNumberHex: hexBe, cardName: cardLabel, startMs: checkInMs, endMs: checkOutMs })
          results.push({ room: lr.code, enrolled: true, cardId: result.cardId })
          entries.push({ room: lr.code, lockId: lr.lockId, cardId: result.cardId })
        } catch (e: any) {
          results.push({ room: lr.code, enrolled: false, reason: e.message })
          console.error(`[zkteco/enroller] TTLock enroll failed: res=${id} room=${lr.code}`, e.message)
        }
      }
      return { results, entries }
    }

    const guest    = (res as any).guest
    const cardName = guest ? `Res#${id} ${guest.firstName ?? ''} ${guest.lastName ?? ''}`.trim() : `Res#${id}`

    if (isPrimary) {
      // ── Tarjeta principal ────────────────────────────────────────────────
      await db.update(reservations)
        .set({
          zktecoCardNo:        String(body.card_no),
          zktecoCardBe:        cardBe || undefined,
          zktecoEnrolledAt:    new Date(),
          zktecoCardRevokedAt: null,
          updatedAt:           new Date(),
        })
        
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

      if (res.checkinZktecoEnrolled === false) {
        await db.update(reservations)
          .set({ checkinZktecoEnrolled: true, updatedAt: new Date() })
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      }

      const { results: ttlockResults, entries } = await enrollCardInLocks(cardBe, cardName)
      if (entries.length > 0) {
        await db.update(reservations)
          .set({ ttlockCardIds: storeCards(entries), updatedAt: new Date() })
          
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      }

      return c.json({ data: { ok: true, card_no: body.card_no, card_code_be: cardBe || null, ttlock: ttlockResults } })
    } else {
      // ── Tarjeta extra (ya existe tarjeta principal activa) ───────────────
      const pin = String(id + (1 + extraCards.length) * 1_000_000_000)
      const { results: ttlockResults, entries } = await enrollCardInLocks(cardBe, `${cardName} +${extraCards.length + 1}`)

      const newExtra = { cardNo: String(body.card_no), cardBe: cardBe || '', pin, enrolledAt: new Date().toISOString() }
      const existingTtlockEntries = parseStoredCards((res as any).ttlockCardIds ?? null)
      await db.update(reservations)
        .set({
          zktecoExtraCards: [...extraCards, newExtra],
          ttlockCardIds:    entries.length > 0 ? storeCards([...existingTtlockEntries, ...entries]) : undefined,
          updatedAt:        new Date(),
        })
        
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

      return c.json({ data: { ok: true, card_no: body.card_no, card_code_be: cardBe || null, extra: true, pin, ttlock: ttlockResults } })
    }
  } catch (err) { return serverError(c, err) }
})

// ── DELETE /api/zkteco/:id ────────────────────────────────────────────────────
// Llamado desde la UI (JWT). Revoca en C3-400 y limpia la reserva.
// user_id en bridge_win = reservation ID.
app.delete('/:id', async (c) => {
  if (!await isConfigured()) return c.json({ error: 'ZKTECO_BRIDGE_URL no configurado' }, 503)

  try {
    const id = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!res) return notFound(c, 'Reserva')
    if (!res.zktecoCardNo || res.zktecoCardRevokedAt) return c.json({ error: 'Esta reserva no tiene tarjeta enrollada activa' }, 400)

    await revokeCard(String(id))

    // Ya no se borra zktecoCardNo/zktecoCardBe — se marca revocada (ver
    // schema), para poder reutilizarla en una reserva consecutiva del mismo
    // huésped en la misma habitación.
    await db.update(reservations)
      .set({ zktecoCardRevokedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// ── POST /api/zkteco/enroll — UI admin: enrollar tarjeta de empleado o temporal ─
app.post('/enroll', async (c) => {
  if (!await isConfigured()) return c.json({ error: 'ZKTeco no configurado' }, 503)
  const { isAdmin } = await import('../middleware/auth')
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)

  const body = await c.req.json<{
    type: 'employee' | 'temp'
    cardNumber: string
    employeeId?: number
    name?: string
    pin?: string
  }>().catch(() => null)
  if (!body) return c.json({ error: 'Body inválido' }, 400)

  const rawCard = String(body.cardNumber ?? '').trim()
  const cardNumber = rawCard.replace(/^0+/, '') || rawCard
  if (!cardNumber || !/^\d+$/.test(cardNumber))
    return c.json({ error: 'Número de tarjeta inválido (solo dígitos decimales)' }, 400)

  try {
    if (body.type === 'employee') {
      if (!body.employeeId) return c.json({ error: 'employeeId requerido' }, 400)
      const { users } = await import('../db/schema')
      const user = await db.query.users.findFirst({ where: and(eq(users.id, body.employeeId), eq(users.propertyId, getPropertyId())) })
      if (!user) return c.json({ error: 'Usuario no encontrado' }, 404)
      const pin  = String(90_000_000_000 + body.employeeId)
      const name = `${user.firstName} ${user.lastName}`.trim()
      await enrollCardToDevice({ userId: pin, name, cardNumber, note: `Empleado:${body.employeeId}`, reservationId: '' })
      return c.json({ data: { ok: true, pin, name, type: 'employee' } })
    }

    if (body.type === 'temp') {
      if (!body.name?.trim()) return c.json({ error: 'Nombre requerido' }, 400)
      const pin = body.pin?.trim() || String(Date.now()).slice(-8)
      if (!/^\d{1,10}$/.test(pin)) return c.json({ error: 'PIN debe ser numérico (máx. 10 dígitos)' }, 400)
      await enrollCardToDevice({ userId: pin, name: body.name.trim(), cardNumber, note: 'Acceso temporal', reservationId: '' })
      return c.json({ data: { ok: true, pin, name: body.name.trim(), type: 'temp' } })
    }

    return c.json({ error: 'type debe ser "employee" o "temp"' }, 400)
  } catch (err) { return serverError(c, err) }
})

// ── Endpoints proxy al bridge_win (JWT) ───────────────────────────────────────
// Estos se montan antes del middleware global requireAuth, así que lo hacemos inline.

app.get('/status', async (c) => {
  if (!await isConfigured()) return c.json({ configured: false })
  // Si el bridge no responde (offline, red caída...) NO se devuelve un error
  // 5xx — eso hacía que el frontend confundiera "bridge inalcanzable ahora
  // mismo" con "ZKTeco no está configurado en absoluto", y se saltaba en
  // silencio el aviso obligatorio de check-in sin tarjeta enrollada (el
  // gate del frontend es `zktecoConfigured && !zktecoCardNo` — con
  // zktecoConfigured en false por este motivo, nunca llegaba a comprobarlo).
  // reachable=false dice "sí está configurado, pero ahora mismo no contesta".
  try {
    const status = await getStatus()
    return c.json({ configured: true, reachable: true, ...status })
  } catch (err: any) {
    return c.json({ configured: true, reachable: false, error: err.message ?? 'No se pudo conectar con el bridge' })
  }
})

app.post('/doors/:n/open', async (c) => {
  if (!await isConfigured()) return c.json({ error: 'No configurado' }, 503)
  try { return c.json(await openDoor(Number(c.req.param('n')))) }
  catch (err) { return serverError(c, err) }
})

// Devuelve un mapa reservationId → room_code consultando nuestra BD
const PG_INT_MAX        = 2_147_483_647
const EXTRA_CARD_OFFSET = 1_000_000_000
const EMPLOYEE_OFFSET   = 90_000_000_000

// Para tarjetas extra (pin = reservaId + N×1B) extrae el reservaId real.
// Para empleados (pin ≥ 90B) o pins pequeños los devuelve tal cual.
function resolveReservationId(pin: number): number {
  if (pin >= EMPLOYEE_OFFSET) return pin  // empleado — no tiene reserva
  if (pin >= EXTRA_CARD_OFFSET) return pin % EXTRA_CARD_OFFSET
  return pin
}

async function roomCodeMap(userIds: string[]): Promise<Record<string, string>> {
  // Mapeo pin → reservaId resuelto (descartando empleados y valores inválidos)
  const pinToResv: Map<string, number> = new Map()
  for (const uid of userIds) {
    const pin = Number(uid)
    if (isNaN(pin) || pin <= 0) continue
    if (pin >= EMPLOYEE_OFFSET) continue          // tarjeta de empleado — sin reserva
    const resvId = resolveReservationId(pin)
    if (resvId > 0 && resvId <= PG_INT_MAX) pinToResv.set(uid, resvId)
  }
  if (pinToResv.size === 0) return {}
  const ids = [...new Set(pinToResv.values())]
  const rows = await db
    .select({ id: reservations.id, code: rooms.code })
    .from(reservations)
    .innerJoin(rooms, eq(rooms.id, reservations.roomId))
    .where(and(inArray(reservations.id, ids), eq(reservations.propertyId, getPropertyId())))
  const resvCodeMap = Object.fromEntries(rows.map(r => [r.id, r.code]))
  // Devuelve pin (string) → código de habitación
  const result: Record<string, string> = {}
  for (const [uid, resvId] of pinToResv) {
    const code = resvCodeMap[resvId]
    if (code) result[uid] = code
  }
  return result
}

app.get('/cards', async (c) => {
  if (!await isConfigured()) return c.json({ data: [] })
  try {
    const result = await getCards()
    const cards: any[] = Array.isArray(result) ? result : result.data ?? []
    const codeMap = await roomCodeMap(cards.map((c: any) => c.user_id).filter(Boolean))
    return c.json({ data: cards.map((c: any) => {
      const note: string = c.note ?? ''
      const card_type = note.startsWith('Empleado:') ? 'employee' : note === 'Acceso temporal' ? 'temp' : 'reservation'
      return { ...c, room_code: codeMap[c.user_id] ?? null, card_type }
    }) })
  } catch (err) { return serverError(c, err) }
})

app.post('/sync', async (c) => {
  if (!await isConfigured()) return c.json({ error: 'No configurado' }, 503)
  try { return c.json(await syncCards()) }
  catch (err) { return serverError(c, err) }
})

app.delete('/cards/:userId', async (c) => {
  if (!await isConfigured()) return c.json({ error: 'No configurado' }, 503)
  try {
    await revokeCard(c.req.param('userId'))
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

app.get('/events', async (c) => {
  if (!await isConfigured()) return c.json({ data: [] })
  const limit  = Number(c.req.query('limit')  ?? 100)
  const offset = Number(c.req.query('offset') ?? 0)
  try {
    const result = await getEvents(limit, offset)
    const evts: any[] = Array.isArray(result) ? result : result.data ?? []
    const codeMap = await roomCodeMap(evts.map((e: any) => e.user_id).filter(Boolean))
    return c.json({ data: evts.map((e: any) => ({ ...e, room_code: codeMap[e.user_id] ?? null })) })
  } catch (err) { return serverError(c, err) }
})

// ── GET /api/zkteco/config — leer configuración TTLock enroll ─────────────────
app.get('/config', async (c) => {
  try {
    const prop = await db.query.properties.findFirst({ where: eq(properties.id, getPropertyId()), columns: { ttlockCardEnrollEnabled: true } })
    return c.json({ ttlockCardEnrollEnabled: prop?.ttlockCardEnrollEnabled ?? true })
  } catch (err) { return serverError(c, err) }
})

// ── PATCH /api/zkteco/config — actualizar configuración TTLock enroll ─────────
app.patch('/config', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const body = await c.req.json<{ ttlockCardEnrollEnabled: boolean }>()
    if (typeof body.ttlockCardEnrollEnabled !== 'boolean')
      return c.json({ error: 'ttlockCardEnrollEnabled debe ser boolean' }, 400)
    await db.update(properties)
      .set({ ttlockCardEnrollEnabled: body.ttlockCardEnrollEnabled, updatedAt: new Date() })
      .where(eq(properties.id, getPropertyId()))
    return c.json({ ttlockCardEnrollEnabled: body.ttlockCardEnrollEnabled })
  } catch (err) { return serverError(c, err) }
})

export default app
