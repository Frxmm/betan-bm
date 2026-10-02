// ─── Resolución de precio compartida (tarifa derivada + tipo de habitación derivado) ──
// Usado tanto por el motor de reservas (src/routes/public.ts) como por el panel
// interno (src/routes/reservations.ts, calc-price) para que ambos calculen
// exactamente igual — antes esta lógica estaba duplicada y una de las dos copias
// se quedó atrás (bug de las tarifas derivadas de derivadas, "Jumbo").

export type RateForPricing = {
  id: number
  baseRateId:  number | null
  adjustType:  string | null
  adjustValue: string | null
}

export type RoomTypeForPricing = {
  id: number
  baseRoomTypeId: number | null
  adjustType:     string | null
  adjustValue:    string | null
}

export type DailyPriceRow = {
  rateId:     number
  roomTypeId: number | null
  date:       string
  price:      string
}

export function applyPriceAdjust(base: number, adjustType: string | null, adjustValue: string | null, occupancy = 1): number {
  const v = parseFloat(adjustValue ?? '0')
  if (adjustType === 'fixed')      return v
  if (adjustType === 'percentage') return Math.round(base * (1 + v / 100) * 100) / 100
  if (adjustType === 'amount')     return Math.round((base + v) * 100) / 100
  if (adjustType === 'per_person') return Math.round((base + v * occupancy) * 100) / 100
  return base
}

// Sube la cadena de derivación (tarifa←tarifa base, o tipo hab.←tipo hab. base)
// hasta 6 niveles, con protección ante ciclos. Sirve tanto para tarifas como
// para tipos de habitación — solo cambia de qué campo cuelga el "id base".
export function buildDerivationChain<T extends { id: number }>(
  start: T,
  byId: Map<number, T>,
  getBaseId: (t: T) => number | null,
  maxDepth = 6,
): T[] {
  const chain: T[] = [start]
  let cur = start
  while (chain.length < maxDepth) {
    const baseId = getBaseId(cur)
    if (!baseId) break
    const next = byId.get(baseId)
    if (!next || chain.some(c => c.id === next.id)) break
    chain.push(next)
    cur = next
  }
  return chain
}

function directPrice(priceRows: DailyPriceRow[], rateId: number, roomTypeId: number | null, date: string): number | null {
  const rows = priceRows.filter(p => p.rateId === rateId && p.date === date)
  if (roomTypeId != null) {
    const specific = rows.find(p => p.roomTypeId === roomTypeId)
    if (specific) return parseFloat(specific.price)
  }
  const generic  = rows.find(p => p.roomTypeId == null)
  return generic ? parseFloat(generic.price) : null
}

// Resuelve el precio de UNA tarifa para UN tipo de habitación concreto, siguiendo
// solo la cadena de TARIFA (rate.baseRateId) — sin derivar por tipo de habitación.
// roomTypeId puede ser null: sirve para resolver el precio RAÍZ de una tarifa
// (p.ej. JUMBO AL, una tarifa de un solo precio para todo el hotel, derivada de
// la tarifa raíz) sin necesidad de un tipo de habitación concreto — mira primero la fila
// propia de la tarifa (roomTypeId IS NULL, cubre una edición manual directa
// sobre ella) y si no hay, deriva de rate.baseRateId, ver src/lib/jumbo-push.ts.
export function resolveRateChainPrice(
  ratesById: Map<number, RateForPricing>,
  priceRows: DailyPriceRow[],
  rate: RateForPricing,
  roomTypeId: number | null,
  date: string,
  occupancy = 1,
  depth = 0,
): number | null {
  if (depth > 5) return null
  // Tarifa con precio fijo propio (sin tarifa base): no depende del mapa de precios
  if (!rate.baseRateId && rate.adjustType === 'fixed' && rate.adjustValue != null) {
    return parseFloat(rate.adjustValue)
  }
  const direct = directPrice(priceRows, rate.id, roomTypeId, date)
  if (direct != null) return direct
  if (rate.baseRateId) {
    const base = ratesById.get(rate.baseRateId)
    if (base) {
      const basePrice = resolveRateChainPrice(ratesById, priceRows, base, roomTypeId, date, occupancy, depth + 1)
      if (basePrice != null) return applyPriceAdjust(basePrice, rate.adjustType, rate.adjustValue, occupancy)
    }
  }
  return null
}

// Resuelve el precio de una tarifa para un tipo de habitación: primero agota la
// cadena de TARIFA para ese tipo de habitación exacto; si no hay nada, cae a la
// cadena de TIPO DE HABITACIÓN (mismo rate, tipo de habitación base) aplicando
// el ajuste %/€/fijo de ese tipo de habitación sobre el resultado ya resuelto.
export function resolvePrice(
  ratesById: Map<number, RateForPricing>,
  roomTypesById: Map<number, RoomTypeForPricing>,
  priceRows: DailyPriceRow[],
  rateId: number,
  roomTypeId: number,
  date: string,
  occupancy = 1,
  depth = 0,
): number | null {
  if (depth > 5) return null
  const rate     = ratesById.get(rateId)
  const roomType = roomTypesById.get(roomTypeId)
  if (!rate || !roomType) return null

  // Un tipo de habitación derivado (baseRoomTypeId) SIEMPRE se calcula desde el
  // tipo base — ignora cualquier precio propio que pudiera haber quedado
  // guardado para él (de antes de marcarlo como derivado, o por error). El
  // único tipo con precio propio editable es el que no deriva de ningún otro.
  if (roomType.baseRoomTypeId) {
    const basePrice = resolvePrice(ratesById, roomTypesById, priceRows, rateId, roomType.baseRoomTypeId, date, occupancy, depth + 1)
    if (basePrice != null) return applyPriceAdjust(basePrice, roomType.adjustType, roomType.adjustValue, occupancy)
    return null
  }

  return resolveRateChainPrice(ratesById, priceRows, rate, roomTypeId, date, occupancy)
}

