// Edición masiva de los huéspedes ADICIONALES de una reserva:
//   1) --copy-address     copia la dirección del titular a los demás huéspedes
//   2) --doc-type=<tipo>  cambia el tipo de documento de identidad en masa
// Se pueden usar las dos a la vez. Complementa a legacy-betania/import-guests-xls.ts (que
// importa nombre/documento/ciudad pero no la dirección postal).
//
// Por defecto es una SIMULACIÓN: no escribe nada. Añade --apply para aplicar
// (en una transacción: o se aplican todos los cambios o ninguno).
//
// Standalone: solo Bun.sql (necesita DATABASE_URL en el entorno). No importa
// nada de src/.
//
// Uso:
//   bun scripts/bulk-update-reservation-guests.ts <reservaId> --copy-address
//   bun scripts/bulk-update-reservation-guests.ts <reservaId> --doc-type=passport
//   bun scripts/bulk-update-reservation-guests.ts <reservaId> --copy-address --doc-type=other --apply
//
// Opciones:
//   --copy-address        copia el BLOQUE de dirección completo del titular
//                         (calle, 2ª línea, CP, ciudad, código INE, país) — se
//                         copia como bloque para no mezclar la calle del
//                         titular con la ciudad de otro. Por defecto solo a los
//                         huéspedes SIN calle ni código postal (para no pisar
//                         direcciones ya rellenas).
//   --overwrite           con --copy-address: copia a TODOS, aunque ya tengan dirección.
//   --doc-type=<tipo>     dni | nie | passport | driving_licence | other. Por
//                         defecto solo cambia a los que TIENEN número de
//                         documento (un tipo sin número no sirve de nada).
//   --from-type=<tipo>    con --doc-type: cambia solo a los que ahora tienen ESE
//                         tipo (p.ej. --from-type=other --doc-type=passport).
//   --include-titular     con --doc-type: incluye también al titular.
//   --apply               aplica de verdad (sin esto, solo simula).

const args   = process.argv.slice(2)
const flags  = args.filter(a => a.startsWith('--'))
const pos    = args.filter(a => !a.startsWith('--'))
const flag   = (n: string) => flags.find(f => f === `--${n}` || f.startsWith(`--${n}=`))
const val    = (n: string) => flag(n)?.split('=')[1]

const APPLY           = !!flag('apply')
const COPY_ADDRESS    = !!flag('copy-address')
const OVERWRITE       = !!flag('overwrite')
const INCLUDE_TITULAR = !!flag('include-titular')
const DOC_TYPE        = val('doc-type')
const FROM_TYPE       = val('from-type')
const reservationId   = Number(pos[0])
const DOC_TYPES       = ['dni', 'nie', 'passport', 'driving_licence', 'other']

if (!Number.isInteger(reservationId) || (!COPY_ADDRESS && !DOC_TYPE)) {
  console.error('Uso: bun scripts/bulk-update-reservation-guests.ts <reservaId> [--copy-address [--overwrite]] [--doc-type=<tipo> [--from-type=<tipo>] [--include-titular]] [--apply]')
  console.error('Hay que indicar al menos --copy-address o --doc-type=<tipo>.')
  process.exit(1)
}
for (const [n, v] of [['doc-type', DOC_TYPE], ['from-type', FROM_TYPE]] as const) {
  if (v !== undefined && !DOC_TYPES.includes(v)) { console.error(`--${n} inválido: "${v}" (${DOC_TYPES.join(' | ')})`); process.exit(1) }
}
if (FROM_TYPE && !DOC_TYPE) { console.error('--from-type solo tiene sentido junto con --doc-type'); process.exit(1) }

const sql = Bun.sql  // usa DATABASE_URL del entorno

// Aislamiento: la reserva debe pertenecer al tenant (--tenant=<slug> o env TENANT)
const { resolveTenant } = await import('./lib/tenant')
const TENANT_ID = (await resolveTenant()).id

const [res] = await sql`SELECT id, status, guest_id, check_in_date::text AS ci, check_out_date::text AS co FROM reservations WHERE id = ${reservationId} AND property_id = ${TENANT_ID}`
if (!res) { console.error(`\n❌ No existe la reserva #${reservationId}.`); process.exit(1) }

const [titular] = await sql`
  SELECT id, first_name, last_name, address1, address2, zip_code, city, city_ine_code, address_country_code, country_id, id_doc_type, id_doc_number
  FROM guests WHERE id = ${res.guest_id}`
const others = await sql`
  SELECT DISTINCT g.id, g.first_name, g.last_name, g.address1, g.address2, g.zip_code, g.city, g.city_ine_code, g.address_country_code, g.country_id, g.id_doc_type, g.id_doc_number
  FROM reservation_nights rn JOIN guests g ON g.id = rn.guest_id
  WHERE rn.reservation_id = ${reservationId} AND rn.guest_id <> ${res.guest_id}
  ORDER BY g.last_name, g.first_name`

console.log(`\n🏨 Reserva #${res.id} (${res.status}) ${res.ci} → ${res.co} · titular ${titular?.first_name} ${titular?.last_name} · ${others.length} huéspedes adicionales`)
if (others.length === 0 && !INCLUDE_TITULAR) { console.log('No hay huéspedes adicionales — nada que hacer.\n'); process.exit(0) }

