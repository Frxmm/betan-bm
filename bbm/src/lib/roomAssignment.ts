// ─── Asignación de habitaciones para una reserva multi-habitación pública ──
// Usado al confirmar el pago de una reserva del motor de reservas público
// (src/routes/public.ts: webhook de Stripe y el fallback GET /booking/confirm)
// que puede llevar varias habitaciones (carrito) — sustituye la consulta que
// antes estaba duplicada en los dos sitios y solo sabía pedir 1 habitación de
// 1 tipo.
//
// Deliberadamente NO usa hasRoomOverlap/findFreeRoomOfType (src/routes/
// reservations.ts, src/lib/roomTypeAvailability.ts): esas solo miran
// reservations.room_id, no extra_room_ids — dejarían asignar una habitación
// que ya es la "habitación extra" de otra reserva. Esta función replica la
// misma exclusión que ya usaba la SQL duplicada (room_id + extra_room_ids +
// blocked_beds), pero devolviendo hasta N habitaciones por tipo en vez de 1.
import { db } from '../db'
import { sql } from 'drizzle-orm'

export type CartLine = { roomTypeId: number; quantity: number }

// Por cada línea del carrito (agrupando por roomTypeId si el carrito tiene
// dos líneas del mismo tipo con tarifas distintas), busca hasta `quantity`
// habitaciones libres de ese tipo. Devuelve los ids encontrados en el mismo
// orden que las líneas de entrada — puede venir más corto que la suma de
// cantidades pedidas si no quedan suficientes habitaciones libres (pago ya
// hecho, sin habitación: mismo hueco que ya existía antes con 1 habitación,
// solo que ahora a más escala — no se corrige aquí).
export async function assignRoomsForCart(
  cart: CartLine[], checkIn: string, checkOut: string, propertyId: number,
): Promise<number[]> {
  const byType = new Map<number, number>()
  for (const line of cart) byType.set(line.roomTypeId, (byType.get(line.roomTypeId) ?? 0) + line.quantity)

  const chosen: number[] = []
  for (const [roomTypeId, quantity] of byType) {
    // chosen ya elegidos en una vuelta anterior de este mismo bucle — para
    // que dos líneas del carrito no se lleven la misma habitación antes de
    // que ninguna de las dos quede guardada en la reserva todavía.
    const excludeChosen = chosen.length > 0 ? sql`AND r.id NOT IN ${chosen}` : sql``
    const rows = await db.execute(sql`
      SELECT r.id FROM rooms r
      WHERE r.room_type_id = ${roomTypeId} AND r.property_id = ${propertyId} AND r.active = true
        ${excludeChosen}
        AND r.id NOT IN (
          SELECT COALESCE(room_id, 0) FROM reservations
          WHERE property_id = ${propertyId} AND room_id IS NOT NULL
            AND status NOT IN ('cancelled','no_show','tentative')
            AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
        )
        AND r.id NOT IN (
          SELECT jsonb_array_elements_text(extra_room_ids)::int FROM reservations
          WHERE property_id = ${propertyId} AND extra_room_ids IS NOT NULL
            AND status NOT IN ('cancelled','no_show','tentative')
            AND check_in_date < ${checkOut}::date AND check_out_date > ${checkIn}::date
        )
        AND r.id NOT IN (
          SELECT bb.room_id FROM blocked_beds bb
          WHERE bb.property_id = ${propertyId}
            AND bb.block_date >= ${checkIn}::date AND bb.block_date < ${checkOut}::date
        )
      LIMIT ${quantity}
    `) as unknown as { id: number }[]
    for (const r of rows) chosen.push(r.id)
  }

  return chosen
}
