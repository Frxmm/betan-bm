// Test del cálculo de desayunos
// Uso: bun scripts/test-breakfast.ts [YYYY-MM-DD]

import { db } from '../src/db'
import { sql } from 'drizzle-orm'
import { resolveTenant } from './lib/tenant'

// Uso: bun scripts/test-breakfast.ts --tenant=<slug> [YYYY-MM-DD]
const TENANT_PID = (await resolveTenant()).id

const date = process.argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ?? new Date().toISOString().slice(0, 10)
console.log(`\n=== TEST DESAYUNOS — ${date} ===\n`)

// 1. ¿Existe la tabla breakfast_logs?
const tbl = await db.execute(sql`
  SELECT to_regclass('breakfast_logs') AS name
`) as unknown as { name: string | null }[]
const bfLogsExist = tbl[0]?.name != null
console.log(`[1] breakfast_logs existe: ${bfLogsExist ? '✓' : '✗ MIGRACIÓN PENDIENTE'}`)
if (!bfLogsExist) {
  console.log('    → Aplica: bun run scripts/apply-migration.ts drizzle/0020_breakfast_logs.sql\n')
}

// 2. Reservas activas hoy
const active = await db.execute(sql`
  SELECT r.id, r.status, r.check_in_date, r.check_out_date,
         ro.code AS room, r.rate_id, rt.title AS rate_title
  FROM reservations r
  LEFT JOIN rooms ro ON ro.id = r.room_id
  LEFT JOIN rates rt ON rt.id = r.rate_id
  WHERE r.status NOT IN ('cancelled', 'no_show')
    AND r.check_in_date  <= ${date}::date
    AND r.check_out_date >= ${date}::date
  ORDER BY ro.code
`) as unknown as {
  id: number; status: string; check_in_date: string; check_out_date: string
  room: string; rate_id: number | null; rate_title: string | null
}[]

console.log(`\n[2] Reservas activas hoy: ${active.length}`)
if (active.length === 0) {
  console.log('    → Sin reservas checked_in / checking_out para esta fecha')
} else {
  for (const r of active) {
    const rateInfo = r.rate_id
      ? `tarifa #${r.rate_id} "${r.rate_title}"`
      : 'SIN TARIFA ASIGNADA'
    console.log(`    Hab ${r.room ?? '?'} [${r.status}] ${r.check_in_date}→${r.check_out_date} — ${rateInfo}`)
  }
}

// 3. ¿Cuántas tienen tarifa con desayuno (HD / HyD)?
const withBreakfastRate = active.filter(r =>
  r.rate_title && (
    r.rate_title.toLowerCase().includes('hd') ||
    r.rate_title.toLowerCase().includes('hyd')
  )
)
console.log(`\n[3] Con tarifa HD/HyD: ${withBreakfastRate.length}`)
if (active.length > 0 && withBreakfastRate.length === 0) {
  console.log('    → Ninguna reserva tiene tarifa con "HD" o "HyD" en el título')
  console.log('    Títulos de tarifas activas:')
  const seen = new Set<string>()
  for (const r of active) {
    const t = r.rate_title ?? '(sin tarifa)'
    if (!seen.has(t)) { seen.add(t); console.log(`      - "${t}"`) }
  }
}

// 4. Todas las tarifas que existen en la BD
const allRates = await db.execute(sql`
  SELECT id, title, code FROM rates WHERE property_id = ${TENANT_PID} AND active = true ORDER BY title
`) as unknown as { id: number; title: string; code: string }[]

console.log(`\n[4] Tarifas activas en BD (${allRates.length} total):`)
for (const r of allRates) {
  const hasBreakfast =
    r.title.toLowerCase().includes('hd') ||
    r.title.toLowerCase().includes('hyd')
  console.log(`    ${hasBreakfast ? '🍳' : '  '} #${r.id} "${r.title}"`)
}

// 5. Extras de desayuno activos
const extrasActive = await db.execute(sql`
  SELECT
    rsi.id, rsi.reservation_id, rsi.quantity,
    ro.code AS room, g.first_name, g.last_name,
    si.title AS item_title,
    GREATEST(0, ${date}::date - COALESCE(rsi.date, rsi.created_at::date) + 1) AS days_elapsed,
    r.status
  FROM reservation_sale_items rsi
  JOIN reservations r  ON r.id  = rsi.reservation_id
  JOIN rooms        ro ON ro.id = r.room_id
  JOIN guests       g  ON g.id  = r.guest_id
  JOIN sale_items   si ON si.id = rsi.sale_item_id
  WHERE r.status NOT IN ('cancelled', 'no_show')
    AND r.check_in_date  <= ${date}::date
    AND r.check_out_date >= ${date}::date
    AND si.title ILIKE '%desayuno%'
  ORDER BY ro.code
`) as unknown as {
  id: number; reservation_id: number; quantity: number; room: string
  first_name: string; last_name: string; item_title: string
  days_elapsed: number; status: string
}[]

console.log(`\n[5] Extras de desayuno activos: ${extrasActive.length}`)
for (const e of extrasActive) {
  const remaining = Math.max(0, e.quantity - Number(e.days_elapsed))
  console.log(`    Hab ${e.room} — "${e.item_title}" qty=${e.quantity} días=${e.days_elapsed} restantes=${remaining}`)
}

// 6. Si hay reservas activas sin tarifa asignada, cuántas
const noRate = active.filter(r => !r.rate_id)
if (noRate.length > 0) {
  console.log(`\n[6] ⚠️  ${noRate.length} reservas activas SIN tarifa — ejecuta el import histórico para asignarlas:`)
  console.log('    importa el histórico de reservas del tenant')
}

console.log('\n=== FIN ===\n')
