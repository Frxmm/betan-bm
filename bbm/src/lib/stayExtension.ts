// ─── Cotización de ampliación de estancia (añadir noches al final) ────────────
// Compartido entre el portal por email (src/routes/customer.ts) y el acceso
// por QR de habitación (src/routes/room-access.ts) — misma lógica, dos formas
// de identificar al huésped. El check-out de la reserva NUNCA se cambia aquí
// — solo se cambia en el webhook de Stripe, tras confirmarse el cobro (ver
// POST /api/public/stripe/webhook, tipo 'extend_stay', en src/routes/public.ts).
import { db } from '../db'
import { reservations, rooms, rates, roomTypes, rateDailyPrices } from '../db/schema'
import { eq, and, gte, lte, inArray, not } from 'drizzle-orm'
import { hasRoomOverlap } from '../routes/reservations'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from './paymentAggregate'
import { resolvePrice, rateChainIds, type RateForPricing, type RoomTypeForPricing, type DailyPriceRow } from './price-resolver'
import { findFreeRoomOfType } from './roomTypeAvailability'
import { getPropertyId } from './property'

export const MAX_EXTEND_NIGHTS = 14

export function addDaysISO(date: string, n: number) {
  const d = new Date(date + 'T12:00:00'); d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}
export function dateRangeISO(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d < to; d = addDaysISO(d, 1)) out.push(d)
  return out
}

type ReservationRow = typeof reservations.$inferSelect

export type ExtensionQuote =
  | { error: string; status: 404 | 409 | 422 }
  | { res: ReservationRow; nights: number; newCheckOutDate: string; perNight: { date: string; price: number }[]; total: number }

// El llamador es responsable de haber verificado ya que `res` pertenece a
// quien pide la ampliación (por email en customer.ts, por token de
// habitación en room-access.ts) — esta función solo valida las reglas de
// negocio de la ampliación en sí.
export async function quoteExtensionForReservation(res: ReservationRow, nights: number): Promise<ExtensionQuote> {
  if (['cancelled', 'no_show', 'checked_out'].includes(res.status)) {
    return { error: 'Esta reserva ya no admite ampliaciones', status: 422 }
  }
  if (((res.extraRoomIds as number[] | null) ?? []).length > 0) {
    return { error: 'Esta reserva tiene habitaciones adicionales — contacta con recepción para ampliarla', status: 422 }
  }
  if (!res.roomId) return { error: 'Reserva sin habitación asignada', status: 422 }

  const realPaid = (await realPaidByReservation([res.id])).get(res.id) ?? 0
  if (calcPendingBalance(res.total, realPaid) > 0) {
    return { error: 'Tienes un saldo pendiente en tu reserva — salda tu saldo para poder ampliarla', status: 422 }
  }

  const newCheckOutDate = addDaysISO(res.checkOutDate, nights)

  const room = await db.query.rooms.findFirst({ where: and(eq(rooms.id, res.roomId), eq(rooms.propertyId, getPropertyId())), columns: { roomTypeId: true } })
  if (!room?.roomTypeId || !res.rateId) return { error: 'No se pudo calcular el precio de la ampliación', status: 422 }

  // La habitación concreta del huésped puede coincidir con otra reserva esas
  // noches (habitual: la siguiente reserva ya la tiene asignada) — eso NO
  // bloquea la ampliación mientras quede OTRA habitación libre del mismo
  // tipo; dirección la reubicará antes de esa fecha (ver el webhook de
  // Stripe, que aplica esto de verdad y avisa con una alerta).
  const specificRoomOverlap = await hasRoomOverlap(res.roomId, res.checkOutDate, newCheckOutDate, res.id)
  if (specificRoomOverlap) {
    const alt = await findFreeRoomOfType(room.roomTypeId, res.checkOutDate, newCheckOutDate, res.id)
    if (!alt) return { error: 'No hay disponibilidad para ampliar esas noches', status: 409 }
  }

  const rate = await db.query.rates.findFirst({ where: and(eq(rates.id, res.rateId), eq(rates.propertyId, getPropertyId())) })
  if (!rate) return { error: 'Tarifa no encontrada', status: 404 }

  const chainRates = await db.query.rates.findMany({ where: eq(rates.propertyId, getPropertyId()) })
  const ratesById: Map<number, RateForPricing> = new Map(chainRates.map(r => [r.id, r]))
  const chainRoomTypes = await db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, getPropertyId()) })
  const roomTypesById: Map<number, RoomTypeForPricing> = new Map(chainRoomTypes.map(rt => [rt.id, rt]))
  const rateIdsToCheck = rateChainIds(rate, ratesById)

  const dates = dateRangeISO(res.checkOutDate, newCheckOutDate)
  const priceRows: DailyPriceRow[] = await db.select().from(rateDailyPrices).where(and(
    eq(rateDailyPrices.propertyId, getPropertyId()),
    inArray(rateDailyPrices.rateId, rateIdsToCheck),
    gte(rateDailyPrices.date, res.checkOutDate),
    lte(rateDailyPrices.date, addDaysISO(newCheckOutDate, -1)),
    not(rateDailyPrices.closed),
  ))

  const occupancy = res.people ?? 1
  const perNight: { date: string; price: number }[] = []
  for (const d of dates) {
    const p = resolvePrice(ratesById, roomTypesById, priceRows, rate.id, room.roomTypeId, d, occupancy)
    if (p == null) return { error: `Sin precio disponible para el ${d}`, status: 422 }
    perNight.push({ date: d, price: p })
  }
  const total = perNight.reduce((s, p) => s + p.price, 0)

  return { res, nights, newCheckOutDate, perNight, total: Math.round(total * 100) / 100 }
}
