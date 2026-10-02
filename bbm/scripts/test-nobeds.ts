/**
 * Script de prueba para la integración con Nobeds.
 * Verifica conectividad y operaciones básicas sin escribir datos reales.
 *
 * Uso: bun run scripts/test-nobeds.ts [--push-avail]
 *   --push-avail  Prueba también el envío de disponibilidad (necesita un rental ID)
 */

import { withTenant } from './lib/tenant'   // uso: --tenant=<slug>
import { isConfigured, listBookings, listRentals, pushAvailability } from '../src/lib/nobeds'

const PUSH_AVAIL = process.argv.includes('--push-avail')

function ok(msg: string)   { console.log(`  ✔ ${msg}`) }
function fail(msg: string) { console.error(`  ✕ ${msg}`) }
function info(msg: string) { console.log(`  ℹ ${msg}`) }
function sep(title: string){ console.log(`\n── ${title} ──`) }

async function main() {
  console.log('Nobeds Integration Test\n')

  // 1. Configuración
  sep('Configuración')
  if (!isConfigured()) {
    fail('NOBEDS_API_TOKEN no está definido en .env — abortando')
    process.exit(1)
  }
  ok('NOBEDS_API_TOKEN presente')

  // 2. Listar alojamientos (rentals)
  sep('Rentals')
  try {
    const rentals = await listRentals()
    if (!rentals.length) {
      fail('No se encontraron rentals — verifica el token y el hotel')
      process.exit(1)
    }
    ok(`${rentals.length} rental(s) encontrados:`)
    for (const r of rentals) {
      info(`  ID ${r.id}  "${r.title}"`)
    }

    // 3. Listar reservas del mes actual
    sep('Reservas (mes actual)')
    const now   = new Date()
    const from  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
    const to    = new Date(now.getFullYear(), now.getMonth() + 1, 0)
      .toISOString().slice(0, 10)
    info(`Rango: ${from} → ${to}`)
    const bookings = await listBookings({ fromdate: from, todate: to })
    ok(`${bookings.length} reserva(s) en el mes actual`)
    if (bookings.length > 0) {
      const b = bookings[0]!
      info(`  Primera: order_id=${b.order_id}  room_id=${b.room_id}  ${b.checkin.slice(0,10)} → ${b.checkout.slice(0,10)}  ${b.name}`)
    }

    // 4. Push de disponibilidad (opcional)
    if (PUSH_AVAIL) {
      sep('Push disponibilidad (--push-avail)')
      const rentalId = rentals[0]!.id
      const testDate = from  // primer día del mes actual
      info(`Enviando disponibilidad=1 para rental ${rentalId} en fecha ${testDate}`)
      await pushAvailability(rentalId, testDate, 1)
      ok('pushAvailability completado sin error')
    }

    sep('Resultado')
    ok('Todos los tests pasaron')
  } catch (e: any) {
    fail(`Error: ${e.message}`)
    if (e.stack) console.error(e.stack)
    process.exit(1)
  }

  process.exit(0)
}

await withTenant(main)
