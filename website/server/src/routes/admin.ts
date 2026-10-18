// Panel mínimo para ti (Bearer ADMIN_TOKEN): leads y visitas. Desactivado sin token.
import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import { config } from '../config'
import { safeEqual, clientIp, hashIp } from '../util'
import { RateLimiter } from '../ratelimit'

const csv = (s: unknown) => {
  const v = s == null ? '' : String(s)
  // Evita inyección de fórmulas al abrir el CSV en Excel/Sheets.
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function adminRoutes(db: Database) {
  const app = new Hono()
  const failures = new RateLimiter(10, 15 * 60_000)   // 10 tokens erróneos por IP cada 15 min

  app.use('*', async (c, next) => {
    if (!config.adminToken) return c.json({ error: 'Panel desactivado (define ADMIN_TOKEN)' }, 404)
    const who = hashIp(clientIp(c))
    const tok = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? ''
    if (!safeEqual(tok, config.adminToken)) {
      if (!failures.allow(who)) return c.json({ error: 'Demasiados intentos' }, 429)
      return c.json({ error: 'No autorizado' }, 401)
    }
    c.header('Cache-Control', 'no-store')
    return next()
  })

  app.get('/leads', (c) => {
    const limit = Math.min(Number(c.req.query('limit') ?? 100) || 100, 1000)
    const rows = db.query(
      `SELECT id, created_at, kind, name, email, hotel, rooms, phone, plan, role, marketing_ok, docs_views, last_access, message, source, mail_status FROM leads ORDER BY id DESC LIMIT ?`,
    ).all(limit)
    return c.json({ data: rows })
  })

  app.get('/leads.csv', (c) => {
    const rows = db.query(`SELECT id, created_at, kind, name, email, hotel, rooms, phone, plan, role, marketing_ok, docs_views, last_access, message, source, mail_status FROM leads ORDER BY id DESC`).all() as Record<string, unknown>[]
    const head = ['id', 'created_at', 'kind', 'name', 'email', 'hotel', 'rooms', 'phone', 'plan', 'role', 'marketing_ok', 'docs_views', 'last_access', 'message', 'source', 'mail_status']
    const body = [head.join(','), ...rows.map(r => head.map(h => csv(r[h])).join(','))].join('\n')
    return new Response(body, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' } })
  })

  app.get('/stats', (c) => {
    const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 365)
    const since = `-${days} days`
    const byDay = db.query(`SELECT day, SUM(n) AS views FROM pageviews WHERE day >= date('now', ?) GROUP BY day ORDER BY day`).all(since)
    const byPath = db.query(`SELECT path, SUM(n) AS views FROM pageviews WHERE day >= date('now', ?) GROUP BY path ORDER BY views DESC LIMIT 30`).all(since)
    const byRef = db.query(`SELECT CASE WHEN referrer = '' THEN '(directo)' ELSE referrer END AS referrer, SUM(n) AS views FROM pageviews WHERE day >= date('now', ?) GROUP BY referrer ORDER BY views DESC LIMIT 30`).all(since)
    const leads = db.query(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= datetime('now', ?)`).get(since)
    return c.json({ days, leads, byDay, byPath, byRef })
  })

  // Resumen de interacciones: alcance de secciones, scroll, tiempo, clics, FAQ, embudo del formulario.
  app.get('/summary', (c) => {
    const days = Math.min(Number(c.req.query('days') ?? 30) || 30, 365)
    const since = `-${days} days`
    const q = <T>(sql: string, ...p: (string | number)[]) => db.query(sql).all(...p) as T[]
    const one = <T>(sql: string, ...p: (string | number)[]) => db.query(sql).get(...p) as T

    const views = one<{ n: number }>(`SELECT COUNT(DISTINCT vid) n FROM events WHERE type='view' AND day >= date('now', ?)`, since).n
    const reach = (type: string, path?: string) => q<{ target: string; n: number }>(
      `SELECT target, COUNT(DISTINCT vid) n FROM events WHERE type=? AND day >= date('now', ?) ${path ? 'AND path = ?' : ''} GROUP BY target ORDER BY n DESC`,
      ...(path ? [type, since, path] : [type, since]))

    const times = q<{ value: number }>(`SELECT value FROM events WHERE type='time' AND day >= date('now', ?) AND value IS NOT NULL ORDER BY value`, since).map(r => r.value)
    const pct = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))]! : null)

    const funnelStep = (type: string, target: string) => one<{ n: number }>(
      `SELECT COUNT(DISTINCT vid) n FROM events WHERE type=? AND target=? AND day >= date('now', ?)`, type, target, since).n
    const homeViews = one<{ n: number }>(`SELECT COUNT(DISTINCT vid) n FROM events WHERE type='view' AND path='/' AND day >= date('now', ?)`, since).n

    return c.json({
      days, views,
      devices: q(`SELECT device, COUNT(DISTINCT vid) n FROM events WHERE type='view' AND day >= date('now', ?) GROUP BY device ORDER BY n DESC`, since),
      referrers: q(`SELECT CASE WHEN ref='' THEN '(directo)' ELSE ref END AS ref, COUNT(DISTINCT vid) n FROM events WHERE type='view' AND day >= date('now', ?) GROUP BY ref ORDER BY n DESC LIMIT 15`, since),
      pages: q(`SELECT path, COUNT(DISTINCT vid) n FROM events WHERE type='view' AND day >= date('now', ?) GROUP BY path ORDER BY n DESC LIMIT 20`, since),
      sections: reach('section'),
      scroll: reach('scroll'),
      activeSeconds: { n: times.length, p50: pct(0.5), p75: pct(0.75), avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null },
      clicks: q(`SELECT target, label, COUNT(*) n, COUNT(DISTINCT vid) visits FROM events WHERE type='click' AND day >= date('now', ?) GROUP BY target, label ORDER BY n DESC LIMIT 40`, since),
      faq: q(`SELECT label, COUNT(*) n FROM events WHERE type='faq' AND target='open' AND day >= date('now', ?) GROUP BY label ORDER BY n DESC LIMIT 20`, since),
      errors: q(`SELECT target, label, COUNT(*) n FROM events WHERE type='error' AND day >= date('now', ?) GROUP BY target, label ORDER BY n DESC LIMIT 10`, since),
      formFunnel: {
        homeViews,
        reachedContact: funnelStep('section', 'contacto'),
        started: funnelStep('form', 'form:start'),
        submitted: funnelStep('form', 'form:submit'),
        success: funnelStep('form', 'form:success'),
        abandoned: funnelStep('form', 'form:abandon'),
        fieldsCompleted: q(`SELECT label AS field, COUNT(DISTINCT vid) n FROM events WHERE type='form' AND target='form:field' AND day >= date('now', ?) GROUP BY label ORDER BY n DESC`, since),
        invalidFields: q(`SELECT label AS field, COUNT(*) n FROM events WHERE type='form' AND target='form:invalid' AND day >= date('now', ?) GROUP BY label ORDER BY n DESC`, since),
      },
      byDay: q(`SELECT day, COUNT(DISTINCT CASE WHEN type='view' THEN vid END) views, COUNT(*) events FROM events WHERE day >= date('now', ?) GROUP BY day ORDER BY day`, since),
    })
  })

  return app
}
