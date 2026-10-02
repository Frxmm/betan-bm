// Lista (solo lectura, no modifica nada) las reservas con habitación adicional
// (extra_room_ids) generadas por el bug de sync FDM que corregimos hoy en
// src/routes/fdm.ts: esa lógica (viva desde ayer hasta ahora) tomaba
// ReservationNights[0].Room de FDM y, si no coincidía con la habitación ya
// asignada, la añadía como "habitación adicional" — aunque casi siempre solo
// significaba que recepción había movido al huésped de habitación en FDM.
// Solo pudo ocurrir en reservas importadas de FDM (externalCode no nulo); la
// función manual "+ Hab." de la ficha de reserva usa el mismo campo pero no
// tiene este filtro, así que reservas 100% manuales (sin externalCode) NO
// pueden venir de este bug y se excluyen por defecto.
//
// Uso:
//   bun scripts/list-extra-rooms.ts
//   bun scripts/list-extra-rooms.ts --from=2026-08-01 --to=2026-08-31   (filtra por fecha de entrada)
//   bun scripts/list-extra-rooms.ts --all                               (incluye también las reservas manuales, sin externalCode)
//
// No actualiza nada en la base de datos.

import { db } from '../src/db'
import { reservations, rooms } from '../src/db/schema'
import { and, eq, gte, lte, sql, inArray, isNotNull } from 'drizzle-orm'
import { resolveTenant } from './lib/tenant'

// Uso: bun scripts/list-extra-rooms.ts --tenant=<slug> [--from= --to= --all]
const TENANT_ID = (await resolveTenant()).id

const argFrom = process.argv.find(a => a.startsWith('--from='))?.split('=')[1]
const argTo   = process.argv.find(a => a.startsWith('--to='))?.split('=')[1]
const argAll  = process.argv.includes('--all')

const conditions = [eq(reservations.propertyId, TENANT_ID), sql`jsonb_array_length(coalesce(${reservations.extraRoomIds}, '[]'::jsonb)) > 0`]
if (!argAll) conditions.push(isNotNull(reservations.externalCode))
if (argFrom) conditions.push(gte(reservations.checkInDate, argFrom))
if (argTo)   conditions.push(lte(reservations.checkInDate, argTo))

const list = await db.query.reservations.findMany({
  where: and(...conditions),
  with:  { guest: true, room: true, bookingChannel: true },
  orderBy: (r, { asc }) => asc(r.checkInDate),
})

if (list.length === 0) {
  const scope = argAll ? 'con habitaciones adicionales' : 'importadas con habitaciones adicionales'
  console.log(argFrom || argTo
    ? `Sin reservas ${scope} entre ${argFrom ?? '…'} y ${argTo ?? '…'}.`
    : `Sin reservas ${scope}.`)
  process.exit(0)
}

// Resolver códigos de las habitaciones extra
const extraIds = [...new Set(list.flatMap(r => (r.extraRoomIds ?? []) as number[]))]
const extraRoomList = extraIds.length > 0
  ? await db.select({ id: rooms.id, code: rooms.code }).from(rooms).where(inArray(rooms.id, extraIds))
  : []
const extraCodeById = new Map(extraRoomList.map(r => [r.id, r.code]))

const fmtD  = (iso: string | null) => iso ? iso : '—'
const fmtDT = (d: Date | string | null) => d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') : '—'

const rows = list.map(r => ({
  id:            r.id,
  código:        r.externalCode ?? '(manual)',
  huésped:       `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
  hab_principal: r.room?.code ?? '(sin asignar)',
  habs_extra:    ((r.extraRoomIds ?? []) as number[]).map(id => extraCodeById.get(id) ?? `#${id}`).join(', '),
  entrada:       fmtD(r.checkInDate),
  salida:        fmtD(r.checkOutDate),
  estado:        r.status,
  canal:         r.bookingChannel?.name ?? (r.externalCode ? 'FDM (sin canal mapeado)' : 'Directo'),
  actualizada:   fmtDT(r.updatedAt),
}))

console.table(rows)

console.log(`\nTotal: ${list.length} reserva(s)${argAll ? '' : ' importadas de FDM'} con habitación adicional${argFrom || argTo ? ` (entrada entre ${argFrom ?? '…'} y ${argTo ?? '…'})` : ''}.`)
if (!argAll) console.log(`(Se excluyen reservas 100% manuales, sin código externo — esas no pueden venir del bug de sync. Usa --all para verlas también.)`)
console.log(`\nEsto es solo revisión visual, no elimina nada. Para quitar una habitación adicional,`)
console.log(`entra en la ficha de la reserva (#id) y pulsa la ✕ junto a la habitación adicional.`)

process.exit(0)
