// POST /api/hit — analítica propia, sin cookies ni IP, solo si el visitante aceptó
// las cookies de medición en el banner. Cuenta visitas por día, página y origen.
import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { RateLimiter } from '../ratelimit'
import { clientIp, hashIp, isBot } from '../util'

const PATH_RE = /^\/[a-z0-9\-_/.]{0,99}$/i

export function hitRoutes(db: Database) {
  const limiter = new RateLimiter(120, 3_600_000)
  const app = new Hono()

  app.post('/', async (c) => {
    if (isBot(c.req.header('user-agent'))) return c.body(null, 204)
    if (!limiter.allow(hashIp(clientIp(c)))) return c.body(null, 204)
    const body = await c.req.json().catch(() => null) as { path?: unknown; ref?: unknown } | null
    const path = typeof body?.path === 'string' ? body.path.split(/[?#]/)[0]! : ''
    if (!PATH_RE.test(path) || path.includes('..') || path.includes('//')) return c.body(null, 204)
    let ref = ''
    if (typeof body?.ref === 'string' && body.ref) {
      try { ref = new URL(body.ref).hostname.replace(/^www\./, '').slice(0, 80) } catch { /* sin referrer */ }
    }
    if (ref === 'betanbm.com') ref = ''
    db.query(
      `INSERT INTO pageviews (day, path, referrer, n) VALUES (date('now'), ?, ?, 1)
       ON CONFLICT (day, path, referrer) DO UPDATE SET n = n + 1`,
    ).run(path, ref)
    return c.body(null, 204)
  })

  return app
}
