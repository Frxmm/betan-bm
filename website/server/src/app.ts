import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { bodyLimit } from 'hono/body-limit'
import { logger } from 'hono/logger'
import type { Database } from 'bun:sqlite'
import { config, smtpConfigured } from './config'
import { contactRoutes } from './routes/contact'
import { hitRoutes } from './routes/hit'
import { eventRoutes } from './routes/events'
import { adminRoutes } from './routes/admin'
import { serveStaticSite, notFound } from './static'
import { PANEL_HTML } from './panel'
import { docsRoutes } from './routes/docs'

function allowedOrigins(): Set<string> {
  const u = new URL(config.siteUrl)
  const apex = u.hostname.replace(/^www\./, '')
  return new Set([`${u.protocol}//${apex}`, `${u.protocol}//www.${apex}`, ...config.extraOrigins])
}

export function createApp(db: Database, opts: { contact?: Parameters<typeof contactRoutes>[1] } = {}) {
  const app = new Hono()
  const origins = allowedOrigins()

  if (process.env.NODE_ENV !== 'test') app.use('*', logger(s => console.log(s.replace(/\/docs\/[^\s/]+/g, '/docs/[token]'))))
  app.use('*', compress())

  // Cabeceras de seguridad en todo. (nginx puede repetirlas; son idempotentes.)
  app.use('*', async (c, next) => {
    await next()
    const h = c.res.headers
    h.set('X-Content-Type-Options', 'nosniff')
    if (!h.has('Referrer-Policy')) h.set('Referrer-Policy', 'strict-origin-when-cross-origin')
    h.set('X-Frame-Options', 'SAMEORIGIN')
    h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), interest-cohort=()')
    h.set('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'self'; object-src 'none'")
    if (config.trustProxy ? c.req.header('x-forwarded-proto') === 'https' : c.req.url.startsWith('https:')) {
      h.set('Strict-Transport-Security', 'max-age=31536000')
    }
    if (c.req.path.startsWith('/api/')) h.set('Cache-Control', 'no-store')
  })

  // Dominio canónico (opcional): betanbm.com → www.betanbm.com
  if (config.canonicalRedirect) {
    app.use('*', async (c, next) => {
      const want = new URL(config.siteUrl).host
      const host = (config.trustProxy ? c.req.header('x-forwarded-host') : null) ?? c.req.header('host') ?? ''
      if (host && host !== want && host.replace(/^www\./, '') === want.replace(/^www\./, '')) {
        return c.redirect(config.siteUrl + new URL(c.req.url).pathname + new URL(c.req.url).search, 301)
      }
      return next()
    })
  }

  // API: solo mismo origen, cuerpos pequeños.
  app.use('/api/*', bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ ok: false, error: 'Petición demasiado grande' }, 413) }))
  app.use('/api/*', async (c, next) => {
    if (c.req.method === 'POST') {
      const origin = c.req.header('origin')
      if (origin && !origins.has(origin)) return c.json({ ok: false, error: 'Origen no permitido' }, 403)
    }
    return next()
  })

  app.get('/api/health', c => c.json({ ok: true, smtp: smtpConfigured() }))
  app.route('/api/contact', contactRoutes(db, opts.contact))
  app.route('/api/hit', hitRoutes(db))
  app.route('/api/events', eventRoutes(db))
  app.route('/api/admin', adminRoutes(db))
  app.route('/', docsRoutes(db))
  app.all('/api/*', c => c.json({ ok: false, error: 'No encontrado' }, 404))

  app.get('/panel', c => c.html(PANEL_HTML, 200, { 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store' }))
  app.on(['GET', 'HEAD'], '*', c => serveStaticSite(c))
  app.notFound(() => notFound())
  app.onError((err, c) => {
    console.error('[error]', err)
    return c.req.path.startsWith('/api/') ? c.json({ ok: false, error: 'Error interno' }, 500) : c.text('Error interno', 500)
  })
  return app
}
