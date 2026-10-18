// POST /api/contact — solicitud de demo desde el formulario de la web.
// Defensas: tamaño, origen, honeypot, tiempo mínimo, límite por IP, duplicados.
import { Hono } from 'hono'
import { z } from 'zod'
import type { Database } from 'bun:sqlite'
import { RateLimiter } from '../ratelimit'
import { clientIp, hashIp, oneLine, multiLine } from '../util'
import { deliver } from '../mail'

export const PLANS = ['Aún no lo sé', 'Esencial', 'Pro', 'IA + Cerraduras', 'Varios hoteles'] as const

export const contactSchema = z.object({
  nombre:       z.string().trim().min(2, 'Escribe tu nombre').max(100),
  email:        z.string().trim().toLowerCase().max(160).pipe(z.email('Email no válido')),
  hotel:        z.string().trim().min(2, 'Escribe el nombre del hotel').max(120),
  habitaciones: z.union([z.coerce.number().int().min(1).max(5000), z.literal('')]).optional(),
  telefono:     z.string().trim().max(30).regex(/^[+0-9 ().-]*$/, 'Teléfono no válido').optional(),
  plan:         z.enum(PLANS).optional(),
  mensaje:      z.string().trim().max(2000).optional(),
  consent:      z.literal(true, { error: 'Debes aceptar la política de privacidad' }),
  /** Honeypot: campo oculto que un humano no rellena. */
  website:      z.string().max(300).optional(),
  /** Marca de tiempo (ms) en que se pintó el formulario. */
  t:            z.number().optional(),
  src:          z.string().max(120).optional(),
})

export function contactRoutes(db: Database, opts: { perHour?: number; perDay?: number; minFillMs?: number } = {}) {
  const hourly = new RateLimiter(opts.perHour ?? 5, 3_600_000)
  const daily  = new RateLimiter(opts.perDay ?? 20, 86_400_000)
  const perEmail = new RateLimiter(3, 86_400_000)
  const minFillMs = opts.minFillMs ?? 2500
  const app = new Hono()

  app.post('/', async (c) => {
    const ip = clientIp(c)
    const ipHash = hashIp(ip)
    if (!hourly.allow(ipHash) || !daily.allow(ipHash)) {
      return c.json({ ok: false, error: 'Demasiados intentos. Prueba más tarde o escríbenos por WhatsApp.' }, 429)
    }

    let raw: unknown
    try { raw = await c.req.json() } catch { return c.json({ ok: false, error: 'Petición no válida' }, 400) }

    const parsed = contactSchema.safeParse(raw)
    if (!parsed.success) {
      const fields: Record<string, string> = {}
      for (const i of parsed.error.issues) fields[String(i.path[0] ?? '_')] ??= i.message
      return c.json({ ok: false, error: Object.values(fields)[0] ?? 'Datos no válidos', fields }, 400)
    }
    const d = parsed.data

    // Bots: honeypot rellenado o formulario enviado demasiado rápido. Respondemos "ok"
    // para no dar pistas, pero no guardamos nada.
    if ((d.website && d.website.length > 0) || (typeof d.t === 'number' && Date.now() - d.t < minFillMs)) {
      return c.json({ ok: true })
    }

    // Máximo 3 solicitudes al día por email: el autorresponder no sirve para acosar a un tercero.
    if (!perEmail.allow(d.email)) return c.json({ ok: true })

    const name = oneLine(d.nombre), email = d.email, hotel = oneLine(d.hotel)
    const phone = d.telefono ? oneLine(d.telefono) : null
    const rooms = typeof d.habitaciones === 'number' ? d.habitaciones : null
    const message = d.mensaje ? multiLine(d.mensaje) : null
    const source = d.src ? oneLine(d.src) : (c.req.header('referer') ? new URL(c.req.header('referer')!, 'http://x').hostname : null)

    // Duplicado reciente (mismo email + hotel en 10 min): no volvemos a avisar.
    const dup = db.query(`SELECT id FROM leads WHERE email = ? AND hotel = ? AND created_at > datetime('now','-10 minutes')`).get(email, hotel)
    if (dup) return c.json({ ok: true })

    const res = db.query(
      `INSERT INTO leads (name, email, hotel, rooms, phone, plan, message, source, ip_hash, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(name, email, hotel, rooms, phone, d.plan ?? null, message, source, ipHash, (c.req.header('user-agent') ?? '').slice(0, 200))
    const id = Number(res.lastInsertRowid)

    // El correo no bloquea la respuesta al visitante.
    void deliver({ id, name, email, hotel, rooms, phone, plan: d.plan ?? null, message, source },
      s => db.query(`UPDATE leads SET mail_status = ? WHERE id = ?`).run(s, id))

    return c.json({ ok: true })
  })

  return app
}
