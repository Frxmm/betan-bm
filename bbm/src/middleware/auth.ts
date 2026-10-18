import type { Context, Next } from 'hono'
import { verify } from 'hono/jwt'
import { getCookie } from 'hono/cookie'
import { eq } from 'drizzle-orm'
import { env } from '../lib/env'
import { db } from '../db'
import { users } from '../db/schema'

export async function requireAuth(c: Context, next: Next) {
  const token = getCookie(c, 'auth_token')
    ?? c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'No autenticado' }, 401)
  try {
    const payload = await verify(token, env.JWT_SECRET, 'HS256') as any
    // sessionVersion: si Dirección ha forzado el cierre de sesión de este
    // usuario desde Usuarios (incrementa users.session_version), el token ya
    // emitido deja de valer al instante aunque no haya caducado — los JWT no
    // tienen estado propio, esta es la única forma de revocar uno ya emitido.
    const uid = Number(payload?.sub)
    if (!isNaN(uid) && uid > 0 && payload?.sv !== undefined) {
      const row = await db.query.users.findFirst({
        where: eq(users.id, uid),
        columns: { sessionVersion: true, active: true },
      })
      if (!row || !row.active || row.sessionVersion !== payload.sv) {
        return c.json({ error: 'Sesión cerrada' }, 401)
      }
    }
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
