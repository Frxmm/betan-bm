// Muestra qué habitaciones aparecerán en housekeeping para una fecha dada,
// aplicando exactamente la misma lógica que el backend (sin escribir en BD).
//
// Uso:
//   bun scripts/test-housekeeping.ts --tenant=<slug>   — hoy
//   bun scripts/test-housekeeping.ts 2026-07-05   — fecha concreta

import { db } from '../src/db'
import { reservations } from '../src/db/schema'
import { and, or, lt, gt, eq, inArray } from 'drizzle-orm'

import { resolveTenant, argsWithoutTenant } from './lib/tenant'

const TENANT_ID = (await resolveTenant()).id   // --tenant=<slug>
const arg  = argsWithoutTenant()[0]
const date = arg ?? new Date().toISOString().slice(0, 10)

if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Formato de fecha inválido. Usa YYYY-MM-DD')
  process.exit(1)
}

console.log(`\nHousekeeping para: ${date}\n`)

// Misma query que el backend ─────────────────────────────────────────────────
const occupied = await db.query.reservations.findMany({
  where: and(
    eq(reservations.propertyId, TENANT_ID),
    or(
      and(lt(reservations.checkInDate, date), gt(reservations.checkOutDate, date)),
      eq(reservations.checkOutDate, date),
    ),
    inArray(reservations.status, ['checked_in', 'checking_out', 'checked_out']),
  ),
  with: { room: true, guest: true },
})

// Deduplicar por roomId — misma lógica que el backend
const roomMap = new Map<number, { roomId: number; roomCode: string; taskType: 'stay' | 'departure'; reservations: any[] }>()

for (const r of occupied) {
  if (!r.room) continue
  const type: 'stay' | 'departure' = r.checkOutDate === date ? 'departure' : 'stay'
  if (type === 'stay' && r.status !== 'checked_in') continue

  const existing = roomMap.get(r.roomId!)
  if (!existing || type === 'departure') {
    roomMap.set(r.roomId!, { roomId: r.roomId!, roomCode: (r.room as any).code, taskType: type, reservations: [r] })
  } else {
    existing.reservations.push(r)
  }
}

const stays      = [...roomMap.values()].filter(e => e.taskType === 'stay')
    .sort((a, b) => a.roomCode.localeCompare(b.roomCode, 'es', { numeric: true }))
const departures = [...roomMap.values()].filter(e => e.taskType === 'departure')
    .sort((a, b) => a.roomCode.localeCompare(b.roomCode, 'es', { numeric: true }))

// Reservas descartadas (tienen fechas pero no pasan los filtros de estado/tipo)
const discarded = occupied.filter(r => {
  const type: 'stay' | 'departure' = r.checkOutDate === date ? 'departure' : 'stay'
  if (type === 'stay' && r.status !== 'checked_in') return true
  return false
})

// Salida ─────────────────────────────────────────────────────────────────────
function guestName(r: any) {
  const g = r.guest
  return g ? `${g.firstName} ${g.lastName}` : '(sin huésped)'
}

console.log(`${'─'.repeat(56)}`)
console.log(`CLIENTES (checked_in, checkIn < ${date} < checkOut)   ${stays.length} hab.`)
console.log(`${'─'.repeat(56)}`)
if (stays.length === 0) {
  console.log('  (ninguna)')
} else {
  for (const e of stays) {
    const r = e.reservations[0]
    console.log(`  Hab. ${e.roomCode.padEnd(6)}  Res.#${String(r.id).padEnd(6)}  ${r.checkInDate} → ${r.checkOutDate}  [${r.status}]  ${guestName(r)}`)
  }
}

console.log()
console.log(`${'─'.repeat(56)}`)
console.log(`SALIDAS  (checkOut = ${date})                          ${departures.length} hab.`)
console.log(`${'─'.repeat(56)}`)
if (departures.length === 0) {
  console.log('  (ninguna)')
} else {
  for (const e of departures) {
    const r = e.reservations[0]
    console.log(`  Hab. ${e.roomCode.padEnd(6)}  Res.#${String(r.id).padEnd(6)}  ${r.checkInDate} → ${r.checkOutDate}  [${r.status}]  ${guestName(r)}`)
  }
}

if (discarded.length > 0) {
  console.log()
  console.log(`${'─'.repeat(56)}`)
  console.log(`DESCARTADAS (fechas coinciden pero no el estado)      ${discarded.length}`)
  console.log(`${'─'.repeat(56)}`)
  for (const r of discarded) {
    console.log(`  Hab. ${((r.room as any)?.code ?? '?').padEnd(6)}  Res.#${String(r.id).padEnd(6)}  ${r.checkInDate} → ${r.checkOutDate}  [${r.status}]  ${guestName(r)}`)
  }
}

console.log()
console.log(`Total housekeeping: ${roomMap.size} habitación(es)  (${stays.length} clientes + ${departures.length} salidas)`)
console.log()
process.exit(0)
