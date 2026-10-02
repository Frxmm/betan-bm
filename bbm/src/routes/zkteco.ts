import { Hono } from 'hono'
import { db } from '../db'
import { reservations, rooms, properties } from '../db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { timingSafeEqual } from 'node:crypto'
import { runWithProperty, getPropertyId, hasFeature, settingOf } from '../lib/property'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { revokeCard, isConfigured, getStatus, openDoor, getCards, syncCards, getEvents } from '../lib/zkteco'
import { enrollCard, isConfigured as ttlockConfigured } from '../lib/ttlock'
import { storeCards, propertyMs } from './ttlock'
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
  if (/\/enroller\/\d+\/?$/.test(c.req.path)) {
    pid = await tenantByEnrollerKey(c.req.header('X-Enroller-Key'))
    if (!pid) return c.json({ error: 'No autorizado' }, 401)
  } else {
    const token = getCookie(c, 'auth_token') ?? c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ error: 'No autenticado' }, 401)
    try {
      const payload = await verify(token, env.JWT_SECRET, 'HS256') as { propertyId?: number }
      pid = Number(payload.propertyId) || null
    } catch { return c.json({ error: 'Sesión caducada' }, 401) }
    if (!pid) return c.json({ error: 'Sesión sin tenant — vuelve a iniciar sesión' }, 401)
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
    const guest = res.guest as any
    const room  = (res as any).room
    return c.json({
      data: {
        id:         res.id,
        guest_name: `${guest?.firstName ?? ''} ${guest?.lastName ?? ''}`.trim(),
        room:       room?.code ?? '',
        check_in:   res.checkInDate,
        check_out:  res.checkOutDate,
        has_card:   !!res.zktecoCardNo && !res.zktecoCardRevokedAt,
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

    await db.update(reservations)
      .set({
        zktecoCardNo:        String(body.card_no),
        zktecoCardBe:        body.card_code_be ? String(body.card_code_be) : undefined,
        zktecoEnrolledAt:    new Date(),
        zktecoCardRevokedAt: null,  // por si se re-enrola tras una revocación manual
        updatedAt:           new Date(),
      })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    // Si el check-in registró este paso como pendiente, marcarlo como completado
    if (res.checkinZktecoEnrolled === false) {
      await db.update(reservations)
        .set({ checkinZktecoEnrolled: true, updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    }

    // ── Auto-enroll en TTLock ───────────────────────────────────────────────
    // Condiciones: TTLock configurado, enroll habilitado,
    // card_code_be válido (exactamente 8 hex chars = tarjeta Mifare de 4 bytes)
    // Se enrola en TODAS las habitaciones de la reserva que tengan ttlockId.
    const cardBe   = body.card_code_be ?? ''
    const isMifare = /^[0-9A-Fa-f]{8}$/.test(cardBe)
    const room     = (res as any).room

    // Leer setting desde la propiedad del tenant
    const prop = await db.query.properties.findFirst({ where: eq(properties.id, getPropertyId()), columns: { ttlockCardEnrollEnabled: true } })
    const enrollEnabled = prop?.ttlockCardEnrollEnabled ?? true

    // Recopilar todas las habitaciones de la reserva con TTLock
    const lockRooms: Array<{ code: string; lockId: string }> = []
    if (room?.ttlockId) lockRooms.push({ code: room.code, lockId: room.ttlockId })
    const extraIds = (res.extraRoomIds ?? []) as number[]
    if (extraIds.length > 0) {
      const extraRooms = await db.select({ id: rooms.id, code: rooms.code, ttlockId: rooms.ttlockId })
        .from(rooms).where(and(inArray(rooms.id, extraIds), eq(rooms.propertyId, getPropertyId())))
      for (const r of extraRooms) if (r.ttlockId) lockRooms.push({ code: r.code, lockId: r.ttlockId })
    }

    type TtlockRoomResult = { room: string; enrolled: boolean; cardId?: string; reason?: string }
    const ttlockResults: TtlockRoomResult[] = []

    if (!isMifare) {
      ttlockResults.push({ room: room?.code ?? '?', enrolled: false, reason: 'not_mifare' })
    } else if (!await ttlockConfigured()) {
      ttlockResults.push({ room: room?.code ?? '?', enrolled: false, reason: 'not_configured' })
    } else if (!enrollEnabled) {
      ttlockResults.push({ room: room?.code ?? '?', enrolled: false, reason: 'disabled' })
    } else if (!lockRooms.length) {
      ttlockResults.push({ room: room?.code ?? '?', enrolled: false, reason: 'no_lock' })
    } else {
      const guest    = (res as any).guest
      const cardName = guest
        ? `Res#${id} ${guest.firstName ?? ''} ${guest.lastName ?? ''}`.trim()
        : `Res#${id}`
      const checkInMs  = await propertyMs(res.checkInDate, 14)
      const checkOutMs = await propertyMs(res.checkOutDate, 12)

      const cardEntries: { room: string; lockId: string; cardId: string }[] = []
      for (const lr of lockRooms) {
        try {
          const result = await enrollCard({ lockId: lr.lockId, cardNumberHex: cardBe, cardName, startMs: checkInMs, endMs: checkOutMs })
          ttlockResults.push({ room: lr.code, enrolled: true, cardId: result.cardId })
          cardEntries.push({ room: lr.code, lockId: lr.lockId, cardId: result.cardId })
          console.log(`[zkteco/enroller] TTLock card enrolled: res=${id} room=${lr.code} lockId=${lr.lockId} cardId=${result.cardId}`)
        } catch (e: any) {
          ttlockResults.push({ room: lr.code, enrolled: false, reason: e.message })
          console.error(`[zkteco/enroller] TTLock enroll failed: res=${id} room=${lr.code}`, e.message)
        }
      }
      // Guardar los cardId — necesarios para poder borrar la credencial antes de
      // re-enrolarla si la reserva se amplía después (ver reenrollCard en ttlock.ts)
      if (cardEntries.length > 0) {
        await db.update(reservations)
          .set({ ttlockCardIds: storeCards(cardEntries), updatedAt: new Date() })
          .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      }
    }

    return c.json({
      data: {
        ok:           true,
        card_no:      body.card_no,
        card_code_be: cardBe || null,
        ttlock:       ttlockResults,
      },
    })
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
async function roomCodeMap(userIds: string[]): Promise<Record<string, string>> {
  const ids = userIds.map(Number).filter(n => !isNaN(n) && n > 0)
  if (ids.length === 0) return {}
  const rows = await db
    .select({ id: reservations.id, code: rooms.code })
    .from(reservations)
    .innerJoin(rooms, eq(rooms.id, reservations.roomId))
    .where(and(inArray(reservations.id, ids), eq(reservations.propertyId, getPropertyId())))
  return Object.fromEntries(rows.map(r => [String(r.id), r.code]))
}

app.get('/cards', async (c) => {
  if (!await isConfigured()) return c.json({ data: [] })
  try {
    const result = await getCards()
    const cards: any[] = Array.isArray(result) ? result : result.data ?? []
    const codeMap = await roomCodeMap(cards.map((c: any) => c.user_id).filter(Boolean))
    return c.json({ data: cards.map((c: any) => ({ ...c, room_code: codeMap[c.user_id] ?? null })) })
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
