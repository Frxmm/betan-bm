import { db } from '../db'
import { sql } from 'drizzle-orm'

export async function logStatusChange(
  reservationId: number,
  fromStatus: string | null,
  toStatus: string,
  source: string,
  userId?: number | null,
): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO reservation_status_logs (reservation_id, from_status, to_status, source, user_id)
      VALUES (${reservationId}, ${fromStatus ?? null}, ${toStatus}, ${source}, ${userId ?? null})
    `)
  } catch (e) {
    // No interrumpir el flujo principal si el log falla
    console.error('[statusLog]', e)
  }
}
