// Helpers compartidos entre pricingRulesEngine.ts y jumbo-push.ts. Viven en su
// propio módulo (en vez de vivir solo en pricingRulesEngine.ts y que
// jumbo-push.ts los importara de ahí) para evitar un import circular: la
// pasada del motor de reglas necesita llamar a syncJumboPrices() (en
// jumbo-push.ts) al final de cada pasada, y jumbo-push.ts necesita estas
// funciones.
//
// "Tarifa raíz" = la tarifa de la que derivan las demás y sobre la que actúa el
// motor de reglas dinámicas. Se lee de getSetting('pricing.rootRateId'); si el
// setting falta se deduce: la tarifa activa del tenant que no deriva de otra
// (baseRateId null). Si hay varias candidatas es ambiguo y se lanza un error
// claro pidiendo configurar el setting.
import { db } from '../db'
import { rates } from '../db/schema'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { getPropertyId, getSetting } from './property'

export function applyAdjust(base: number, adjustType: string, adjustValue: number, direction: 1 | -1): number {
  const raw = adjustType === 'fixed'
    ? base + direction * adjustValue
    : base * (1 + direction * adjustValue / 100)
  return Math.max(0, Math.round(raw * 100) / 100)
}

/** Id de la tarifa raíz del tenant actual, o null si no hay ninguna. */
export async function getRootRateId(): Promise<number | null> {
  const pid = getPropertyId()
  const configured = await getSetting<number | string>('pricing.rootRateId')
  if (configured != null && configured !== '') {
    const id = Number(configured)
    const [row] = Number.isFinite(id)
      ? await db.select({ id: rates.id }).from(rates)
          .where(and(eq(rates.id, id), eq(rates.propertyId, pid))).limit(1)
      : []
    if (!row) throw new Error(`pricing.rootRateId=${configured} no corresponde a ninguna tarifa de este hotel`)
    return row.id
  }
  const candidates = await db.select({ id: rates.id, title: rates.title }).from(rates)
    .where(and(eq(rates.propertyId, pid), eq(rates.active, true), isNull(rates.baseRateId)))
    .orderBy(asc(rates.id))
  if (candidates.length === 0) return null
  if (candidates.length > 1) {
    throw new Error(
      `Tarifa raíz ambigua: hay ${candidates.length} tarifas activas sin tarifa base ` +
      `(${candidates.map(c => `#${c.id} ${c.title}`).join(', ')}). Define el ajuste pricing.rootRateId.`,
    )
  }
  return candidates[0]!.id
}

/** Alias histórico (antes 'Dir AL'). */
export const getDirALRateId = getRootRateId