// Los huéspedes que también están en OTRAS reservas: editarlos les afecta allí también.
const ids = [...others.map((g: any) => g.id), titular.id]
const shared = await sql`
  SELECT guest_id, COUNT(DISTINCT reservation_id)::int AS n FROM (
    SELECT guest_id, reservation_id FROM reservation_nights WHERE guest_id IN ${sql(ids)} AND reservation_id <> ${reservationId}
    UNION SELECT guest_id, id FROM reservations WHERE guest_id IN ${sql(ids)} AND id <> ${reservationId}
  ) x GROUP BY guest_id`
const sharedBy = new Map<number, number>(shared.map((r: any) => [Number(r.guest_id), Number(r.n)]))

type Change = { g: any; set: Record<string, any>; notes: string[] }
const changes: Change[] = []
const fmtAddr = (g: any) => [g.address1, g.address2, g.zip_code, g.city, g.address_country_code].filter(Boolean).join(', ') || '(vacía)'

// ── 1. Copiar la dirección del titular ────────────────────────────────────────
const addrOf = (g: any) => ({
  address1: g.address1 ?? null, address2: g.address2 ?? null, zip_code: g.zip_code ?? null, city: g.city ?? null,
  city_ine_code: g.city_ine_code ?? null, address_country_code: g.address_country_code ?? null, country_id: g.country_id ?? null,
})
if (COPY_ADDRESS) {
  if (!titular.address1 && !titular.zip_code && !titular.city) {
    console.error(`\n❌ El titular no tiene dirección registrada — no hay nada que copiar.`); process.exit(1)
  }
  console.log(`\n📍 Dirección del titular: ${fmtAddr(titular)}`)
  const block = addrOf(titular)
  for (const g of others) {
    const hasStreet = !!(g.address1 || g.zip_code)
    const same = Object.entries(block).every(([k, v]) => (g[k] ?? null) === v)
    if (same) continue
    if (hasStreet && !OVERWRITE) { changes.push({ g, set: {}, notes: [`sin cambios: ya tiene dirección (${fmtAddr(g)}) — usa --overwrite para pisarla`] }); continue }
    let c = changes.find(x => x.g.id === g.id); if (!c) changes.push(c = { g, set: {}, notes: [] })
    Object.assign(c.set, block)
    c.notes.push(`dirección: ${fmtAddr(g)}  →  ${fmtAddr(titular)}`)
  }
}

// ── 2. Cambiar el tipo de documento ───────────────────────────────────────────
if (DOC_TYPE) {
  console.log(`\n🪪 Tipo de documento → ${DOC_TYPE}${FROM_TYPE ? ` (solo los que ahora son "${FROM_TYPE}")` : ''}`)
  const targets = INCLUDE_TITULAR ? [titular, ...others] : others
  for (const g of targets) {
    if (!g.id_doc_number) { const c0 = { g, set: {}, notes: ['sin cambios: no tiene número de documento'] }; if (!changes.find(x => x.g.id === g.id)) changes.push(c0); continue }
    if (g.id_doc_type === DOC_TYPE) continue
    if (FROM_TYPE && g.id_doc_type !== FROM_TYPE) continue
    let c = changes.find(x => x.g.id === g.id); if (!c) changes.push(c = { g, set: {}, notes: [] })
    c.set.id_doc_type = DOC_TYPE
    c.notes.push(`tipo de documento: ${g.id_doc_type ?? '(vacío)'}  →  ${DOC_TYPE}`)
  }
  if (['dni', 'nie'].includes(DOC_TYPE)) console.log('   ⚠ Los DNI/NIE necesitan además el número de soporte (idDocSupportNumber) para el parte de viajeros (SES) — este script no lo rellena.')
}

// ── Plan ──────────────────────────────────────────────────────────────────────
const real = changes.filter(c => Object.keys(c.set).length > 0)
console.log(`\nPlan (${APPLY ? 'SE APLICARÁ' : 'simulación — no se escribe nada'}):`)
for (const c of changes) {
  const isReal = Object.keys(c.set).length > 0
  const sh = sharedBy.get(c.g.id)
  console.log(`  ${isReal ? '✏️ ' : '⏭ '} ${c.g.last_name}, ${c.g.first_name} (#${c.g.id})${sh && isReal ? `   ⚠ también está en ${sh} reserva(s) más: se cambiará ahí también` : ''}`)
  for (const n of c.notes) console.log(`        ${n}`)
}
console.log(`\nResumen: ${real.length} huésped(es) a modificar · ${changes.length - real.length} sin cambios`)

if (!APPLY) { console.log('\n(Simulación) Añade --apply para aplicar.\n'); process.exit(0) }
if (real.length === 0) { console.log('\nNada que aplicar.\n'); process.exit(0) }

// ── Aplicar (transacción) ─────────────────────────────────────────────────────
await sql.begin(async (tx: any) => {
  for (const { g, set } of real) {
    if ('id_doc_type' in set) await tx`UPDATE guests SET id_doc_type = ${set.id_doc_type}::id_doc_type, updated_at = now() WHERE id = ${g.id}`
    if ('address1' in set) {
      await tx`
        UPDATE guests SET address1 = ${set.address1}, address2 = ${set.address2}, zip_code = ${set.zip_code}, city = ${set.city},
                          city_ine_code = ${set.city_ine_code}, address_country_code = ${set.address_country_code},
                          country_id = ${set.country_id}, updated_at = now()
        WHERE id = ${g.id}`
    }
  }
})
console.log(`\n✅ ${real.length} huésped(es) actualizados en la reserva #${reservationId}.\n`)
process.exit(0)
