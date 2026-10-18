import { Hono } from 'hono'
import { db } from '../db'
import { reservations, rooms, reservationNotes, properties } from '../db/schema'
import { eq, and, inArray } from 'drizzle-orm'
import { getPropertyId, getBranding, hasFeature } from '../lib/property'
import { serverError, notFound } from '../lib/errors'
import { createPasscode, deletePasscode, enrollCard, deleteCard, isConfigured } from '../lib/ttlock'
import { sendLockCode } from '../lib/email'
import { sendWhatsappTemplate } from '../lib/whatsapp'
import { channelEnabled } from '../lib/messaging'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import { propertyMs, zonedMs } from '../lib/dates'

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('ttlock')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// ¿Está el canal de venta de esta reserva exento de la regla "debe estar
// saldada para hacer check-in"? Configurable en Reservas → Configuración
// (Ajustes → Configuración → "Debe estar saldada para check-in").
async function isBalanceCheckExempt(bookingChannelId: number | null | undefined): Promise<boolean> {
  if (!bookingChannelId) return false
  const prop = await db.query.properties.findFirst({
    where: eq(properties.id, getPropertyId()),
    columns: { ttlockBalanceExemptChannelIds: true },
  })
  return (prop?.ttlockBalanceExemptChannelIds ?? []).includes(bookingChannelId)
}

// Conversión fecha+hora local del tenant → timestamp (ver lib/dates.ts)
export { zonedMs as localMs, propertyMs }

// ── Helpers para almacenamiento multi-habitación ───────────────────────────────
// ttlockCode puede ser:
//   - string plano "1234"       → una sola habitación (backward compat)
//   - JSON array "[{room,lockId,code,pwdId},...]" → múltiples habitaciones
interface CodeEntry { room: string; lockId: string; code: string; pwdId: string }

function parseStoredCodes(ttlockCode: string | null | undefined, ttlockCodeId: string | null | undefined, primaryRoom: any): CodeEntry[] {
  if (!ttlockCode) return []
  if (ttlockCode.startsWith('[')) {
    try { return JSON.parse(ttlockCode) } catch { return [] }
  }
  const lockId = primaryRoom?.ttlockId
  if (!lockId) return []
  return [{ room: primaryRoom.code ?? '?', lockId, code: ttlockCode, pwdId: ttlockCodeId ?? '' }]
}

function storeCode(entries: CodeEntry[]): { ttlockCode: string; ttlockCodeId: string | null } {
  if (entries.length === 1) {
    const e = entries[0]!
    return { ttlockCode: e.code, ttlockCodeId: e.pwdId }
  }
  return { ttlockCode: JSON.stringify(entries), ttlockCodeId: null }
}

// Carga todas las habitaciones de la reserva (primaria + extra) que tengan TTLock
export async function roomsWithLock(primaryRoom: any, extraRoomIds: number[]): Promise<Array<{ code: string; ttlockId: string }>> {
  const result: Array<{ code: string; ttlockId: string }> = []
  if (primaryRoom?.ttlockId) result.push({ code: primaryRoom.code, ttlockId: primaryRoom.ttlockId })
  if (extraRoomIds.length > 0) {
    const extras = await db.select({ id: rooms.id, code: rooms.code, ttlockId: rooms.ttlockId })
      .from(rooms).where(and(inArray(rooms.id, extraRoomIds), eq(rooms.propertyId, getPropertyId())))
    for (const r of extras) if (r.ttlockId) result.push({ code: r.code, ttlockId: r.ttlockId })
  }
  return result
}

// ── Helpers para almacenamiento de tarjetas TTLock (multi-habitación) ──────────
// Mismo formato que ttlockCode/ttlockCodeId pero para la credencial de tarjeta
// IC que se enrola en TTLock a partir de la tarjeta ZKTeco ya física del huésped.
export interface CardEntry { room: string; lockId: string; cardId: string }

export function parseStoredCards(ttlockCardIds: string | null | undefined): CardEntry[] {
  if (!ttlockCardIds) return []
  try { return JSON.parse(ttlockCardIds) } catch { return [] }
}
export function storeCards(entries: CardEntry[]): string | null {
  return entries.length > 0 ? JSON.stringify(entries) : null
}

