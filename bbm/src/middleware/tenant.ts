import type { Context, Next } from 'hono'
import { runWithProperty, resolvePublicProperty } from '../lib/property'

// Rutas de staff (tras requireAuth): el tenant sale del JWT, nunca del cliente.
export async function tenantFromJwt(c: Context, next: Next) {
  const p = c.get('jwtPayload') as any
  const id = Number(p?.propertyId)
  if (!id) return c.json({ error: 'Sesión sin tenant — vuelve a iniciar sesión' }, 401)
  return runWithProperty(id, () => next())
}

// Rutas públicas (motor de reservas, portal, QR, contrato…): por dominio,
// ?tenant=slug o cabecera X-Tenant; si solo hay un tenant activo, ese.
export async function tenantFromRequest(c: Context, next: Next) {
  const url = new URL(c.req.url)
  // El webhook de Stripe resuelve su tenant por metadata.property_id / :slug (ver public.ts)
  if (url.pathname.startsWith('/api/public/stripe/webhook')) return next()
  const slug = c.req.query('tenant') ?? c.req.header('X-Tenant') ?? undefined
  const host = c.req.header('X-Forwarded-Host') ?? c.req.header('Host') ?? url.host
  const id = await resolvePublicProperty({ host, slug })
  if (!id) return c.json({ error: 'Tenant no encontrado' }, 404)
  return runWithProperty(id, () => next())
}

// Solo administradores de la plataforma (gestión de tenants).
export async function requirePlatformAdmin(c: Context, next: Next) {
  const p = c.get('jwtPayload') as any
  if (p?.isPlatformAdmin !== true) return c.json({ error: 'Solo administradores de plataforma' }, 403)
  await next()
}
