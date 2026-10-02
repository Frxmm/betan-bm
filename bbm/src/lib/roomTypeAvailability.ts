// ─── Disponibilidad de un TIPO de habitación (no de una habitación concreta) ──
// Usado por la ampliación de estancia (src/lib/stayExtension.ts, y la rama
// 'extend_stay' del webhook de Stripe en src/routes/public.ts): si la
// habitación física del huésped coincide con otra reserva en las noches de
// la ampliación, NO se bloquea mientras quede otra habitación LIBRE del
// mismo tipo — se avisa a dirección para que reubique a alguien (ver
// src/routes/alerts.ts, alerta 'extend-needs-relocation').
import { db } from '../db'
import { blockedBeds } from '../db/schema'
import { inArray, eq, and } from 'drizzle-orm'
import { getPropertyId } from './property'
import { hasRoomOverlap } from '../routes/reservations'

function addDaysISO(date: string, n: number) {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
function dateRangeISO(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d < to; d = addDaysISO(d, 1)) out.push(d)
  return out
}

// Primera habitación activa de ese tipo que esté libre (sin reserva
// solapada, ni bloqueada) en todo el rango [from, to). excludeReservationId
// para no descartar la propia reserva que se está ampliando.
export async function findFreeRoomOfType(
  roomTypeId: number, from: string, to: string, excludeReservationId?: number,
): Promise<{ id: number; code: string } | null> {
  const candidates = await db.query.rooms.findMany({
    where: (r, { eq: eqc, and: andc }) => andc(eqc(r.propertyId, getPropertyId()), eqc(r.roomTypeId, roomTypeId), eqc(r.active, true)),
    columns: { id: true, code: true },
  })
  const dates = dateRangeISO(from, to)
  if (dates.length === 0) return null

  for (const room of candidates) {
    const overlap = await hasRoomOverlap(room.id, from, to, excludeReservationId)
    if (overlap) continue
    const [blocked] = await db.select({ id: blockedBeds.id }).from(blockedBeds)
      .where(and(eq(blockedBeds.roomId, room.id), inArray(blockedBeds.blockDate, dates)))
      .limit(1)
    if (blocked) continue
    return room
  }
  return null
}