// Re-enrola en TTLock la MISMA tarjeta física (ZKTeco) ya enrolada por el
// huésped, con una nueva ventana de validez — usado al ampliar la reserva, para
// que la tarjeta siga funcionando hasta el nuevo check-out sin que el huésped
// tenga que volver a pasarla físicamente. Borra antes las credenciales
// anteriores (por cardId, guardado la vez anterior) para no duplicar entradas.
// No-op silencioso si la reserva no tiene tarjeta enrolada.
export async function reenrollCard(
  res: {
    id: number
    zktecoCardBe: string | null
    ttlockCardIds: string | null
    zktecoExtraCards?: Array<{ cardBe: string; [k: string]: unknown }> | null
    guest?: { firstName?: string | null; lastName?: string | null } | null
  },
  lockRooms: Array<{ code: string; ttlockId: string }>,
  startMs: number,
  endMs: number,
): Promise<{ attempted: boolean; ok: boolean; error?: string }> {
  // Todas las tarjetas físicas a re-enrolar: primary + extras
  const allCardBes = [
    ...(res.zktecoCardBe ? [res.zktecoCardBe] : []),
    ...((res.zktecoExtraCards ?? []).map(c => c.cardBe).filter(Boolean) as string[]),
  ]
  if (!allCardBes.length || !lockRooms.length) return { attempted: false, ok: true }

  // Borrar TODAS las credenciales TTLock anteriores (de todas las tarjetas)
  const oldEntries = parseStoredCards(res.ttlockCardIds)
  await Promise.allSettled(oldEntries.map(e => deleteCard(e.lockId, e.cardId).catch(() => {})))

  const guestName = res.guest ? `${res.guest.firstName ?? ''} ${res.guest.lastName ?? ''}`.trim() : ''
  const baseCardName = `Res#${res.id}${guestName ? ' - ' + guestName : ''}`

  try {
    const newEntries: CardEntry[] = []
    for (let i = 0; i < allCardBes.length; i++) {
      const cardNumberHex = allCardBes[i]!
      const cardName = i === 0 ? baseCardName : `${baseCardName} +${i}`
      for (const lr of lockRooms) {
        const { cardId } = await enrollCard({ lockId: lr.ttlockId, cardNumberHex, cardName, startMs, endMs })
        newEntries.push({ room: lr.code, lockId: lr.ttlockId, cardId })
      }
    }
    await db.update(reservations)
      .set({ ttlockCardIds: storeCards(newEntries), updatedAt: new Date() })
      .where(and(eq(reservations.id, res.id), eq(reservations.propertyId, getPropertyId())))
    return { attempted: true, ok: true }
  } catch (e: any) {
    return { attempted: true, ok: false, error: e.message }
  }
}

