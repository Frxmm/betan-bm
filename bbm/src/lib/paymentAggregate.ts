// ─── "Total pagado real" de una reserva ────────────────────────────────────────
// El campo reservations.amountPaid es una caché de SUM(amount) de TODAS sus
// financial_transactions — incluye depósitos (paymentMethod 'deposit'/
// 'deposit_cc') mientras siguen retenidos, sin cobrar todavía. Un depósito NO
// es dinero de la habitación: no debe reducir el saldo pendiente de la
// estancia hasta que se "cobra" de verdad (category → 'deposit_cobrado', ver
// POST /financial/transactions/:id/cobrar) o se ha devuelto sin más efecto en
// el balance. Mismo criterio que ya usaba la pestaña Facturas de
// ReservationDetailView (POST /invoices/from-reservation) — aquí se comparte
// para reutilizarlo también en los listados (Reservas, Llegadas, Salidas,
// recientes, facturación) y así no repetir el criterio con matices distintos.
import { db } from '../db'
import { financialTransactions } from '../db/schema'
import { inArray, sql } from 'drizzle-orm'

// Fragmento SQL reutilizable: pagos reales excluyendo depósitos aún no cobrados.
export const REAL_PAID_SQL = sql<string>`COALESCE(SUM(amount) FILTER (WHERE payment_method NOT IN ('deposit','deposit_cc')), 0)
  + COALESCE(SUM(amount) FILTER (WHERE category = 'deposit_cobrado'), 0)`

// Batched: total pagado real por reserva, para listados con varias reservas a la vez.
export async function realPaidByReservation(reservationIds: number[]): Promise<Map<number, number>> {
  const map = new Map<number, number>()
  if (!reservationIds.length) return map
  const rows = await db.select({
    reservationId: financialTransactions.reservationId,
    paid: REAL_PAID_SQL,
  })
    .from(financialTransactions)
    .where(inArray(financialTransactions.reservationId, reservationIds))
    .groupBy(financialTransactions.reservationId)
  for (const r of rows) {
    if (r.reservationId != null) map.set(r.reservationId, parseFloat(r.paid ?? '0'))
  }
  return map
}

// Saldo pendiente real de una reserva ya cargada (total + pagos reales ya resueltos).
export function pendingBalance(total: string | number | null, realPaid: number): number {
  return Math.max(0, Math.round((parseFloat(String(total ?? '0')) - realPaid) * 100) / 100)
}

// Símbolo para mostrar importes en mensajes/alertas según la moneda del tenant
// (properties.currencyCode). Si no se conoce, se muestra el propio código ISO.
const CURRENCY_SYMBOLS: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CHF: 'CHF', MXN: '$', COP: '$', ARS: '$', CLP: '$', BRL: 'R$', JPY: '¥',
}
export function currencySymbol(code: string | null | undefined): string {
  const c = (code ?? '').toUpperCase()
  return CURRENCY_SYMBOLS[c] ?? (c || '€')
}
