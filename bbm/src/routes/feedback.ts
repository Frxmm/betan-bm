// Hilos de feedback de huéspedes — cualquier rol autenticado puede abrir,
// comentar y resolver; dirección puede además borrar. Ver db/schema/feedback.ts.
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { feedbackThreads, feedbackComments, reservations, guests, users } from '../db/schema'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { isAdmin } from '../middleware/auth'
import { notFound, serverError } from '../lib/errors'
import { getPropertyId } from '../lib/property'

const app = new Hono()
const SENTIMENT = ['positive', 'neutral', 'complaint', 'suggestion'] as const
const STATUS    = ['open', 'in_progress', 'resolved', 'wontfix'] as const
const uid = (c: any): number | null => { const n = Number((c.get('jwtPayload') as any)?.userId ?? (c.get('jwtPayload') as any)?.sub); return Number.isFinite(n) && n > 0 ? n : null }

// El hilo pertenece al tenant del JWT (los comentarios no llevan property_id)
async function ownThread(id: number): Promise<boolean> {
  const t = await db.query.feedbackThreads.findFirst({ where: and(eq(feedbackThreads.id, id), eq(feedbackThreads.propertyId, getPropertyId())), columns: { id: true } })
  return !!t
}

app.get('/', zValidator('query', z.object({ status: z.enum(STATUS).optional(), open: z.string().optional() })), async (c) => {
  try {
    const q = c.req.valid('query')
    const where = and(
      eq(feedbackThreads.propertyId, getPropertyId()),
      q.status ? eq(feedbackThreads.status, q.status)
        : q.open ? inArray(feedbackThreads.status, ['open', 'in_progress']) : undefined,
    )
    const creator = users
    const rows = await db.select({
      thread: feedbackThreads,
      reservationExternalCode: reservations.externalCode,
      guestFirstName: guests.firstName,
      guestLastName: guests.lastName,
      createdByFirstName: creator.firstName,
      createdByLastName: creator.lastName,
    }).from(feedbackThreads)
      .leftJoin(reservations, eq(feedbackThreads.reservationId, reservations.id))
      .leftJoin(guests, eq(feedbackThreads.guestId, guests.id))
      .leftJoin(creator, eq(feedbackThreads.createdBy, creator.id))
      .where(where).orderBy(desc(feedbackThreads.createdAt)).limit(300)
    const data = rows.map(r => ({
      ...r.thread,
      reservationCode: r.reservationExternalCode ?? (r.thread.reservationId ? `#${r.thread.reservationId}` : null),
      guestName: r.guestFirstName ? [r.guestFirstName, r.guestLastName].filter(Boolean).join(' ') : null,
      createdByName: r.createdByFirstName ? [r.createdByFirstName, r.createdByLastName].filter(Boolean).join(' ') : null,
    }))
    return c.json({ data })
  } catch (err) { return serverError(c, err) }
})

app.post('/', zValidator('json', z.object({
  text: z.string().min(1), sentiment: z.enum(SENTIMENT).default('neutral'), category: z.string().default('otro'),
  channel: z.string().default('verbal'), reservationId: z.number().int().optional(), guestId: z.number().int().optional(),
  assigneeId: z.number().int().optional(), dueDate: z.string().date().optional(),
})), async (c) => {
  try {
    const b = c.req.valid('json')
    const pid = getPropertyId()
    // Las referencias (reserva, huésped, responsable) deben ser del mismo tenant
    if (b.reservationId && !(await db.query.reservations.findFirst({ where: and(eq(reservations.id, b.reservationId), eq(reservations.propertyId, pid)), columns: { id: true } })))
      return notFound(c, 'Reserva')
    if (b.guestId && !(await db.query.guests.findFirst({ where: and(eq(guests.id, b.guestId), eq(guests.propertyId, pid)), columns: { id: true } })))
      return notFound(c, 'Huésped')
    if (b.assigneeId && !(await db.query.users.findFirst({ where: and(eq(users.id, b.assigneeId), eq(users.propertyId, pid)), columns: { id: true } })))
      return notFound(c, 'Usuario')
    const [row] = await db.insert(feedbackThreads).values({ ...b, propertyId: pid, createdBy: uid(c), source: 'staff' }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

app.patch('/:id', zValidator('json', z.object({
  status: z.enum(STATUS).optional(), sentiment: z.enum(SENTIMENT).optional(), category: z.string().optional(),
  assigneeId: z.number().int().nullable().optional(), dueDate: z.string().date().nullable().optional(),
})), async (c) => {
  try {
    const id = Number(c.req.param('id')); const b = c.req.valid('json')
    if (b.assigneeId && !(await db.query.users.findFirst({ where: and(eq(users.id, b.assigneeId), eq(users.propertyId, getPropertyId())), columns: { id: true } })))
      return notFound(c, 'Usuario')
    const [row] = await db.update(feedbackThreads).set({
      ...b, ...(b.status ? { resolvedAt: b.status === 'resolved' || b.status === 'wontfix' ? new Date() : null } : {}),
    }).where(and(eq(feedbackThreads.id, id), eq(feedbackThreads.propertyId, getPropertyId()))).returning()
    if (!row) return notFound(c, 'Hilo')
    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

app.get('/:id/comments', async (c) => {
  try {
    const threadId = Number(c.req.param('id'))
    if (!(await ownThread(threadId))) return notFound(c, 'Hilo')
    const rows = await db.select().from(feedbackComments).where(eq(feedbackComments.threadId, threadId)).orderBy(feedbackComments.createdAt)
    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

app.post('/:id/comments', zValidator('json', z.object({ text: z.string().min(1) })), async (c) => {
  try {
    const threadId = Number(c.req.param('id'))
    if (!(await ownThread(threadId))) return notFound(c, 'Hilo')
    const [row] = await db.insert(feedbackComments).values({ threadId, authorId: uid(c), text: c.req.valid('json').text }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

app.delete('/:id', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    await db.delete(feedbackThreads).where(and(eq(feedbackThreads.id, Number(c.req.param('id'))), eq(feedbackThreads.propertyId, getPropertyId())))
    return c.body(null, 204)
  } catch (err) { return serverError(c, err) }
})

export default app
