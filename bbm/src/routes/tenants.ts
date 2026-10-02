// Administración de tenants (solo administradores de plataforma) y datos del
// establecimiento del tenant actual (dirección). Dos routers:
//   · default  → /api/tenants           (requirePlatformAdmin, montado en index.ts)
//   · propertyRoutes → /api/settings/property (tenant del JWT)
import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sign } from 'hono/jwt'
import { setCookie } from 'hono/cookie'
import { desc, eq, sql } from 'drizzle-orm'
import { db } from '../db'
import { properties, users, userRoles, tenantAuditLog, type Property } from '../db/schema'
import { env } from '../lib/env'
import { serverError } from '../lib/errors'
import { requireAdmin } from '../middleware/auth'
import { requirePlatformAdmin } from '../middleware/tenant'
import {
  ALL_FEATURES, DEFAULT_ON, featureOf, brandingOf, invalidateProperty, runWithProperty, type FeatureKey,
} from '../lib/property'
import { seedTenant } from '../lib/tenantSeed'
import { sendPasswordResetLink } from '../lib/passwordReset'

const COOKIE = 'auth_token'
const SEVEN_DAYS = 60 * 60 * 24 * 7
const IMPERSONATION_TTL = 60 * 60 * 2 // 2 h

// ─── Catálogo de módulos (lo consume el asistente y la ficha del tenant) ──────
export const MODULES: Record<FeatureKey, { label: string; group: string; description: string; secrets: { name: string; label: string }[] }> = {
  bookingEngine: { label: 'Motor de reservas', group: 'Ventas', description: 'Reservas directas desde la web del establecimiento (widget y página propia).', secrets: [] },
  portal:        { label: 'Portal del huésped', group: 'Ventas', description: 'Check-in online, firma de contrato y portal del cliente.', secrets: [] },
  stripe:        { label: 'Pagos online (Stripe)', group: 'Ventas', description: 'Cobros con tarjeta en el motor de reservas y enlaces de pago.', secrets: [
    { name: 'STRIPE_SECRET_KEY', label: 'Clave secreta' }, { name: 'STRIPE_PUBLIC_KEY', label: 'Clave pública' }, { name: 'STRIPE_WEBHOOK_SECRET', label: 'Secreto del webhook' } ] },
  nobeds:        { label: 'Channel manager (Nobeds)', group: 'Distribución', description: 'Sincronización de reservas y disponibilidad con Nobeds.', secrets: [
    { name: 'NOBEDS_API_TOKEN', label: 'Token de API' } ] },
  fdm:           { label: 'FDM', group: 'Distribución', description: 'Importación y envío de datos al sistema FDM.', secrets: [
    { name: 'FDM_USERNAME', label: 'Usuario' }, { name: 'FDM_PASSWORD', label: 'Contraseña' }, { name: 'FDM_CM_TOKEN', label: 'Token channel manager' } ] },
  jumbo:         { label: 'Jumbo', group: 'Distribución', description: 'Integración con el operador Jumbo (contratos y precios).', secrets: [
    { name: 'JUMBO_LOGIN', label: 'Usuario' }, { name: 'JUMBO_PASSWORD', label: 'Contraseña' } ] },
  pricingRules:  { label: 'Reglas de precios', group: 'Revenue', description: 'Ajuste automático de precios según ocupación y reglas.', secrets: [] },
  competitors:   { label: 'Competencia', group: 'Revenue', description: 'Seguimiento de precios de la competencia.', secrets: [
    { name: 'SERPAPI_API_KEY', label: 'Clave SerpAPI' }, { name: 'GOOGLE_PLACES_API_KEY', label: 'Clave Google Places' } ] },
  events:        { label: 'Eventos', group: 'Revenue', description: 'Eventos de la zona que influyen en la demanda.', secrets: [] },
  ses:           { label: 'SES.Hospedajes', group: 'Operaciones', description: 'Comunicación de viajeros a la administración (partes de entrada).', secrets: [
    { name: 'SES_USERNAME', label: 'Usuario' }, { name: 'SES_PASSWORD', label: 'Contraseña' }, { name: 'SES_CODIGO_ARRENDADOR', label: 'Código de arrendador' }, { name: 'SES_CODIGO_ESTABLECIMIENTO', label: 'Código de establecimiento' } ] },
  ttlock:        { label: 'Cerraduras TTLock', group: 'Operaciones', description: 'Códigos de puerta y tarjetas con cerraduras TTLock.', secrets: [
    { name: 'TTLOCK_CLIENT_ID', label: 'Client ID' }, { name: 'TTLOCK_CLIENT_SECRET', label: 'Client secret' }, { name: 'TTLOCK_USERNAME', label: 'Usuario' }, { name: 'TTLOCK_PASSWORD', label: 'Contraseña' } ] },
  zkteco:        { label: 'Control de acceso ZKTeco', group: 'Operaciones', description: 'Puente con lectores ZKTeco (huella/tarjeta).', secrets: [
    { name: 'ZKTECO_BRIDGE_URL', label: 'URL del puente' }, { name: 'ZKTECO_BRIDGE_KEY', label: 'Clave del puente' }, { name: 'ZKTECO_ENROLLER_SECRET', label: 'Secreto de enrolado' } ] },
  pool:          { label: 'Piscina', group: 'Operaciones', description: 'Control de aforo/acceso de la piscina.', secrets: [
    { name: 'POOL_API_URL', label: 'URL de la API' }, { name: 'POOL_API_KEY', label: 'Clave de API' } ] },
  laundry:       { label: 'Lavandería', group: 'Operaciones', description: 'Gestión de lavandería y ropa de cama.', secrets: [] },
  cashDrawer:    { label: 'Caja de cambio', group: 'Operaciones', description: 'Arqueos y control de la caja de cambio.', secrets: [] },
  whatsapp:      { label: 'WhatsApp', group: 'Comunicación', description: 'Mensajes automáticos al huésped por WhatsApp Business.', secrets: [
    { name: 'WHATSAPP_TOKEN', label: 'Token de acceso' }, { name: 'WHATSAPP_PHONE_ID', label: 'ID del teléfono' } ] },
  ai:            { label: 'Asistente IA', group: 'Comunicación', description: 'Asistente conversacional y resúmenes diarios.', secrets: [
    { name: 'ANTHROPIC_API_KEY', label: 'Clave Anthropic' } ] },
  voice:         { label: 'Voz', group: 'Comunicación', description: 'Resumen por voz y dictado.', secrets: [] },
}

