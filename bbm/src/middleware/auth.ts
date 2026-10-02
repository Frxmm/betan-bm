import type { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { env } from '../lib/env'

export async function requireAuth(c: Context, next: Next) {
  const token = getCookie(c, 'auth_token')
    ?? c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'No autenticado' }, 401)
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256')
    c.set('jwtPayload', payload)
    await next()
  } catch {
    return c.json({ error: 'Sesión caducada' }, 401)
  }
}

export function isAdmin(c: Context): boolean {
  const p = c.get('jwtPayload') as any
  return p?.isPrimary === true || (Array.isArray(p?.roles) && p.roles.includes('direccion'))
}

export function canUseFdm(c: Context): boolean {
  const p = c.get('jwtPayload') as any
  if (!Array.isArray(p?.roles)) return !!p?.isPrimary
  return p.isPrimary === true || p.roles.some((r: string) => ['direccion', 'recepcion'].includes(r))
}

// Mismo criterio que canUseFdm (direccion + recepcion) — nombre propio para no
// confundir en las rutas que gestionan reservas/pagos, espejo del
// canManageReservations del frontend (contexts/AuthContext.tsx).
export function canManageReservations(c: Context): boolean {
  return canUseFdm(c)
}

export async function requireAdmin(c: Context, next: Next) {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  await next()
}