// POST /api/ttlock/generate/:reservationId
// Genera (o regenera) el código de cerradura y lo envía por email al huésped.
// Body opcional: { earlyCheckIn?: boolean, earlyComment?: string }
// Con earlyCheckIn=true el código arranca a las 9:00 en lugar de las 14:00.
app.post('/generate/:id', async (c) => {
  try {
    if (!await isConfigured()) return c.json({ error: 'TTLock no configurado' }, 503)

    const id   = Number(c.req.param('id'))
    const body = await c.req.json().catch(() => ({})) as { earlyCheckIn?: boolean; earlyComment?: string }
    const earlyCheckIn  = !!body.earlyCheckIn
    const earlyComment  = (body.earlyComment ?? '').trim()
    if (earlyCheckIn && !earlyComment) return c.json({ error: 'Se requiere un comentario para la activación anticipada' }, 422)

    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true },
    })
    if (!res)      return notFound(c, 'Reserva')
    if (!res.guest?.email) return c.json({ error: 'El huésped no tiene email' }, 400)

    const primaryRoom   = res.room as any
    const extraRoomIds  = (res.extraRoomIds ?? []) as number[]
    const lockRooms     = await roomsWithLock(primaryRoom, extraRoomIds)
    if (!lockRooms.length) return c.json({ error: 'Ninguna habitación de esta reserva tiene cerradura TTLock configurada' }, 400)

    // Regla de negocio: el código de puerta solo se entrega con la reserva
    // saldada — un depósito retenido sin cobrar no cuenta como pago de la
    // estancia (ver src/lib/paymentAggregate.ts), o se entregaría el código
    // con la habitación aún sin pagar. Salvo canales exentos (Reservas →
    // Configuración → "Debe estar saldada para check-in").
    if (!await isBalanceCheckExempt(res.bookingChannelId)) {
      const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
      const due = calcPendingBalance(res.total, realPaid)
      if (due > 0.01) return c.json({ error: `No se puede enviar el código: quedan ${due.toFixed(2)} € pendientes de pago` }, 422)
    }

    // Si ya hay códigos, eliminarlos primero
    const existingCodes = parseStoredCodes(res.ttlockCode, res.ttlockCodeId, primaryRoom)
    await Promise.allSettled(existingCodes.map(e => deletePasscode(e.lockId, e.pwdId).catch(() => {})))

    // Inicio: 14:00 normal, o 09:00 si es activación anticipada.
    // Si la estancia ya está en curso arranca desde ahora (TTLock invalida startDates pasadas).
    const startHour = earlyCheckIn ? 9 : 14
    const startMs   = Math.max(await propertyMs(res.checkInDate, startHour), Date.now())
    const endMs     = await propertyMs(res.checkOutDate, 12)
    if (endMs <= startMs) return c.json({ error: 'La reserva ya ha terminado — no se puede generar código' }, 422)

    const guestName = `${res.guest.firstName} ${res.guest.lastName}`

    // Generar un código por cada habitación con TTLock
    const entries: CodeEntry[] = await Promise.all(
      lockRooms.map(async lr => {
        const { code, keyboardPwdId } = await createPasscode({
          lockId:  lr.ttlockId,
          name:    `Reserva #${id} - ${guestName}`,
          startMs,
          endMs,
        })
        return { room: lr.code, lockId: lr.ttlockId, code, pwdId: keyboardPwdId }
      })
    )

    // Guardar en DB
    const stored = storeCode(entries)
    await db.update(reservations)
      .set({ ttlockCode: stored.ttlockCode, ttlockCodeId: stored.ttlockCodeId, updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    // Guardar nota de activación anticipada
    if (earlyCheckIn) {
      await db.insert(reservationNotes).values({
        reservationId: id,
        note: `Check-in anticipado (código desde 09:00): ${earlyComment}`,
        type: 'note',
      })
    }

    // Enviar email (un email por habitación si el canal está habilitado)
    const emailOn = await channelEnabled('lock_code', 'email', res.bookingChannelId)
    if (emailOn) {
      for (const e of entries) {
        await sendLockCode({
          to:        res.guest.email,
          guestName,
          roomCode:  e.room,
          code:      e.code,
          checkIn:   res.checkInDate,
          checkOut:  res.checkOutDate,
        })
      }
      await db.update(reservations)
        .set({ ttlockSentAt: new Date(), updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    }

    return c.json({ data: { entries, sentTo: emailOn ? res.guest.email : 'canal email deshabilitado' } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/ttlock/reenroll-card/:reservationId
// Re-enrola la MISMA tarjeta física (ZKTeco) ya enrolada por el huésped, con
// nueva ventana de validez hasta el check-out actual — usado al ampliar la
// reserva. No-op (200, attempted:false) si la reserva no tiene tarjeta enrolada
// o ninguna de sus habitaciones tiene TTLock. No requiere que el huésped pase
// la tarjeta de nuevo: se hace vía API con el UID ya guardado (zktecoCardBe).
// No exige email ni saldo cero (a diferencia de /generate) — reenrolar una
// tarjeta que YA estaba dada no es "entregar" nada nuevo, solo mantiene vigente
// lo que ya tenía.
app.post('/reenroll-card/:id', async (c) => {
  try {
    if (!await isConfigured()) return c.json({ error: 'TTLock no configurado' }, 503)

    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true },
    })
    if (!res) return notFound(c, 'Reserva')
    if (!res.zktecoCardBe) return c.json({ data: { attempted: false, ok: true } })

    const primaryRoom  = res.room as any
    const extraRoomIds = (res.extraRoomIds ?? []) as number[]
    const lockRooms    = await roomsWithLock(primaryRoom, extraRoomIds)
    if (!lockRooms.length) return c.json({ data: { attempted: false, ok: true } })

    const startMs = Date.now()
    const endMs   = await propertyMs(res.checkOutDate, 12)
    if (endMs <= startMs) return c.json({ error: 'La reserva ya ha terminado — no se puede re-enrolar la tarjeta' }, 422)

    const result = await reenrollCard(
      { id: res.id, zktecoCardBe: res.zktecoCardBe, ttlockCardIds: (res as any).ttlockCardIds, zktecoExtraCards: (res as any).zktecoExtraCards ?? null, guest: res.guest },
      lockRooms, startMs, endMs,
    )
    return c.json({ data: result })
  } catch (err) { return serverError(c, err) }
})

// POST /api/ttlock/revoke/:reservationId
// Elimina el código (checkout anticipado, cancelación)
app.post('/revoke/:id', async (c) => {
  try {
    if (!await isConfigured()) return c.json({ error: 'TTLock no configurado' }, 503)

    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { room: true },
    })
    if (!res) return notFound(c, 'Reserva')

    const existingCodes = parseStoredCodes(res.ttlockCode, res.ttlockCodeId, res.room as any)
    await Promise.allSettled(existingCodes.map(e => deletePasscode(e.lockId, e.pwdId).catch(() => {})))

    const existingCards = parseStoredCards((res as any).ttlockCardIds)
    await Promise.allSettled(existingCards.map(e => deleteCard(e.lockId, e.cardId).catch(() => {})))

    await db.update(reservations)
      .set({ ttlockCode: null, ttlockCodeId: null, ttlockCardIds: null, updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/ttlock/resend/:reservationId
// Reenvía el email con el código ya existente (sin regenerar)
app.post('/resend/:id', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true },
    })
    if (!res) return notFound(c, 'Reserva')
    if (!res.ttlockCode) return c.json({ error: 'No hay código generado aún' }, 400)
    if (!res.guest?.email) return c.json({ error: 'El huésped no tiene email' }, 400)

    if (!await isBalanceCheckExempt(res.bookingChannelId)) {
      const realPaidResend = (await realPaidByReservation([res.id])).get(res.id) ?? 0
      const dueResend = calcPendingBalance(res.total, realPaidResend)
      if (dueResend > 0.01) return c.json({ error: `No se puede reenviar el código: quedan ${dueResend.toFixed(2)} € pendientes de pago` }, 422)
    }
    if (!await channelEnabled('lock_code', 'email', res.bookingChannelId)) return c.json({ error: 'El envío del código por email está deshabilitado para este mensaje o canal (Ajustes → Mensajes)' }, 422)

    const guestName = `${res.guest.firstName} ${res.guest.lastName}`
    const entries   = parseStoredCodes(res.ttlockCode, res.ttlockCodeId, res.room as any)

    for (const e of entries) {
      await sendLockCode({
        to:        res.guest.email,
        guestName,
        roomCode:  e.room,
        code:      e.code + '#',
        checkIn:   res.checkInDate,
        checkOut:  res.checkOutDate,
      })
    }

    await db.update(reservations)
      .set({ ttlockSentAt: new Date(), updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ data: { sentTo: res.guest.email, count: entries.length } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/ttlock/whatsapp/:reservationId
// Envía el código YA existente por WhatsApp — misma regla: solo con saldo cero
app.post('/whatsapp/:id', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
      with:  { guest: true, room: true },
    })
    if (!res) return notFound(c, 'Reserva')
    if (!res.ttlockCode) return c.json({ error: 'No hay código generado aún' }, 400)
    if (!res.guest?.phone) return c.json({ error: 'El huésped no tiene teléfono' }, 422)

    if (!await isBalanceCheckExempt(res.bookingChannelId)) {
      const realPaidWa = (await realPaidByReservation([res.id])).get(res.id) ?? 0
      const due = calcPendingBalance(res.total, realPaidWa)
      if (due > 0.01) return c.json({ error: `No se puede enviar el código: quedan ${due.toFixed(2)} € pendientes de pago` }, 422)
    }
    if (!await channelEnabled('lock_code', 'whatsapp', res.bookingChannelId)) return c.json({ error: 'El envío del código por WhatsApp está deshabilitado para este mensaje o canal (Ajustes → Mensajes)' }, 422)

    const fmtD = (iso: string) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}` }
    const entries = parseStoredCodes(res.ttlockCode, res.ttlockCodeId, res.room as any)

    for (const e of entries) {
      const r = await sendWhatsappTemplate({
        to: res.guest.phone!, template: 'codigo',
        params: [
          res.guest.firstName,
          e.room,
          e.code + '#',
          fmtD(res.checkInDate),
          fmtD(res.checkOutDate),
        ],
      })
      if (!r.ok) return c.json({ error: r.error }, 502)
    }

    return c.json({ data: { sent: true, count: entries.length } })
  } catch (err) { return serverError(c, err) }
})

export default app