// ─── Utilidades ───────────────────────────────────────────────────────────────
const SECRET_PREFIX = 'secrets.'
const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/

function maskSecret(v: unknown): { set: true; masked: string } | { set: false } {
  if (typeof v !== 'string' || v === '') return { set: false }
  return { set: true, masked: v.length >= 12 ? `••••${v.slice(-4)}` : '••••' }
}

/** settings con los secretos sustituidos por {set, masked}: nunca salen en claro. */
function safeSettings(p: Property): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries((p.settings ?? {}) as Record<string, unknown>)) {
    out[k] = k.startsWith(SECRET_PREFIX) ? maskSecret(v) : v
  }
  return out
}

function featureMap(p: Property): Record<string, boolean> {
  return Object.fromEntries(ALL_FEATURES.map(k => [k, featureOf(p, k)]))
}

function tenantDto(p: Property) {
  return { ...brandingOf(p), active: p.active, features: featureMap(p), createdAt: p.createdAt }
}

async function audit(c: Context, propertyId: number | null, action: string, details: Record<string, unknown> = {}) {
  const uid = Number((c.get('jwtPayload') as any)?.sub)
  await db.insert(tenantAuditLog).values({
    platformUserId: uid > 0 ? uid : null, propertyId, action, details,
  })
}

function isUniqueViolation(e: any): string | null {
  const cause = e?.cause ?? e
  if (cause?.code === '23505' || e?.code === '23505') return String(cause?.constraint_name ?? cause?.detail ?? 'dato duplicado')
  return null
}

const opt = z.string().trim().max(500).optional().nullable()
const nz = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v.trim())

const validTz = (tz: string) => { try { new Intl.DateTimeFormat('es', { timeZone: tz }); return true } catch { return false } }

