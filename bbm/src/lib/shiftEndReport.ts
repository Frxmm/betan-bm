// Resumen de desempeño de un turno de recepción, generado ~15 min antes de
// que acabe (ver src/routes/alerts.ts, que ya lee /api/turnos de
// el sistema de piscina/mantenimiento para la detección de cambio de turno y reutiliza
// esos mismos datos aquí). Se persiste en shift_end_reports (una fila por
// empleado+turno, ver drizzle/0141_shift_end_reports.sql) para que Dirección
// lo pueda ver en Implicación, no solo como aviso puntual al empleado.
import { db } from '../db'
import { reservations, rooms, reservationNotes, reservationSaleItems, financialTransactions, alertEvents } from '../db/schema'
import { and, eq, gte, lte, inArray, ne } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { realPaidByReservation, pendingBalance } from './paymentAggregate'
import { getPropertyId, getBranding, hasFeature } from './property'

export interface CheckinEntry {
  roomCode: string
  at: string
  sesOk: boolean
  zktecoOk: boolean
  paymentOk: boolean
}

export interface CheckoutEntry {
  roomCode: string
  at: string
  hadDeposit: boolean
  depositCharged: boolean
}

export interface ShiftEndBreakdown {
  checkins: CheckinEntry[]
  checkouts: CheckoutEntry[]
  abandonedCartCalls: number
  alertsCount: number
  extrasCount: number
  alertsResolvedCount: number
  avgCheckinSeconds: number | null
  allCheckoutsBefore1230: boolean | null  // null = no hubo check-outts, no aplica
  points: {
    checkins: number
    abandonedCarts: number
    alerts: number
    alertsResolved: number
    deposits: number
    checkinSpeed: number
    checkoutTiming: number
    extras: number
  }
  total: number
}

const CHECKIN_MIN_SECONDS = 10   // mismo filtro de outliers que GET /api/reports/checkin-time
const CHECKIN_MAX_SECONDS = 2400

// Comentario + emoticono del resumen de fin de turno, según la puntuación total.
export function shiftCommentary(total: number): { emoji: string; text: string } {
  if (total < 0)  return { emoji: '⚠️', text: 'Esto le va a generar a Dirección un trabajo de revisión extra.' }
  if (total === 0) return { emoji: '😐', text: 'No ha sido un buen turno.' }
  if (total <= 3)  return { emoji: '🙂', text: 'Gracias por el compromiso.' }
  return { emoji: '🤩', text: '¡Espectacular implicación hoy!' }
}

