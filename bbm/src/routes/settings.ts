import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { userPreferences, users } from '../db/schema/core'
import { eq, and, ne } from 'drizzle-orm'
import { serverError } from '../lib/errors'
import type { Context } from 'hono'
import { getPropertyId } from '../lib/property'

const app = new Hono()

function getUserId(c: Context): number {
  const payload = c.get('jwtPayload') as { sub: string | number } | undefined
  const id = Number(payload?.sub)
  if (!id) throw new Error('Sesión sin usuario')
  return id
}

const prefsSchema = z.object({
  theme:      z.enum(['dark', 'light', 'special', 'retro', 'forest', 'hotdog']),
  fontFamily: z.enum(['system', 'inter', 'georgia', 'mono']),
  fontSize:   z.number().int().min(12).max(20),
})

// GET /api/settings/me
app.get('/me', async (c) => {
  try {
    const userId = getUserId(c)
    const prefs = await db.query.userPreferences.findFirst({
      where: eq(userPreferences.userId, userId),
    })
    return c.json({ data: prefs ?? { userId, theme: 'dark', fontFamily: 'system', fontSize: 14 } })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/settings/me
app.put('/me', zValidator('json', prefsSchema), async (c) => {
  try {
    const userId = getUserId(c)
    const body = c.req.valid('json')
    const [updated] = await db
      .insert(userPreferences)
      .values({ userId, ...body, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: { ...body, updatedAt: new Date() },
      })
      .returning()
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/settings/me/profile — nombre, email y/o contraseña
app.patch('/me/profile', async (c) => {
  try {
    const userId = getUserId(c)
    const body = await c.req.json()
    const update: Record<string, any> = { updatedAt: new Date() }

    if (body.firstName?.trim()) update.firstName = body.firstName.trim()
    if (body.lastName?.trim())  update.lastName  = body.lastName.trim()

    if (body.email?.trim()) {
      const email = body.email.toLowerCase().trim()
      const taken = await db.query.users.findFirst({
        where: and(eq(users.email, email), ne(users.id, userId)),  // email único global entre todos los tenants
        columns: { id: true },
      })
      if (taken) return c.json({ error: 'Ese correo ya está en uso' }, 409)
      update.email = email
    }

    if (body.newPassword) {
      if (!body.currentPassword) return c.json({ error: 'Introduce tu contraseña actual' }, 422)
      if (body.newPassword.length < 6) return c.json({ error: 'La nueva contraseña debe tener al menos 6 caracteres' }, 422)
      const user = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.propertyId, getPropertyId())), columns: { passwordHash: true } })
      const ok = user && await Bun.password.verify(body.currentPassword, user.passwordHash)
      if (!ok) return c.json({ error: 'Contraseña actual incorrecta' }, 401)
      update.passwordHash = await Bun.password.hash(body.newPassword)
    }

    const [updated] = await db.update(users).set(update).where(and(eq(users.id, userId), eq(users.propertyId, getPropertyId()))).returning()
    const { passwordHash: _, ...safe } = updated
    return c.json({ data: safe })
  } catch (err) { return serverError(c, err) }
})

// POST /api/settings/me/avatar — subida de foto de perfil (multipart)
app.post('/me/avatar', async (c) => {
  try {
    const userId = getUserId(c)
    const formData = await c.req.formData()
    const file = formData.get('avatar') as File | null
    if (!file || !file.size) return c.json({ error: 'No se recibió ningún archivo' }, 422)
    if (!file.type.startsWith('image/')) return c.json({ error: 'Solo se aceptan imágenes' }, 422)
    if (file.size > 3 * 1024 * 1024) return c.json({ error: 'La imagen no puede superar 3 MB' }, 422)

    const ext = file.type.includes('png') ? 'png' : file.type.includes('gif') ? 'gif' : file.type.includes('webp') ? 'webp' : 'jpg'
    const filename  = `${userId}.${ext}`
    const filePath  = `public/avatars/${filename}`
    const avatarUrl = `/avatars/${filename}`

    await Bun.write(filePath, await file.arrayBuffer())
    await db.update(users).set({ avatarUrl, updatedAt: new Date() }).where(and(eq(users.id, userId), eq(users.propertyId, getPropertyId())))

    return c.json({ data: { avatarUrl } })
  } catch (err) { return serverError(c, err) }
})

// ─── Mensajería: qué mensajes salen por qué canal (solo admin) ────────────────

app.get('/messages', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { MESSAGE_CATALOG } = await import('../lib/messaging')
    const { messageSettings } = await import('../db/schema')
    const rows = await db.select().from(messageSettings).where(eq(messageSettings.propertyId, getPropertyId()))
    const saved = new Map(rows.map(r => [r.key, r]))
    const { bookingChannels } = await import('../db/schema')
    const channels = await db.select({ id: bookingChannels.id, name: bookingChannels.name })
      .from(bookingChannels).where(and(eq(bookingChannels.active, true), eq(bookingChannels.propertyId, getPropertyId())))
    const data = Object.entries(MESSAGE_CATALOG).map(([key, cat]) => ({
      key,
      label:              cat.label,
      emailAvailable:     cat.email,
      whatsappAvailable:  cat.whatsapp,
      email:              saved.get(key)?.email    ?? true,
      whatsapp:           saved.get(key)?.whatsapp ?? true,
      excludedChannelIds: (saved.get(key)?.excludedChannelIds as number[] | undefined) ?? [],
    }))
    return c.json({ data, channels })
  } catch (err) { return serverError(c, err) }
})

