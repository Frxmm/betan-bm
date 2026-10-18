// Documentación bajo solicitud:
//   POST /api/docs-request  → guarda el lead y envía por email un enlace firmado y caducable.
//   GET  /docs/:token[/:slug] → guía de usuario (solo con enlace válido; noindex, sin referrer).
import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { RateLimiter } from '../ratelimit'
import { clientIp, hashIp, oneLine } from '../util'
import { config } from '../config'
import { deliverDocs } from '../mail'
import { makeToken, verifyToken, docsUrl, chapters, renderMarkdown, pageHtml } from '../docs'
import { notFound } from '../static'

export const ROLES = ['Dirección', 'Recepción', 'Housekeeping', 'Otro'] as const

export const docsSchema = z.object({
  nombre:    z.string().trim().min(2, 'Escribe tu nombre').max(100),
  email:     z.string().trim().toLowerCase().max(160).pipe(z.email('Email no válido')),
  hotel:     z.string().trim().min(2, 'Escribe el nombre del hotel').max(120),
  puesto:    z.enum(ROLES).optional(),
  novedades: z.boolean().optional(),
  consent:   z.literal(true, { error: 'Debes aceptar la política de privacidad' }),
  website:   z.string().max(300).optional(),
  t:         z.number().optional(),
})

export function docsRoutes(db: Database, opts: { minFillMs?: number } = {}) {
  const perIp = new RateLimiter(5, 3_600_000), perIpDay = new RateLimiter(15, 86_400_000), perEmail = new RateLimiter(3, 86_400_000)
  const minFillMs = opts.minFillMs ?? 2500
  const app = new Hono()

  app.post('/api/docs-request', async (c) => {
    const ipHash = hashIp(clientIp(c))
    if (!perIp.allow(ipHash) || !perIpDay.allow(ipHash)) return c.json({ ok: false, error: 'Demasiados intentos. Inténtalo más tarde.' }, 429)

    let raw: unknown
    try { raw = await c.req.json() } catch { return c.json({ ok: false, error: 'Petición no válida' }, 400) }
    const parsed = docsSchema.safeParse(raw)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const i of parsed.error.issues) fields[String(i.path[0] ?? '_')] ??= i.message
      return c.json({ ok: false, error: Object.values(fields)[0] ?? 'Datos no válidos', fields }, 400)
    }
    const d = parsed.data
    if ((d.website && d.website.length > 0) || (typeof d.t === 'number' && Date.now() - d.t < minFillMs)) return c.json({ ok: true })
    // Por email: máximo 3 envíos al día (evita usar el formulario para molestar a un tercero)
    if (!perEmail.allow(d.email)) return c.json({ ok: true })

    const name = oneLine(d.nombre), hotel = oneLine(d.hotel), email = d.email
    const row = db.query(`SELECT id FROM leads WHERE email = ? AND kind = 'docs' ORDER BY id DESC LIMIT 1`).get(email) as { id: number } | null
    let id: number
    if (row) {
      id = row.id
      db.query(`UPDATE leads SET name = ?, hotel = ?, role = ?, marketing_ok = ? WHERE id = ?`).run(name, hotel, d.puesto ?? null, d.novedades ? 1 : 0, id)
    } else {
      id = Number(db.query(
        `INSERT INTO leads (kind, name, email, hotel, role, marketing_ok, source, ip_hash, user_agent) VALUES ('docs', ?, ?, ?, ?, ?, 'documentacion', ?, ?)`,
      ).run(name, email, hotel, d.puesto ?? null, d.novedades ? 1 : 0, ipHash, (c.req.header('user-agent') ?? '').slice(0, 200)).lastInsertRowid)
    }
    const url = docsUrl(makeToken(id))
    void deliverDocs({ id, name, email, hotel, role: d.puesto ?? null, marketing: !!d.novedades }, url, config.docsTtlDays,
      s => db.query(`UPDATE leads SET mail_status = ? WHERE id = ?`).run(s, id))
    // La respuesta nunca incluye el enlace: solo llega al correo indicado.
    return c.json({ ok: true })
  })

  const guard = async (c: any, token: string): Promise<{ id: number; who: string } | Response> => {
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'private, no-store')
    const id = verifyToken(token)
    const lead = id ? db.query(`SELECT id, name FROM leads WHERE id = ? AND kind = 'docs'`).get(id) as { id: number; name: string } | null : null
    if (!lead) return expired()
    return { id: lead.id, who: lead.name }
  }

  const seen = (id: number) => db.query(`UPDATE leads SET docs_views = docs_views + 1, last_access = datetime('now') WHERE id = ?`).run(id)

  app.get('/docs/:token', async (c) => {
    const token = c.req.param('token')
    const g = await guard(c, token); if (g instanceof Response) return g
    const list = await chapters()
    const first = list.find(x => x.slug.startsWith('00')) ?? list[0]!
    seen(g.id)
    return c.html(pageHtml({ token, title: 'Índice', slug: first.slug, body: renderMarkdown(first.md, token), list, who: g.who }))
  })

  app.get('/docs/:token/:slug', async (c) => {
    const token = c.req.param('token'), slug = c.req.param('slug')
    const g = await guard(c, token); if (g instanceof Response) return g
    const list = await chapters()
    const ch = list.find(x => x.slug === slug)
    if (!ch) return notFound()
    seen(g.id)
    return c.html(pageHtml({ token, title: ch.title, slug, body: renderMarkdown(ch.md, token), list, who: g.who }))
  })

  return app
}

function expired(): Response {
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Enlace no válido · Betan</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:1.0625rem/1.6 system-ui,sans-serif;text-align:center;padding:24px;background:#f2f5f8;color:#0f2a43}a{color:#1f4fd8}</style></head>
<body><main><h1>Este enlace no es válido o ha caducado</h1><p>Pide uno nuevo y te lo enviamos por correo.</p><p><a href="/documentacion">Pedir la guía de usuario</a></p></main></body></html>`
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' } })
}