const dataFields = {
  name:                  z.string().trim().min(1).max(200),
  legalName:             opt, vatNumber: opt, touristRegistryNumber: opt,
  address: opt, postalCode: opt, city: opt, region: opt,
  countryCode:           z.string().trim().length(2).transform(s => s.toUpperCase()).optional().nullable(),
  phone: opt,
  email:                 z.string().trim().email().optional().nullable().or(z.literal('')),
  receptionEmail:        z.string().trim().email().optional().nullable().or(z.literal('')),
  fromEmail:             z.string().trim().max(300).optional().nullable(),
  websiteUrl: opt, mapsUrl: opt, logoUrl: opt, starLabel: z.string().trim().max(40).optional().nullable(),
  currencyCode:          z.string().trim().length(3).transform(s => s.toUpperCase()).optional(),
  timezone:              z.string().trim().refine(validTz, 'Zona horaria no válida').optional(),
  localeDefault:         z.string().trim().min(2).max(10).optional(),
}
const platformOnlyFields = {
  publicDomain: z.string().trim().max(200).toLowerCase().optional().nullable(),
}

/** Convierte el body validado en columnas de `properties` ('' → null). */
function toColumns(body: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue
    if (k === 'name' || k === 'currencyCode' || k === 'timezone' || k === 'localeDefault') out[k] = v
    else out[k] = typeof v === 'string' ? nz(v) : v
  }
  return out
}

function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return Array.from(bytes, b => chars[b % chars.length]).join('')
}

// ═══════════════════════════════════════════════════════════════════════════════
// /api/tenants — administradores de plataforma
// ═══════════════════════════════════════════════════════════════════════════════
const app = new Hono()
app.use('*', requirePlatformAdmin)

// GET /api/tenants/modules — catálogo de módulos y credenciales
app.get('/modules', (c) => c.json({ data: { features: ALL_FEATURES, defaultOn: DEFAULT_ON, modules: MODULES } }))

// GET /api/tenants — lista con conteos
app.get('/', async (c) => {
  try {
    const rows = await db.select().from(properties).orderBy(properties.id)
    const counts = Array.from(await db.execute(sql`
      SELECT p.id,
        (SELECT count(*) FROM rooms r WHERE r.property_id = p.id)::int AS rooms,
        (SELECT count(*) FROM users u WHERE u.property_id = p.id)::int AS users,
        (SELECT count(*) FROM reservations v WHERE v.property_id = p.id)::int AS reservations,
        (SELECT max(u.last_login_at) FROM users u WHERE u.property_id = p.id) AS last_login_at
      FROM properties p`)) as any[]
    const byId = new Map(counts.map(r => [Number(r.id), r]))
    return c.json({ data: rows.map(p => {
      const k = byId.get(p.id)
      return { ...tenantDto(p), rooms: k?.rooms ?? 0, users: k?.users ?? 0, reservations: k?.reservations ?? 0, lastLoginAt: k?.last_login_at ?? null }
    }) })
  } catch (err) { return serverError(c, err) }
})

