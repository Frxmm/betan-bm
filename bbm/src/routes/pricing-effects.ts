import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { isAdmin } from '../middleware/auth'
import { serverError } from '../lib/errors'
import { computePricingEffects } from '../lib/pricingEffects'

const app = new Hono()

// GET /api/pricing-effects?days=30 — solo dirección (datos de revenue).
app.get('/', zValidator('query', z.object({ days: z.coerce.number().int().min(3).max(120).default(30) })), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const days = c.req.valid('query').days
    return c.json({ data: await computePricingEffects(days), meta: { days } })
  } catch (err) { return serverError(c, err) }
})

export default app
