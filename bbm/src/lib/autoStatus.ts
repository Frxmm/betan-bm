import { db } from '../db'
import { reservations, cartRecoverySettings } from '../db/schema'
import { and, eq, lt, lte, or, isNull, sql } from 'drizzle-orm'
import { forEachActiveProperty, getBranding, getPropertyId } from './property'

// Fecha de hoy en la zona horaria del tenant
const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())

async function run(label: string, fn: () => Promise<any>) {
  try { await fn() } catch (e: any) {
    console.error(`[autoStatus] ${label}: ${e.message}`)
  }
}

// Una pasada para el tenant del contexto actual
export async function syncStatuses() {
  const pid = getPropertyId()
  const t = todayIn((await getBranding()).timezone)

  // confirmed → arriving ("Por llegar"): check-in es hoy y aún no han llegado
  await run('confirmed→arriving', () =>
    db.update(reservations)
      .set({ status: 'arriving', updatedAt: new Date() })
      .where(and(
        eq(reservations.propertyId, pid),
        eq(reservations.status, 'confirmed'),
        eq(reservations.checkInDate, t),
      ))
  )

  // confirmed | arriving → no_show: checkout es hoy o ya pasó sin haber hecho check-in
  await run('arriving→no_show', () =>
    db.update(reservations)
      .set({ status: 'no_show', updatedAt: new Date() })
      .where(and(
        eq(reservations.propertyId, pid),
        or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving')),
        lte(reservations.checkOutDate, t),
      ))
  )

  // Carritos web abandonados → cancelled: tentative del booking engine sin pagar
  // tras maxAgeHours (mismo umbral que cart_recovery_settings, así la reserva
  // sigue viva mientras la recuperación de carritos y el flujo de "reanudar
  // pago" del widget aún puedan actuar sobre ella — antes se cancelaba ya a
  // la hora, lo que las mataba antes de que cart-recovery llegara a verlas y
  // antes de que el cliente pudiera volver a completar el pago).
  const [recoveryCfg] = await db.select({ maxAgeHours: cartRecoverySettings.maxAgeHours }).from(cartRecoverySettings).where(eq(cartRecoverySettings.propertyId, getPropertyId())).limit(1)
  const abandonedCartMaxAgeHours = recoveryCfg?.maxAgeHours ?? 24
  await run('web tentative→cancelled', () =>
    db.update(reservations)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(reservations.propertyId, pid),
        eq(reservations.status, 'tentative'),
        eq(reservations.isFromPortal, true),
        isNull(reservations.roomId),
        sql`${reservations.amountPaid} = 0`,
        lt(reservations.createdAt, new Date(Date.now() - abandonedCartMaxAgeHours * 60 * 60 * 1000)),
      ))
  )

  // Resto de tentatives caducadas → cancelled (nunca se confirmaron: no son no-show real)
  await run('tentative caducada→cancelled', () =>
    db.update(reservations)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(
        eq(reservations.propertyId, pid),
        eq(reservations.status, 'tentative'),
        lte(reservations.checkOutDate, t),
      ))
  )

  // checked_in → checking_out ("Saliendo"): check-out es hoy y aún están en el hotel
  await run('checked_in→checking_out', () =>
    db.update(reservations)
      .set({ status: 'checking_out', updatedAt: new Date() })
      .where(and(
        eq(reservations.propertyId, pid),
        eq(reservations.status, 'checked_in'),
        lte(reservations.checkOutDate, t),
      ))
  )
}

// Lanza el scheduler: ejecuta ahora y luego cada día a las 12:00
// Todos los tenants activos, cada uno en su contexto
const syncAllTenants = () => forEachActiveProperty('autoStatus', () => syncStatuses())

export function startAutoStatusScheduler() {
  syncAllTenants().catch(e => console.error('[autoStatus] error en arranque:', e))

  const msToNextNoon = () => {
    const now  = new Date()
    const next = new Date(now)
    next.setHours(12, 0, 5, 0) // 12:00:05
    if (next <= now) next.setDate(next.getDate() + 1) // ya pasó el mediodía → mañana
    return next.getTime() - now.getTime()
  }

  const schedule = () => {
    setTimeout(() => {
      syncAllTenants().catch(e => console.error('[autoStatus] error en scheduler:', e))
      setInterval(() => {
        syncAllTenants().catch(e => console.error('[autoStatus] error en scheduler:', e))
      }, 24 * 60 * 60 * 1000)
    }, msToNextNoon())
  }

  schedule()
  console.log('[autoStatus] scheduler iniciado — próxima ejecución a las 12:00')
}