// POST /api/tenants — alta de tenant + seed + administrador inicial
const createSchema = z.object({
  slug: z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'El slug solo admite a-z, 0-9 y guiones').min(2).max(40),
  ...dataFields, ...platformOnlyFields,
  features: z.record(z.string(), z.boolean()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  admin: z.object({
    email: z.string().trim().toLowerCase().email(),
    firstName: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
  }),
})
app.post('/', zValidator('json', createSchema), async (c) => {
  try {
    const { slug, admin, features, settings, ...rest } = c.req.valid('json')
    const unknown = Object.keys(features ?? {}).filter(k => !ALL_FEATURES.includes(k as FeatureKey))
    if (unknown.length) return c.json({ error: `Módulos desconocidos: ${unknown.join(', ')}` }, 400)
    for (const k of Object.keys(settings ?? {})) {
      if (k.startsWith(SECRET_PREFIX) && !SECRET_NAME_RE.test(k.slice(SECRET_PREFIX.length))) return c.json({ error: `Clave de secreto no válida: ${k}` }, 400)
    }

    if (await db.query.properties.findFirst({ where: eq(properties.slug, slug) })) return c.json({ error: 'Ya existe un tenant con ese slug' }, 409)
    if (await db.query.users.findFirst({ where: eq(users.email, admin.email) })) return c.json({ error: 'Ya existe un usuario con ese email' }, 409)

    const fullFeatures = Object.fromEntries(ALL_FEATURES.map(k => [k, features?.[k] ?? featureOf({ features: {} } as Property, k)]))
    const secretSettings = Object.fromEntries(Object.entries(settings ?? {}).filter(([, v]) => v !== '' && v != null))

    let prop: Property
    try {
      ;[prop] = await db.insert(properties).values({
        ...toColumns(rest), name: rest.name, slug, features: fullFeatures, settings: secretSettings, active: true,
      } as any).returning() as [Property]
    } catch (e) {
      const dup = isUniqueViolation(e)
      if (dup) return c.json({ error: `Dato duplicado (${dup}): revisa slug y dominio` }, 409)
      throw e
    }

    const seed = await seedTenant(prop.id)

    const tempPassword = generatePassword()
    const [adminUser] = await db.insert(users).values({
      propertyId: prop.id, email: admin.email, firstName: admin.firstName, lastName: admin.lastName,
      passwordHash: await Bun.password.hash(tempPassword), isPrimary: true, active: true,
    }).returning()
    await db.insert(userRoles).values({ userId: adminUser!.id, role: 'direccion' })

    let resetEmailSent = false
    try {
      await runWithProperty(prop.id, () => sendPasswordResetLink(adminUser!))
      resetEmailSent = true
    } catch (e) { console.error('[tenants] fallo enviando enlace de reseteo al admin inicial', e) }

    invalidateProperty(prop.id)
    await audit(c, prop.id, 'tenant.create', { slug, admin: admin.email, seeded: seed.created.length, resetEmailSent })
    const fresh = (await db.query.properties.findFirst({ where: eq(properties.id, prop.id) }))!
    return c.json({ data: { tenant: tenantDto(fresh), admin: { id: adminUser!.id, email: admin.email, tempPassword, resetEmailSent } } }, 201)
  } catch (err) { return serverError(c, err) }
})

// POST /api/tenants/stop-impersonation — vuelve a la sesión normal del administrador
app.post('/stop-impersonation', async (c) => {
  try {
    const payload = c.get('jwtPayload') as any
    const uid = Number(payload?.sub)
    const user = await db.query.users.findFirst({ where: eq(users.id, uid), with: { roles: true } as any }) as any
    if (!user || !user.active) return c.json({ error: 'Usuario no encontrado' }, 404)
    const token = await sign({
      sub: String(user.id), email: user.email, firstName: user.firstName, lastName: user.lastName,
      roles: (user.roles as any[]).map(r => r.role), isPrimary: user.isPrimary ?? false,
      propertyId: user.propertyId, isPlatformAdmin: user.isPlatformAdmin ?? false,
      exp: Math.floor(Date.now() / 1000) + SEVEN_DAYS,
    }, env.JWT_SECRET, 'HS256')
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SEVEN_DAYS })
    await audit(c, Number(payload?.propertyId) || null, 'tenant.impersonate.stop', { restoredPropertyId: user.propertyId })
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

async function loadTenant(c: Context): Promise<Property | null> {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id <= 0) return null
  return (await db.query.properties.findFirst({ where: eq(properties.id, id) })) ?? null
}

// GET /api/tenants/:id
app.get('/:id', async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const staff = await db.select({
      id: users.id, email: users.email, firstName: users.firstName, lastName: users.lastName,
      active: users.active, isPrimary: users.isPrimary, lastLoginAt: users.lastLoginAt,
    }).from(users).where(eq(users.propertyId, p.id)).orderBy(users.id)
    return c.json({ data: { ...tenantDto(p), admissionTermsHtml: p.admissionTermsHtml, settings: safeSettings(p), users: staff } })
  } catch (err) { return serverError(c, err) }
})

