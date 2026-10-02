import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { sign, verify } from 'hono/jwt'
import { setCookie, deleteCookie, getCookie } from 'hono/cookie'
import { db } from '../db'
import { users, userRoles, passwordResetTokens } from '../db/schema'
import { eq, and, isNull } from 'drizzle-orm'
import { env } from '../lib/env'
import { serverError } from '../lib/errors'
import { runWithProperty } from '../lib/property'
import { isResetOnCooldown, sendPasswordResetLink } from '../lib/passwordReset'

const app = new Hono()

const COOKIE     = 'auth_token'
const SEVEN_DAYS = 60 * 60 * 24 * 7

// POST /api/auth/login
app.post('/login', zValidator('json', z.object({
  email:    z.string().email(),
  password: z.string().min(1),
})), async (c) => {
  try {
    const { email, password } = c.req.valid('json')

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase().trim()),
    })
    if (!user || !user.active) return c.json({ error: 'Credenciales incorrectas' }, 401)

    const ok = await Bun.password.verify(password, user.passwordHash)
    if (!ok) return c.json({ error: 'Credenciales incorrectas' }, 401)

    const roles = await db.select({ role: userRoles.role })
      .from(userRoles).where(eq(userRoles.userId, user.id))

    const token = await sign({
      sub:       String(user.id),
      email:     user.email,
      firstName: user.firstName,
      lastName:  user.lastName,
      roles:     roles.map(r => r.role),
      isPrimary: user.isPrimary ?? false,
      propertyId: user.propertyId,
      isPlatformAdmin: user.isPlatformAdmin ?? false,
      exp:       Math.floor(Date.now() / 1000) + SEVEN_DAYS,
    }, env.JWT_SECRET, 'HS256')

    setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', path: '/', maxAge: SEVEN_DAYS })
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id))

    return c.json({ data: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, roles: roles.map(r => r.role), isPrimary: user.isPrimary ?? false, propertyId: user.propertyId, isPlatformAdmin: user.isPlatformAdmin ?? false, simplifiedAdminMode: user.simplifiedAdminMode ?? false } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/auth/logout
app.post('/logout', (c) => {
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
})

// GET /api/auth/me — no requiere auth middleware, devuelve null si no hay sesión
app.get('/me', async (c) => {
  try {
    const token = getCookie(c, COOKIE) ?? c.req.header('Authorization')?.replace('Bearer ', '')
    if (!token) return c.json({ data: null })
    const payload = await verify(token, env.JWT_SECRET, 'HS256').catch(() => null)
    if (!payload) return c.json({ data: null })
    const userId = Number(payload.sub)
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
      with: { roles: true },
    })
    if (!user || !user.active) return c.json({ data: null })
    return c.json({ data: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, roles: (user.roles as any[]).map(r => r.role), isPrimary: user.isPrimary, propertyId: Number(payload.propertyId) || user.propertyId, impersonating: payload.impersonating === true, isPlatformAdmin: user.isPlatformAdmin ?? false, avatarUrl: user.avatarUrl ?? null, simplifiedAdminMode: user.simplifiedAdminMode ?? false } })
  } catch { return c.json({ data: null }) }
})

// POST /api/auth/forgot-password — autoservicio desde Login
// Responde SIEMPRE con el mismo mensaje genérico, exista o no la cuenta y
// esté o no en cooldown — así no se puede usar para averiguar qué correos
// tienen cuenta en el sistema.
app.post('/forgot-password', zValidator('json', z.object({
  email: z.string().email(),
})), async (c) => {
  try {
    const { email } = c.req.valid('json')
    const user = await db.query.users.findFirst({ where: eq(users.email, email.toLowerCase().trim()) })
    if (user && user.active && !isResetOnCooldown(user.email)) {
      try { await runWithProperty(user.propertyId, () => sendPasswordResetLink(user)) }
      catch (e) { console.error('[auth] fallo enviando correo de recuperación', e) }
    }
    return c.json({
      message: 'Si existe una cuenta con ese correo, se ha enviado un enlace de recuperación. '
        + 'Puede tardar unos minutos — si ya pediste uno hace poco, espera 15 minutos antes de pedir otro.',
    })
  } catch (err) { return serverError(c, err) }
})

// POST /api/auth/reset-password — completar el cambio con el token del correo
app.post('/reset-password', zValidator('json', z.object({
  token:    z.string().min(1),
  password: z.string().min(6),
})), async (c) => {
  try {
    const { token, password } = c.req.valid('json')
    const row = await db.query.passwordResetTokens.findFirst({ where: eq(passwordResetTokens.token, token) })
    if (!row || row.usedAt || row.expiresAt.getTime() < Date.now()) {
      return c.json({ error: 'El enlace no es válido o ha caducado — pide uno nuevo' }, 400)
    }

    const passwordHash = await Bun.password.hash(password)
    await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, row.userId))
    await db.update(passwordResetTokens).set({ usedAt: new Date() }).where(eq(passwordResetTokens.id, row.id))
    // Invalida cualquier otro enlace pendiente del mismo usuario (p.ej. si
    // pidió varios antes de usar el primero).
    await db.delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.userId, row.userId), isNull(passwordResetTokens.usedAt)))

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

export default app
