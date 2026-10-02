import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { users, userRoles } from '../db/schema'
import { eq, and } from 'drizzle-orm'
import { notFound, serverError } from '../lib/errors'
import { isAdmin } from '../middleware/auth'
import { getPropertyId } from '../lib/property'
import { isResetOnCooldown, sendPasswordResetLink } from '../lib/passwordReset'

const app = new Hono()

// ── Presencia en tiempo real (in-memory, TTL 90s) ────────────────────────────
const PRESENCE_TTL = 90_000
// Clave: `${tenant}:${userId}` (presencia aislada por tenant)
const presenceMap  = new Map<string, { propertyId: number; id: number; name: string; seenAt: number }>()

app.post('/presence/ping', async (c) => {
  try {
    const p    = c.get('jwtPayload') as any
    const id   = Number(p?.sub ?? p?.id)
    const name = [p?.firstName, p?.lastName].filter(Boolean).join(' ') || `Usuario ${id}`
    if (id) { const pid = getPropertyId(); presenceMap.set(`${pid}:${id}`, { propertyId: pid, id, name, seenAt: Date.now() }) }
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// Usada tanto por GET /presence como por la tool get_online_users del
// agente de IA (src/routes/ai.ts) — presenceMap es en memoria (no hay tabla
// en BD), así que se expone esta función en vez de duplicar el filtrado.
export function getActivePresence(): { id: number; name: string }[] {
  const now    = Date.now()
  const pid    = getPropertyId()
  const active = [...presenceMap.values()]
    .filter(v => v.propertyId === pid && now - v.seenAt < PRESENCE_TTL)
    .map(v => ({ id: v.id, name: v.name }))
  for (const [k, v] of presenceMap) if (now - v.seenAt >= PRESENCE_TTL) presenceMap.delete(k)
  return active
}

app.get('/presence', async (c) => {
  return c.json({ data: getActivePresence() })
})

const ROLES = ['recepcion','conserje','mantenimiento','direccion','limpieza','cocina'] as const

const userSchema = z.object({
  email:     z.string().email(),
  firstName: z.string().min(1),
  lastName:  z.string().min(1),
  password:  z.string().min(6).optional(),
  roles:     z.array(z.enum(ROLES)).min(1),
  active:    z.boolean().default(true),
  dni:       z.string().optional().nullable(),
  phone:     z.string().optional().nullable(),
  simplifiedAdminMode: z.boolean().optional(),
})

// GET /api/users
app.get('/', async (c) => {
  try {
    const list = await db.query.users.findMany({
      where: eq(users.propertyId, getPropertyId()),
      with: { roles: true },
      orderBy: users.firstName,
    })
    return c.json({ data: list.map(u => ({
      ...u, passwordHash: undefined,
      roles: (u.roles as any[]).map(r => r.role),
      // Solo lectura: no se puede conceder desde esta API
      isPlatformAdmin: u.isPlatformAdmin === true,
    })) })
  } catch (err) { return serverError(c, err) }
})

// POST /api/users
app.post('/', zValidator('json', userSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    if (!body.password) return c.json({ error: 'La contraseña es obligatoria' }, 422)
    const passwordHash = await Bun.password.hash(body.password)
    const [user] = await db.insert(users).values({
      propertyId: getPropertyId(), email: body.email.toLowerCase().trim(),
      firstName: body.firstName, lastName: body.lastName,
      passwordHash, active: body.active,
      dni: body.dni ?? null, phone: body.phone ?? null,
      // Solo tiene sentido para dirección — si se desmarca ese rol, no se
      // fuerza la pantalla simplificada a nadie que ya no la pueda usar.
      simplifiedAdminMode: body.roles.includes('direccion') ? (body.simplifiedAdminMode ?? false) : false,
    }).returning()
    await db.insert(userRoles).values(body.roles.map(role => ({ userId: user.id, role })))
    return c.json({ data: { ...user, passwordHash: undefined, roles: body.roles } }, 201)
  } catch (err: any) {
    // users.email es único GLOBAL (entre todos los hoteles de la plataforma)
    if (err.message?.includes('unique') || err.code === '23505') return c.json({ error: 'Ese email ya está registrado en la plataforma (los emails son únicos entre todos los hoteles). Usa otro.' }, 409)
    return serverError(c, err)
  }
})

// PATCH /api/users/:id
app.patch('/:id', zValidator('json', userSchema.partial()), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const own = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.propertyId, getPropertyId())), columns: { id: true } })
    if (!own) return notFound(c, 'Usuario')
    const updateData: Record<string, any> = { updatedAt: new Date() }
    if (body.email)     updateData.email     = body.email.toLowerCase().trim()
    if (body.firstName) updateData.firstName = body.firstName
    if (body.lastName)  updateData.lastName  = body.lastName
    if (body.active !== undefined) updateData.active = body.active
    if (body.dni  !== undefined)  updateData.dni   = body.dni
    if (body.phone !== undefined) updateData.phone = body.phone
    if (body.password)  updateData.passwordHash = await Bun.password.hash(body.password)
    if (body.simplifiedAdminMode !== undefined) {
      // Solo tiene sentido para dirección — si los roles vienen en este mismo
      // PATCH se usan esos, si no se consultan los actuales.
      const roles = body.roles ?? (await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, id))).map(r => r.role)
      updateData.simplifiedAdminMode = roles.includes('direccion') ? body.simplifiedAdminMode : false
    }

    const [updated] = await db.update(users).set(updateData).where(and(eq(users.id, id), eq(users.propertyId, getPropertyId()))).returning()
    if (!updated) return notFound(c, 'Usuario')

    if (body.roles) {
      await db.delete(userRoles).where(eq(userRoles.userId, id))
      await db.insert(userRoles).values(body.roles.map(role => ({ userId: id, role })))
    }
    const roles = await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, id))
    return c.json({ data: { ...updated, passwordHash: undefined, roles: roles.map(r => r.role) } })
  } catch (err: any) {
    if (err?.message?.includes('unique') || err?.code === '23505') return c.json({ error: 'Ese email ya está registrado en la plataforma (los emails son únicos entre todos los hoteles). Usa otro.' }, 409)
    return serverError(c, err)
  }
})

// POST /api/users/:id/send-password-reset — dirección manda a un usuario un
// correo de recuperación (mismo flujo que el autoservicio desde Login: Usuario
// → Olvidé mi contraseña). Mismo cooldown de 15 min, compartido con ese.
app.post('/:id/send-password-reset', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const user = await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.propertyId, getPropertyId())) })
    if (!user) return notFound(c, 'Usuario')
    if (!user.active) return c.json({ error: 'El usuario está desactivado' }, 422)
    if (isResetOnCooldown(user.email)) {
      return c.json({ error: 'Ya se envió un correo de recuperación a este usuario hace poco — espera unos minutos antes de volver a enviarlo' }, 429)
    }
    await sendPasswordResetLink(user)
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/users/:id — desactivar (soft)
app.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(users).set({ active: false, updatedAt: new Date() }).where(and(eq(users.id, id), eq(users.propertyId, getPropertyId()))).returning()
    if (!updated) return notFound(c, 'Usuario')
    return c.body(null, 204)
  } catch (err) { return serverError(c, err) }
})

export default app