// GET /api/tenants/:id/audit
app.get('/:id/audit', async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const rows = await db.select({
      id: tenantAuditLog.id, action: tenantAuditLog.action, details: tenantAuditLog.details,
      createdAt: tenantAuditLog.createdAt, by: users.email,
    }).from(tenantAuditLog)
      .leftJoin(users, eq(users.id, tenantAuditLog.platformUserId))
      .where(eq(tenantAuditLog.propertyId, p.id))
      .orderBy(desc(tenantAuditLog.createdAt)).limit(200)
    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/tenants/:id — datos + active
const patchSchema = z.object({
  ...Object.fromEntries(Object.entries({ ...dataFields, ...platformOnlyFields }).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])),
  active: z.boolean().optional(),
}) as z.ZodType<Record<string, any>>
app.patch('/:id', zValidator('json', patchSchema), async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const { active, ...rest } = c.req.valid('json') as Record<string, any>
    const cols = toColumns(rest)
    if (typeof active === 'boolean') cols.active = active
    if (!Object.keys(cols).length) return c.json({ error: 'Nada que actualizar' }, 400)
    try {
      await db.update(properties).set({ ...cols, updatedAt: new Date() }).where(eq(properties.id, p.id))
    } catch (e) {
      const dup = isUniqueViolation(e)
      if (dup) return c.json({ error: `Dato duplicado (${dup})` }, 409)
      throw e
    }
    invalidateProperty(p.id)
    await audit(c, p.id, active === false ? 'tenant.deactivate' : active === true && !p.active ? 'tenant.activate' : 'tenant.update', { fields: Object.keys(cols) })
    const fresh = (await db.query.properties.findFirst({ where: eq(properties.id, p.id) }))!
    return c.json({ data: tenantDto(fresh) })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/tenants/:id/features — mapa módulo → bool
app.put('/:id/features', zValidator('json', z.record(z.string(), z.boolean())), async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const body = c.req.valid('json')
    const unknown = Object.keys(body).filter(k => !ALL_FEATURES.includes(k as FeatureKey))
    if (unknown.length) return c.json({ error: `Módulos desconocidos: ${unknown.join(', ')}` }, 400)
    const features = { ...featureMap(p), ...body }
    await db.update(properties).set({ features, updatedAt: new Date() }).where(eq(properties.id, p.id))
    invalidateProperty(p.id)
    await audit(c, p.id, 'tenant.features', { changed: body })
    return c.json({ data: features })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/tenants/:id/settings — mapa clave → valor (null borra; secrets.* solo escritura)
app.put('/:id/settings', zValidator('json', z.record(z.string().min(1).max(100), z.unknown())), async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const body = c.req.valid('json')
    const current = { ...((p.settings ?? {}) as Record<string, unknown>) }
    const changed: string[] = []
    for (const [k, v] of Object.entries(body)) {
      if (k.startsWith(SECRET_PREFIX)) {
        if (!SECRET_NAME_RE.test(k.slice(SECRET_PREFIX.length))) return c.json({ error: `Clave de secreto no válida: ${k}` }, 400)
        if (v === '' || (typeof v === 'object' && v !== null)) continue   // vacío / eco de {set:true}: no se toca
        if (v !== null && typeof v !== 'string') return c.json({ error: `El secreto ${k} debe ser texto` }, 400)
      }
      if (v === null) delete current[k]; else current[k] = v
      changed.push(k)
    }
    await db.update(properties).set({ settings: current, updatedAt: new Date() }).where(eq(properties.id, p.id))
    invalidateProperty(p.id)
    // En auditoría solo se registran las claves, nunca valores
    await audit(c, p.id, 'tenant.settings', { keys: changed })
    const fresh = (await db.query.properties.findFirst({ where: eq(properties.id, p.id) }))!
    return c.json({ data: safeSettings(fresh) })
  } catch (err) { return serverError(c, err) }
})

