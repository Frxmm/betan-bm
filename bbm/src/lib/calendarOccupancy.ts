// ─── Ocupación "de calendario" — misma cuenta que la fila resumen de Precios ──
// Distinta de computeOccupancyReport (Informes → Ocupación): esta cuenta
// habitaciones físicas DISTINTAS (principal + extra_room_ids) igual que la
// fila resumen de PriceCalendarView (buildSummaryRow) y el resto de sitios
// que gestionan disponibilidad real (fdm.ts, housekeeping.ts, catalog.ts):
//   - Incluye TODOS los estados de reserva salvo cancelled/no_show (o sea,
//     también tentative del motor de reservas, arriving, checking_out...).
//   - Cuenta las habitaciones bloqueadas (blocked_beds) como no disponibles.
//   - Respeta los overrides manuales de disponibilidad (room_avail_overrides)
//     — SUSTITUYEN el cálculo para ese tipo/fecha, no son un tope.
// El motor de reglas de precio dinámico (pricingRulesEngine.ts) usa ESTA
// definición para que "ocupación" signifique lo mismo que ve el usuario en
// la fila de arriba del calendario de precios, no un número distinto que
// solo sale en Informes.
import { db } from '../db'
import { sql } from 'drizzle-orm'
import { getPropertyId } from './property'

// Habitaciones LIBRES (no %) por fecha con la misma cuenta — para alertas de
// "quedan N habitaciones". Devuelve también el total de habitaciones activas.
export async function computeCalendarAvailability(from: string, to: string): Promise<{ totalRooms: number; freeByDate: Map<string, number> }> {
  const pid = getPropertyId()
  const roomTotalsRaw = await db.execute(sql`
    SELECT room_type_id, COUNT(*)::int AS total
    FROM rooms
    WHERE active = true AND property_id = ${pid}
    GROUP BY room_type_id
  `) as unknown as { room_type_id: number; total: number }[]
  const totalByType: Record<number, number> = {}
  let totalRooms = 0
  for (const r of roomTotalsRaw) { totalByType[r.room_type_id] = r.total; totalRooms += r.total }

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
      WHERE r.property_id = ${pid}
        AND r.room_id IS NOT NULL
        AND r.status NOT IN ('cancelled', 'no_show')
        AND r.check_in_date  <= d.date AND r.check_out_date > d.date
      UNION
      SELECT ro2.room_type_id, d.date::text AS date, eid::int AS room_id
      FROM reservations r
      CROSS JOIN jsonb_array_elements_text(r.extra_room_ids) eid
      JOIN rooms ro2 ON ro2.id = eid::int
      CROSS JOIN dr d
      WHERE r.property_id = ${pid}
        AND r.status NOT IN ('cancelled', 'no_show')
        AND r.check_in_date  <= d.date AND r.check_out_date > d.date
      UNION
      SELECT bb.room_type_id, bb.block_date::text AS date, bb.room_id
      FROM blocked_beds bb
      WHERE bb.property_id = ${pid}
        AND bb.block_date BETWEEN ${from}::date AND ${to}::date
    ) sub
    GROUP BY room_type_id, date
  `) as unknown as { room_type_id: number; date: string; occupied: number }[]
  const occByTypeDate = new Map<string, number>()
  for (const r of occupiedRaw) occByTypeDate.set(`${r.room_type_id}|${r.date}`, r.occupied)

  const overridesRaw = await db.execute(sql`
    SELECT room_type_id, date::text AS date, max_avail
    FROM room_avail_overrides
    WHERE property_id = ${pid} AND date BETWEEN ${from}::date AND ${to}::date
  `) as unknown as { room_type_id: number; date: string; max_avail: number }[]
  const overrideByTypeDate = new Map<string, number>()
  for (const r of overridesRaw) overrideByTypeDate.set(`${r.room_type_id}|${r.date}`, r.max_avail)

  const roomTypeIds = Object.keys(totalByType).map(Number)
  const freeByDate = new Map<string, number>()
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10)
    let avail = 0
    for (const roomTypeId of roomTypeIds) {
      const total    = totalByType[roomTypeId] ?? 0
      const override = overrideByTypeDate.get(`${roomTypeId}|${date}`)
      const occupied = occByTypeDate.get(`${roomTypeId}|${date}`) ?? 0
      avail += override !== undefined ? Math.max(0, override) : Math.max(0, total - occupied)
    }
    freeByDate.set(date, avail)
  }
  return { totalRooms, freeByDate }
}

export async function computeCalendarOccupancyPct(from: string, to: string): Promise<Map<string, number>> {
  const { totalRooms, freeByDate } = await computeCalendarAvailability(from, to)
  const result = new Map<string, number>()
  for (const [date, avail] of freeByDate) result.set(date, totalRooms > 0 ? Math.round((1 - avail / totalRooms) * 100) : 0)
  return result
}
