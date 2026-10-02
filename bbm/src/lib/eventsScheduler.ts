// Scheduler diario: a las 09:00 (hora local de cada hotel) busca eventos locales
// (setting events.queries o ciudad del hotel) y, si hay eventos de alto o medio impacto en los próximos 30 días, envía un mensaje
// interno al equipo de dirección para que consideren ajustar precios.

import { db } from '../db'
import { users, userRoles, staffMessages, properties } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { getPropertyId, featureOf, runWithProperty } from './property'
import { fetchLocalEvents, type LocalEvent } from './serpapi'

async function analyzeAndNotify() {
  const events = await fetchLocalEvents()
  if (events.length === 0) return

  const relevant = events.filter(e => e.impactLevel === 'high' || e.impactLevel === 'medium')
  if (relevant.length === 0) return

  // Construye el resumen del mensaje
  const lines = relevant.slice(0, 10).map(e => {
    const tag = e.impactLevel === 'high' ? '🔴' : '🟡'
    return `${tag} ${e.title}${e.date ? ` — ${e.date}` : ''}${e.venue ? ` · ${e.venue}` : ''}`
  })
  const message =
    `📅 Eventos locales detectados que pueden aumentar la demanda:\n\n` +
    lines.join('\n') +
    `\n\nConsidera revisar tarifas para esas fechas. Puedes pedirme más detalles.`

  // Encontrar usuario principal ("from") — el isPrimary o el primero con rol direccion
  const [primary] = await db.select({ id: users.id })
    .from(users)
    .where(and(eq(users.isPrimary, true), eq(users.propertyId, getPropertyId())))
    .limit(1)

  // Destinatarios: todos los usuarios con rol 'direccion'
  const targets = await db.selectDistinct({ userId: userRoles.userId })
    .from(userRoles)
    .innerJoin(users, eq(users.id, userRoles.userId))
    .where(and(eq(userRoles.role, 'direccion'), eq(users.propertyId, getPropertyId())))

  if (targets.length === 0 || !primary) {
    console.log('[eventsScheduler] no hay destinatarios de direccion o sin usuario primario')
    return
  }

  for (const { userId } of targets) {
    if (userId === primary.id) continue // no enviarse a sí mismo
    try {
      await db.insert(staffMessages).values({
        fromUserId: primary.id,
        toUserId:   userId,
        message,
      })
    } catch (e: any) {
      console.error('[eventsScheduler] error insertando mensaje para userId', userId, e.message)
    }
  }

  console.log(`[eventsScheduler] ${relevant.length} eventos relevantes → mensajes enviados a ${targets.length} usuarios de dirección`)
}

// Milisegundos hasta las 09:00 en la zona horaria dada.
function msToNext9AM(timeZone: string): number {
  const now    = new Date()
  const local = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)

  const get = (type: string) => Number(local.find(p => p.type === type)?.value ?? '0')
  const h   = get('hour') % 24
  const min = get('minute')

  // Minutos hasta las 09:00 locales
  let minutesLeft = (9 * 60) - (h * 60 + min)
  if (minutesLeft <= 0) minutesLeft += 24 * 60  // ya pasó → mañana
  return minutesLeft * 60 * 1000
}

// Cada día se recalculan los tenants con módulo 'events' y se agenda su pasada a las
// 09:00 de su zona horaria. SERPAPI_API_KEY es secreto de plataforma (env) o del
// tenant (getSecret); sin clave, fetchLocalEvents devuelve [] y no se envía nada.
export function startEventsScheduler() {
  const loop = async () => {
    const rows = await db.select().from(properties).where(eq(properties.active, true))
    const zones = new Map<string, number[]>()
    for (const p of rows) {
      if (!featureOf(p, 'events')) continue
      zones.set(p.timezone, [...(zones.get(p.timezone) ?? []), p.id])
    }
    for (const [zone, ids] of zones) {
      const delay = msToNext9AM(zone)
      setTimeout(async () => {
        for (const id of ids) {
          await runWithProperty(id, analyzeAndNotify)
            .catch(e => console.error('[eventsScheduler] tenant', id, e.message))
        }
      }, delay)
      const h = Math.floor(delay / 3600_000), min = Math.floor((delay % 3600_000) / 60_000)
      console.log(`[eventsScheduler] ${ids.length} tenant(s) (${zone}): próxima ejecución en ${h}h ${min}m (09:00 locales)`)
    }
    setTimeout(() => loop().catch(e => console.error('[eventsScheduler] error:', e.message)), 24 * 60 * 60 * 1000)
  }
  loop().catch(e => console.error('[eventsScheduler] error:', e.message))
}