app.put('/messages', zValidator('json', z.object({
  key:                z.string().min(1),
  email:              z.boolean(),
  whatsapp:           z.boolean(),
  excludedChannelIds: z.array(z.number().int().positive()).max(50).default([]),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { MESSAGE_CATALOG, clearMessagingCache } = await import('../lib/messaging')
    const { messageSettings } = await import('../db/schema')
    const body = c.req.valid('json')
    if (!(body.key in MESSAGE_CATALOG)) return c.json({ error: 'Tipo de mensaje desconocido' }, 400)

    await db.insert(messageSettings)
      .values({ propertyId: getPropertyId(), key: body.key, email: body.email, whatsapp: body.whatsapp, excludedChannelIds: body.excludedChannelIds, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [messageSettings.propertyId, messageSettings.key],
        set: { email: body.email, whatsapp: body.whatsapp, excludedChannelIds: body.excludedChannelIds, updatedAt: new Date() },
      })
    clearMessagingCache()
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// ─── Plantillas de email (solo admin) ─────────────────────────────────────────

app.get('/message-templates', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { DEFAULT_EMAIL_TEMPLATES, EMAIL_TEMPLATE_VARS } = await import('../lib/messaging')
    const { messageTemplates } = await import('../db/schema')
    const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.propertyId, getPropertyId()))
    const saved = new Map(rows.map(r => [r.key, r]))
    const data = Object.entries(DEFAULT_EMAIL_TEMPLATES).map(([key, def]) => ({
      key,
      vars:      EMAIL_TEMPLATE_VARS[key] ?? [],
      subject:   saved.get(key)?.subject ?? def.subject,
      html:      saved.get(key)?.html    ?? def.html,
      custom:    saved.has(key),
    }))
    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

app.put('/message-templates', zValidator('json', z.object({
  key:     z.string().min(1),
  subject: z.string().min(1).max(200),
  html:    z.string().min(1).max(50_000),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { DEFAULT_EMAIL_TEMPLATES, clearMessagingCache } = await import('../lib/messaging')
    const { messageTemplates } = await import('../db/schema')
    const body = c.req.valid('json')
    if (!(body.key in DEFAULT_EMAIL_TEMPLATES)) return c.json({ error: 'Plantilla desconocida' }, 400)

    await db.insert(messageTemplates)
      .values({ propertyId: getPropertyId(), key: body.key, subject: body.subject, html: body.html, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: [messageTemplates.propertyId, messageTemplates.key],
        set: { subject: body.subject, html: body.html, updatedAt: new Date() },
      })
    clearMessagingCache()
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// Restaurar la plantilla de fábrica
app.delete('/message-templates/:key', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { clearMessagingCache } = await import('../lib/messaging')
    const { messageTemplates } = await import('../db/schema')
    const { eq: eqOp } = await import('drizzle-orm')
    await db.delete(messageTemplates).where(and(eqOp(messageTemplates.propertyId, getPropertyId()), eqOp(messageTemplates.key, c.req.param('key'))))
    clearMessagingCache()
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// ─── Reglas de edición de campos de reserva ───────────────────────────────────

// GET /api/settings/field-rules — cualquier usuario autenticado
app.get('/field-rules', async (c) => {
  try {
    const { reservationFieldRules } = await import('../db/schema')
    const pid = getPropertyId()
    // Un tenant nuevo no tiene filas: se siembran las reglas de fábrica (vacías = sin restricción)
    await db.insert(reservationFieldRules).values([
      { propertyId: pid, fieldKey: 'price',         label: 'Precio total' },
      { propertyId: pid, fieldKey: 'channel',       label: 'Canal de reserva' },
      { propertyId: pid, fieldKey: 'external_code', label: 'Código externo' },
      { propertyId: pid, fieldKey: 'rate',          label: 'Tarifa' },
    ]).onConflictDoNothing()
    const rows = await db.select().from(reservationFieldRules)
      .where(eq(reservationFieldRules.propertyId, pid)).orderBy(reservationFieldRules.id)
    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/settings/field-rules — solo admin/dirección
app.put('/field-rules', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { reservationFieldRules } = await import('../db/schema')
    const { eq: eqOp } = await import('drizzle-orm')
    const body: { fieldKey: string; allowedRoles: string[]; allowedChannelIds: number[] }[] = await c.req.json()
    for (const rule of body) {
      await db.update(reservationFieldRules)
        .set({ allowedRoles: rule.allowedRoles, allowedChannelIds: rule.allowedChannelIds, updatedAt: new Date() })
        .where(and(eqOp(reservationFieldRules.propertyId, getPropertyId()), eqOp(reservationFieldRules.fieldKey, rule.fieldKey)))
    }
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

// ─── Nombres/apellidos bloqueados al crear/editar huéspedes ───────────────────

// GET /api/settings/blocked-guest-names — cualquier usuario autenticado
// (necesario para que el frontend pueda validar antes de guardar, aunque el
// bloqueo real y autoritativo vive en el PATCH/POST de /api/guests)
app.get('/blocked-guest-names', async (c) => {
  try {
    const { properties } = await import('../db/schema')
    const prop = await db.query.properties.findFirst({
      where: eq(properties.id, getPropertyId()),
      columns: { blockedGuestNames: true },
    })
    return c.json({ data: prop?.blockedGuestNames ?? [] })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/settings/blocked-guest-names — solo admin/dirección
app.put('/blocked-guest-names', zValidator('json', z.object({
  names: z.array(z.string().min(1).max(80)).max(200),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { properties } = await import('../db/schema')
    const body = c.req.valid('json')
    // Dedup y recorte de espacios — la comparación real ya normaliza mayúsculas/acentos
    const names = [...new Set(body.names.map(n => n.trim()).filter(Boolean))]
    await db.update(properties)
      .set({ blockedGuestNames: names, updatedAt: new Date() })
      .where(eq(properties.id, getPropertyId()))
    return c.json({ data: names })
  } catch (err) { return serverError(c, err) }
})

// GET /api/settings/ttlock-balance-exempt-channels
app.get('/ttlock-balance-exempt-channels', async (c) => {
  try {
    const { properties } = await import('../db/schema')
    const prop = await db.query.properties.findFirst({
      where: eq(properties.id, getPropertyId()),
      columns: { ttlockBalanceExemptChannelIds: true },
    })
    return c.json({ data: prop?.ttlockBalanceExemptChannelIds ?? [] })
  } catch (err) { return serverError(c, err) }
})

// PUT /api/settings/ttlock-balance-exempt-channels — solo admin/dirección
app.put('/ttlock-balance-exempt-channels', zValidator('json', z.object({
  channelIds: z.array(z.number().int().positive()).max(200),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { properties } = await import('../db/schema')
    const body = c.req.valid('json')
    const channelIds = [...new Set(body.channelIds)]
    await db.update(properties)
      .set({ ttlockBalanceExemptChannelIds: channelIds, updatedAt: new Date() })
      .where(eq(properties.id, getPropertyId()))
    return c.json({ data: channelIds })
  } catch (err) { return serverError(c, err) }
})

export default app
