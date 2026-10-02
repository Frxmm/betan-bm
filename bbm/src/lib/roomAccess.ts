// ─── Acceso por QR de habitación ────────────────────────────────────────────
// El QR de cada habitación lleva un token opaco (rooms.qrToken), no el id de
// la habitación — evita que se puedan adivinar URLs de otras habitaciones sin
// escanear el QR físico. Ver src/routes/room-access.ts.
import { db } from '../db'
import { reservations, rooms } from '../db/schema'
import { and, eq, or, sql } from 'drizzle-orm'
import { getPropertyId } from './property'
import crypto from 'crypto'

// "Huésped actual" de una habitación: reserva en curso (ya ha hecho check-in
// y todavía no ha salido), en la habitación principal o en una de sus
// habitaciones adicionales. Si hubiera más de una (no debería, salvo datos
// corruptos), se queda con la más reciente.
export async function findCurrentReservationForRoom(roomId: number) {
  return db.query.reservations.findFirst({
    where: (r, { and, eq, inArray }) => and(
      eq(r.propertyId, getPropertyId()),
      inArray(r.status, ['checked_in', 'checking_out']),
      or(eq(r.roomId, roomId), sql`${r.extraRoomIds} @> ${JSON.stringify([roomId])}::jsonb`),
    ),
    orderBy: (r, { desc }) => desc(r.checkInDate),
    with: { guest: true },
  })
}

export async function ensureRoomQrToken(roomId: number): Promise<string> {
  const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, roomId), eq(rooms.propertyId, getPropertyId())), columns: { qrToken: true } })
  if (room?.qrToken) return room.qrToken
  const token = crypto.randomBytes(24).toString('base64url')
  await db.update(rooms).set({ qrToken: token }).where(and(eq(rooms.id, roomId), eq(rooms.propertyId, getPropertyId())))
  return token
}

// Normaliza apellidos para comparar sin distinguir mayúsculas/acentos (mismo
// criterio ya usado en src/routes/customer.ts para nombres de municipio).
export function normalizeName(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// Límite de intentos de apellido por token de habitación — evita fuerza
// bruta sobre apellidos comunes. En memoria: basta con reiniciar el proceso
// para limpiarlo, y no necesitamos que sobreviva a un despliegue.
const attempts = new Map<string, { count: number; resetAt: number }>()
const MAX_ATTEMPTS = 5
const WINDOW_MS = 10 * 60 * 1000

export function isRateLimited(token: string): boolean {
  const now = Date.now()
  const a = attempts.get(token)
  if (!a || now > a.resetAt) return false
  return a.count >= MAX_ATTEMPTS
}

export function registerFailedAttempt(token: string) {
  const now = Date.now()
  const a = attempts.get(token)
  if (!a || now > a.resetAt) { attempts.set(token, { count: 1, resetAt: now + WINDOW_MS }); return }
  a.count++
}

export function clearAttempts(token: string) {
  attempts.delete(token)
}