// IDs de toda la cadena de derivación de tarifa a partir de una tarifa concreta
// (para saber qué rateIds pedir a la BD de una sola vez).
export function rateChainIds(rate: RateForPricing, ratesById: Map<number, RateForPricing>): number[] {
  return buildDerivationChain(rate, ratesById, r => r.baseRateId).map(r => r.id)
}

// IDs de toda la cadena de derivación de tipo de habitación a partir de uno concreto.
export function roomTypeChainIds(roomType: RoomTypeForPricing, roomTypesById: Map<number, RoomTypeForPricing>): number[] {
  return buildDerivationChain(roomType, roomTypesById, rt => rt.baseRoomTypeId).map(rt => rt.id)
}

// El precio más barato de `rate` entre los tipos de habitación a los que
// aplica (uno solo si rate.roomTypeId está fijado, todos los activos si no) —
// el mismo "desde X €" que ve un cliente nuevo en la web para esa tarifa.
// Compartido entre la comparativa de competidores (src/routes/competitors.ts)
// y el motor de reglas dinámicas (competitor_undercut, pricingRulesEngine.ts)
// para que ambos calculen "nuestro precio" exactamente igual.
export function cheapestForRate(
  ratesById: Map<number, RateForPricing>,
  roomTypesById: Map<number, RoomTypeForPricing>,
  priceRows: DailyPriceRow[],
  rate: RateForPricing & { roomTypeId?: number | null },
  allRoomTypes: (RoomTypeForPricing & { maxOccupancy?: number | null })[],
  date: string,
): { price: number; roomTypeId: number } | null {
  const targetTypes = rate.roomTypeId
    ? [roomTypesById.get(rate.roomTypeId)].filter(Boolean) as (RoomTypeForPricing & { maxOccupancy?: number | null })[]
    : allRoomTypes
  let best: { price: number; roomTypeId: number } | null = null
  for (const rt of targetTypes) {
    const occupancy = rt.maxOccupancy ?? 1
    const price = resolvePrice(ratesById, roomTypesById, priceRows, rate.id, rt.id, date, occupancy)
    if (price != null && (best == null || price < best.price)) best = { price, roomTypeId: rt.id }
  }
  return best
}

// Inversa de resolveRateChainPrice: dado el precio FINAL que queremos que
// resuelva `rate`, calcula qué precio haría falta en la tarifa RAÍZ (la que
// no tiene baseRateId) de su cadena de derivación para que, al aplicar todos
// los ajustes hacia abajo, el resultado sea ese precio deseado. Usado por
// competitor_undercut (pricingRulesEngine.ts) para traducir "queremos que la
// tarifa de referencia cueste X" a "hay que poner Y en la tarifa raíz". Devuelve null
// si algún eslabón es de tipo 'fixed' (no depende de la base — no invertible)
// o la cadena no encuentra alguna tarifa base.
export function invertRateChainToRoot(
  ratesById: Map<number, RateForPricing>,
  rate: RateForPricing,
  desiredPrice: number,
  occupancy = 1,
): { rootRateId: number; price: number } | null {
  let price = desiredPrice
  let cur   = rate
  let depth = 0
  while (cur.baseRateId) {
    if (depth++ > 5) return null
    const base = ratesById.get(cur.baseRateId)
    if (!base) return null
    const inverted = invertAdjust(price, cur.adjustType, cur.adjustValue, occupancy)
    if (inverted == null) return null
    price = inverted
    cur = base
  }
  return { rootRateId: cur.id, price: Math.round(price * 100) / 100 }
}

// Misma idea que invertRateChainToRoot pero para la cadena de derivación de
// TIPO DE HABITACIÓN (roomType.baseRoomTypeId) — hasta llegar al tipo base
// (el único con precio propio editable en rateDailyPrices).
export function invertRoomTypeChainToBase(
  roomTypesById: Map<number, RoomTypeForPricing>,
  roomType: RoomTypeForPricing,
  desiredPrice: number,
  occupancy = 1,
): { baseRoomTypeId: number; price: number } | null {
  let price = desiredPrice
  let cur   = roomType
  let depth = 0
  while (cur.baseRoomTypeId) {
    if (depth++ > 5) return null
    const base = roomTypesById.get(cur.baseRoomTypeId)
    if (!base) return null
    const inverted = invertAdjust(price, cur.adjustType, cur.adjustValue, occupancy)
    if (inverted == null) return null
    price = inverted
    cur = base
  }
  return { baseRoomTypeId: cur.id, price: Math.round(price * 100) / 100 }
}

// Inversa de applyPriceAdjust: dado el resultado, despeja la base. null si el
// ajuste es 'fixed' (el resultado no depende de la base, no se puede invertir).
function invertAdjust(result: number, adjustType: string | null, adjustValue: string | null, occupancy: number): number | null {
  const v = parseFloat(adjustValue ?? '0')
  if (adjustType === 'percentage') return v === -100 ? null : result / (1 + v / 100)
  if (adjustType === 'amount')     return result - v
  if (adjustType === 'per_person') return result - v * occupancy
  if (adjustType === 'fixed')      return null
  return result  // sin tipo de ajuste reconocido: passthrough, sin cambio
}