export async function computeShiftEndReport(userId: number, shiftStart: Date, shiftEnd: Date): Promise<ShiftEndBreakdown> {
  // ── Check-ins hechos por este usuario en el turno ─────────────────────────
  const checkinRows = await db.query.reservations.findMany({
    where: and(
      eq(reservations.propertyId, getPropertyId()),
      eq(reservations.checkedInBy, userId),
      gte(reservations.checkedInAt, shiftStart),
      lte(reservations.checkedInAt, shiftEnd),
    ),
    with: { room: { columns: { code: true } } },
    columns: { id: true, checkedInAt: true, checkinStartedAt: true, checkinSesSent: true, checkinZktecoEnrolled: true, total: true },
  })

  // Solo penaliza pasos de check-in de módulos que el tenant tiene activos.
  const [sesOn, zktecoOn] = await Promise.all([hasFeature('ses'), hasFeature('zkteco')])
  const paidByRes = await realPaidByReservation(checkinRows.map(r => r.id))
  const checkins: CheckinEntry[] = []
  let checkinPoints = 0
  const durations: number[] = []
  for (const r of checkinRows) {
    const sesOk    = !!r.checkinSesSent
    const zktecoOk = !!r.checkinZktecoEnrolled
    const due      = pendingBalance(r.total, paidByRes.get(r.id) ?? 0)
    const paymentOk = due <= 0.10
    checkins.push({
      roomCode: (r.room as any)?.code ?? '?',
      at: r.checkedInAt!.toISOString(),
      sesOk, zktecoOk, paymentOk,
    })
    if (sesOn && !sesOk) checkinPoints -= 1
    if (zktecoOn && !zktecoOk) checkinPoints -= 1
    if (!paymentOk) checkinPoints -= 2
    if (r.checkinStartedAt && r.checkedInAt) {
      const secs = (r.checkedInAt.getTime() - r.checkinStartedAt.getTime()) / 1000
      if (secs >= CHECKIN_MIN_SECONDS && secs <= CHECKIN_MAX_SECONDS) durations.push(secs)
    }
  }
  const avgCheckinSeconds  = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  const checkinSpeedPoints = avgCheckinSeconds !== null && avgCheckinSeconds <= 90 ? 2 : 0

  // ── Check-outs hechos por este usuario — no hay checkedOutBy en
  // reservations, se lee de reservation_status_logs (sin tabla Drizzle,
  // mismo patrón que src/lib/statusLog.ts) ─────────────────────────────────
  // shiftStart/shiftEnd van como ISO string, no como Date tal cual — un Date
  // directo en una plantilla sql cruda de Drizzle revienta con
  // INVALID_ARG_TYPE (mismo bug que tenía src/routes/alerts.ts al guardar el
  // resumen, encontrado al depurar por qué nunca se generaba ninguno).
  const checkoutRows = await db.execute(sql`
    SELECT rsl.reservation_id AS reservation_id, rsl.changed_at AS changed_at, rm.code AS room_code
    FROM reservation_status_logs rsl
    JOIN reservations r ON r.id = rsl.reservation_id
    LEFT JOIN rooms rm ON rm.id = r.room_id
    WHERE r.property_id = ${getPropertyId()} AND rsl.to_status = 'checked_out' AND rsl.user_id = ${userId}
      AND rsl.changed_at >= ${shiftStart.toISOString()} AND rsl.changed_at <= ${shiftEnd.toISOString()}
  `) as unknown as { reservation_id: number; changed_at: string; room_code: string | null }[]

  const checkoutResIds = checkoutRows.map(r => r.reservation_id)
  const depositByRes = new Map<number, { had: boolean; charged: boolean }>()
  if (checkoutResIds.length > 0) {
    const depositRows = await db.select({ reservationId: financialTransactions.reservationId, category: financialTransactions.category })
      .from(financialTransactions)
      .where(and(
        eq(financialTransactions.propertyId, getPropertyId()),
        inArray(financialTransactions.reservationId, checkoutResIds),
        inArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
      ))
    for (const d of depositRows) {
      if (d.reservationId == null) continue
      const cur = depositByRes.get(d.reservationId) ?? { had: false, charged: false }
      cur.had = true
      if (d.category === 'deposit_cobrado') cur.charged = true
      depositByRes.set(d.reservationId, cur)
    }
  }

  const checkouts: CheckoutEntry[] = []
  let depositPoints = 0
  let allBefore1230: boolean | null = null
  const tz = (await getBranding()).timezone
  const madridHourMin = (d: Date) => {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d)
    const h = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
    const m = Number(parts.find(p => p.type === 'minute')?.value ?? '0')
    return { h, m }
  }
  for (const r of checkoutRows) {
    const dep = depositByRes.get(r.reservation_id) ?? { had: false, charged: false }
    const at  = new Date(r.changed_at)
    checkouts.push({ roomCode: r.room_code ?? '?', at: at.toISOString(), hadDeposit: dep.had, depositCharged: dep.charged })
    if (dep.charged) depositPoints += 2
    const { h, m } = madridHourMin(at)
    const before1230 = h < 12 || (h === 12 && m <= 30)
    allBefore1230 = allBefore1230 === null ? before1230 : (allBefore1230 && before1230)
  }
  const checkoutTimingPoints = allBefore1230 === true ? 1 : 0

  // ── Llamadas a carritos abandonados marcadas por este usuario ─────────────
  const cartCallRows = await db.select({ id: reservationNotes.id }).from(reservationNotes)
    .where(and(
      eq(reservationNotes.type, 'abandoned_cart_called'),
      eq(reservationNotes.authorId, userId),
      gte(reservationNotes.createdAt, shiftStart),
      lte(reservationNotes.createdAt, shiftEnd),
    ))
  const abandonedCartCalls   = cartCallRows.length
  const abandonedCartPoints  = abandonedCartCalls

  // ── Alertas activadas durante el turno (ambiente general, no atribuidas
  // a este empleado en concreto — mismo criterio que GET /alerts/employee-report) ──
  const alertRows = await db.select({ id: alertEvents.id }).from(alertEvents)
    .where(and(
      eq(alertEvents.propertyId, getPropertyId()),
      ne(alertEvents.severity, 'info'),
      gte(alertEvents.firstSeenAt, shiftStart),
      lte(alertEvents.firstSeenAt, shiftEnd),
    ))
  const alertsCount  = alertRows.length
  const alertsPoints = alertsCount === 0 ? 0 : alertsCount === 1 ? -1 : alertsCount === 2 ? -2 : -3

  // ── Ventas de extras hechas por este usuario ──────────────────────────────
  const extrasRows = await db.select({ id: reservationSaleItems.id }).from(reservationSaleItems)
    .where(and(
      eq(reservationSaleItems.createdBy, userId),
      gte(reservationSaleItems.createdAt, shiftStart),
      lte(reservationSaleItems.createdAt, shiftEnd),
    ))
  const extrasCount  = extrasRows.length
  const extrasPoints = extrasCount >= 1 ? 2 : 0

  // ── Alertas ROJAS (urgent) resueltas por este usuario que NO se generaron
  // en este turno (firstSeenAt anterior al inicio del turno — ya venían de
  // antes, no es solo "hacer su trabajo normal") — solo cuentan las resueltas
  // con una acción explícita identificable (resolvedBy), ver
  // src/routes/alerts.ts (manual/:id/resolve, no-show-confirm/:id); las que
  // se resuelven solas al dejar de cumplirse la condición no tienen a quién
  // atribuírselas.
  const alertsResolvedRows = await db.select({ id: alertEvents.id }).from(alertEvents)
    .where(and(
      eq(alertEvents.propertyId, getPropertyId()),
      eq(alertEvents.severity, 'urgent'),
      eq(alertEvents.resolvedBy, userId),
      gte(alertEvents.resolvedAt, shiftStart),
      lte(alertEvents.resolvedAt, shiftEnd),
      lte(alertEvents.firstSeenAt, shiftStart),
    ))
  const alertsResolvedCount  = alertsResolvedRows.length
  const alertsResolvedPoints = alertsResolvedCount

  const points = {
    checkins:       checkinPoints,
    abandonedCarts: abandonedCartPoints,
    alerts:         alertsPoints,
    alertsResolved: alertsResolvedPoints,
    deposits:       depositPoints,
    checkinSpeed:   checkinSpeedPoints,
    checkoutTiming: checkoutTimingPoints,
    extras:         extrasPoints,
  }
  const total = Object.values(points).reduce((a, b) => a + b, 0)

  return {
    checkins, checkouts, abandonedCartCalls, alertsCount, extrasCount, alertsResolvedCount,
    avgCheckinSeconds, allCheckoutsBefore1230: allBefore1230,
    points, total,
  }
}
