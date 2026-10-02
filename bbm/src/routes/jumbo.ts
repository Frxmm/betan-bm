import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { canUseFdm } from '../middleware/auth'
import { serverError } from '../lib/errors'
import { hasFeature } from '../lib/property'
import { isConfigured, computeJumboDirtyEntries, startJumboPushInBackground, getJumboPushStatus } from '../lib/jumbo-push'

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('jumbo')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// GET /api/jumbo/status
app.get('/status', async (c) => {
  return c.json({ configured: await isConfigured() })
})

// GET /api/jumbo/push-status — resultado del último push (lanzado en segundo
// plano por POST /push-prices) y si hay uno en curso ahora mismo.
app.get('/push-status', (c) => {
  return c.json({ data: getJumboPushStatus() })
})

function dateRange(from: string, to: string): string[] {
  const dates: string[] = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to   + 'T12:00:00')
  while (cur <= end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setDate(cur.getDate() + 1)
  }
  return dates
}

const BENIGN_SKIP_REASONS = new Set([
  'sin cambios desde el último push',
  'sin fechas',
  'sin precio ni disponibilidad resolubles para esas fechas',
])

// POST /api/jumbo/push-prices — resuelve el precio de la tarifa de Jumbo para cada
// fecha del rango y compara contra el último valor empujado con éxito (parte
// rápida, solo BD: responde al instante si no hay nada que enviar). Si hay
// cambios, el envío real a Jumbo (login + N×setPrice + verificación) se lanza
// en SEGUNDO PLANO y esta petición responde inmediatamente con started:true —
// Jumbo puede tardar más de 30s por fecha y eso hacía saltar el timeout del
// proxy (504) si se esperaba aquí. El resultado real se consulta con
// GET /push-status. Con force:true se ignora el filtro de "sucio".
app.post('/push-prices', zValidator('json', z.object({
  from:  z.string().date(),
  to:    z.string().date(),
  force: z.boolean().optional().default(false),
})), async (c) => {
  if (!canUseFdm(c)) return c.json({ error: 'Sin permisos' }, 403)
  if (!await isConfigured()) return c.json({ error: 'Jumbo no configurado (settings jumbo.* y JUMBO_LOGIN / JUMBO_PASSWORD)' }, 400)

  try {
    const { from, to, force } = c.req.valid('json')
    const dates = dateRange(from, to)

    const check = await computeJumboDirtyEntries(dates, { force })
    if (check.skipped) {
      if (BENIGN_SKIP_REASONS.has(check.reason)) {
        return c.json({ data: { pushed: 0, verified: 0, errors: 0, errorList: [], skippedNoChanges: true, reason: check.reason, total: dates.length, from, to } })
      }
      return c.json({ error: check.reason }, 400)
    }

    const started = startJumboPushInBackground(check.toPush)
    if (!started) {
      return c.json({ data: { started: false, alreadyRunning: true, total: check.toPush.length, from, to } })
    }
    return c.json({ data: { started: true, total: check.toPush.length, from, to } })
  } catch (err) { return serverError(c, err) }
})

export default app