// POST /api/tenants/:id/secrets/test — comprueba que las credenciales del módulo existen
app.post('/:id/secrets/test', zValidator('json', z.object({ module: z.string() })), async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const { module } = c.req.valid('json')
    const def = MODULES[module as FeatureKey]
    if (!def) return c.json({ error: 'Módulo desconocido' }, 400)
    const s = (p.settings ?? {}) as Record<string, unknown>
    const missing = def.secrets.filter(x => !s[`${SECRET_PREFIX}${x.name}`]).map(x => x.name)
    return c.json({ data: { ok: missing.length === 0, missing } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/tenants/:id/seed — re-ejecuta el seed (idempotente)
app.post('/:id/seed', async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const r = await seedTenant(p.id)
    await audit(c, p.id, 'tenant.seed', { created: r.created.length })
    return c.json({ data: r })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/tenants/:id — desactivar (nunca se borran datos)
app.delete('/:id', async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const own = Number((c.get('jwtPayload') as any)?.propertyId)
    if (own === p.id) return c.json({ error: 'No puedes desactivar tu propio tenant' }, 400)
    await db.update(properties).set({ active: false, updatedAt: new Date() }).where(eq(properties.id, p.id))
    invalidateProperty(p.id)
    await audit(c, p.id, 'tenant.deactivate', {})
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// POST /api/tenants/:id/impersonate — sesión de soporte (JWT corto con el propertyId del tenant)
app.post('/:id/impersonate', async (c) => {
  try {
    const p = await loadTenant(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    if (!p.active) return c.json({ error: 'El tenant está desactivado' }, 400)
    const payload = c.get('jwtPayload') as any
    const uid = Number(payload?.sub)
    const admin = await db.query.users.findFirst({ where: eq(users.id, uid) })
    if (!admin || !admin.active || !admin.isPlatformAdmin) return c.json({ error: 'Sin permisos' }, 403)
    const token = await sign({
      sub: String(admin.id), email: admin.email, firstName: admin.firstName, lastName: admin.lastName,
      roles: ['direccion'], isPrimary: false,
      propertyId: p.id,
      isPlatformAdmin: true,            // para poder volver a /tenants y salir
      impersonating: true,
      impersonatorPropertyId: admin.propertyId,
      exp: Math.floor(Date.now() / 1000) + IMPERSONATION_TTL,
    }, env.JWT_SECRET, 'HS256')
    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: IMPERSONATION_TTL })
    await audit(c, p.id, 'tenant.impersonate.start', { ttlSeconds: IMPERSONATION_TTL, ip: c.req.header('X-Forwarded-For') ?? null })
    return c.json({ data: { propertyId: p.id, name: p.name, expiresInSeconds: IMPERSONATION_TTL } })
  } catch (err) { return serverError(c, err) }
})

export default app

// ═══════════════════════════════════════════════════════════════════════════════
// /api/settings/property — tenant actual (el del JWT)
// ═══════════════════════════════════════════════════════════════════════════════
export const propertyRoutes = new Hono()

async function currentProperty(c: Context): Promise<Property | null> {
  const id = Number((c.get('jwtPayload') as any)?.propertyId)
  if (!id) return null
  return (await db.query.properties.findFirst({ where: eq(properties.id, id) })) ?? null
}

// GET /api/settings/property — branding y datos (cualquier usuario autenticado)
propertyRoutes.get('/', async (c) => {
  try {
    const p = await currentProperty(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const jwt = c.get('jwtPayload') as any
    return c.json({ data: {
      ...brandingOf(p), features: featureMap(p),
      impersonating: jwt?.impersonating === true,
    } })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/settings/property — datos y branding editables por la dirección (sin slug/active/features/secrets/dominio)
const selfSchema = z.object(Object.fromEntries(
  Object.entries(dataFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]),
)) as z.ZodType<Record<string, any>>
propertyRoutes.put('/', requireAdmin, zValidator('json', selfSchema), async (c) => {
  try {
    const p = await currentProperty(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const cols = toColumns(c.req.valid('json') as Record<string, any>)
    if (!Object.keys(cols).length) return c.json({ error: 'Nada que actualizar' }, 400)
    await db.update(properties).set({ ...cols, updatedAt: new Date() }).where(eq(properties.id, p.id))
    invalidateProperty(p.id)
    const fresh = (await db.query.properties.findFirst({ where: eq(properties.id, p.id) }))!
    return c.json({ data: { ...brandingOf(fresh), features: featureMap(fresh) } })
  } catch (err) { return serverError(c, err) }
})

// GET /api/settings/property/features — módulos contratados (solo lectura)
propertyRoutes.get('/features', async (c) => {
  try {
    const p = await currentProperty(c)
    if (!p) return c.json({ error: 'Tenant no encontrado' }, 404)
    const f = featureMap(p)
    return c.json({ data: ALL_FEATURES.map(k => ({
      key: k, enabled: f[k]!, label: MODULES[k].label, group: MODULES[k].group, description: MODULES[k].description,
    })) })
  } catch (err) { return serverError(c, err) }
})
