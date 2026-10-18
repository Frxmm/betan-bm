// POST /api/events — interacciones anónimas de una página (clics, secciones vistas, scroll,
// tiempo, pasos del formulario). Solo las envía el navegador si el visitante aceptó el aviso
// de cookies. No se recibe ni se guarda IP, ni textos escritos por el usuario.
import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { RateLimiter } from '../ratelimit'
import { clientIp, hashIp, isBot } from '../util'

export const EVENT_TYPES = ['view', 'click', 'section', 'scroll', 'time', 'faq', 'form', 'theme', 'error'] as const

// Texto corto y "de interfaz": letras, números y signos básicos.
const short = (n: number) => z.string().max(n).transform(s => s.replace(/[^\p{L}\p{N} _\-:./#@|+&→?!¿¡%]/gu, '').trim().slice(0, n))

const batch = z.object({
  vid:  z.string().regex(/^[A-Za-z0-9-]{8,40}$/),
  path: z.string().max(100).regex(/^\/[a-z0-9\-_/.]*$/i).refine(p => !p.includes('..') && !p.includes('//')),
  dev:  z.enum(['m', 't', 'd']).optional(),
  ref:  z.string().max(80).optional(),
  events: z.array(z.object({
    t: z.enum(EVENT_TYPES),
    g: short(80).optional(),
    l: short(60).optional(),
    v: z.number().finite().min(-1e6).max(1e9).optional(),
  })).min(1).max(30),
})

export function eventRoutes(db: Database) {
  const limiter = new RateLimiter(900, 3_600_000)   // eventos por IP y hora
  const app = new Hono()

  app.post('/', async (c) => {
    if (isBot(c.req.header('user-agent'))) return c.body(null, 204)
    const body = await c.req.json().catch(() => null)
    const parsed = batch.safeParse(body)
    if (!parsed.success) return c.body(null, 204)
    const b = parsed.data
    if (!limiter.allow(hashIp(clientIp(c)))) return c.body(null, 204)

    const ins = db.query(`INSERT INTO events (vid, path, type, target, label, value, device, ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    const ref = (b.ref ?? '').replace(/^www\./, '')
    db.transaction(() => {
      for (const e of b.events) ins.run(b.vid, b.path, e.t, e.g ?? '', e.l ?? '', e.v ?? null, b.dev ?? '', ref)
    })()
    return c.body(null, 204)
  })

  return app
}
