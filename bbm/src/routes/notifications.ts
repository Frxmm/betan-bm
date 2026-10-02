import { Hono } from 'hono'
import { db } from '../db'
import { notifications } from '../db/schema'
import { eq, desc } from 'drizzle-orm'
import { serverError } from '../lib/errors'
import { getPropertyId } from '../lib/property'

const app = new Hono()

// GET /api/notifications — lista de notificaciones del usuario actual
app.get('/', async (c) => {
  try {
    const list = await db.query.notifications.findMany({
      where: eq(notifications.propertyId, getPropertyId()),
      orderBy: desc(notifications.sentAt),
      limit: 30,
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/notifications/mark-read — marcar notificaciones como leídas
app.post('/mark-read', async (c) => {
  try {
    await db.update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.propertyId, getPropertyId()))
    return c.json({ data: { ok: true } })
  } catch (err) {
    return serverError(c, err)
  }
})

export default app
