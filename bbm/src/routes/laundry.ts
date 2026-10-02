import { Hono }        from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z }           from 'zod'
import { db }          from '../db'
import { laundryDeliveries, laundryProcessBatches, laundryProcessItems, housekeepingTasks, rooms, roomTypes, users, userRoles } from '../db/schema'
import { and, eq, desc, inArray, sql } from 'drizzle-orm'
import { serverError }   from '../lib/errors'
import { isAdmin }       from '../middleware/auth'
import type { Context }  from 'hono'
import { getPropertyId, getBranding, hasFeature } from '../lib/property'

const app = new Hono()

// Módulo opcional: lavandería
app.use('*', async (c, next) => {
  if (!(await hasFeature('laundry'))) return c.json({ error: 'Módulo de lavandería no activado' }, 404)
  await next()
})

// Hoy en la zona horaria del tenant
async function todayLocal(): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
}

// El usuario debe ser del tenant
async function ownUser(id: number): Promise<boolean> {
  return !!(await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.propertyId, getPropertyId())), columns: { id: true } }))
}

function getUserId(c: Context): number | undefined {
  const p  = c.get('jwtPayload') as any
  const id = Number(p?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

function userName(u: { firstName: string; lastName: string }): string {
  return `${u.firstName} ${u.lastName}`.trim()
}

// ── GET /api/laundry/staff ────────────────────────────────────────────────────
app.get('/staff', async (c) => {
  try {
    const list = await db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.propertyId, getPropertyId()), eq(userRoles.role, 'limpieza'), eq(users.active, true)))
      .orderBy(users.firstName)
    return c.json({ data: list.map(u => ({ id: u.id, name: userName(u) })) })
  } catch (err) { return serverError(c, err) }
})

// ── GET /api/laundry?date=YYYY-MM-DD ─────────────────────────────────────────
// Devuelve entregas y batches de procesado de forma independiente.
app.get('/', zValidator('query', z.object({ date: z.string().date().optional() })), async (c) => {
  try {
    const date = c.req.valid('query').date ?? await todayLocal()

    const rows = await db
      .select({
        delivery:         laundryDeliveries,
        deliveredByFirst: users.firstName,
        deliveredByLast:  users.lastName,
      })
      .from(laundryDeliveries)
      .leftJoin(users, eq(users.id, laundryDeliveries.deliveredById))
      .where(and(
        eq(laundryDeliveries.propertyId, getPropertyId()),
        eq(laundryDeliveries.date, date),
      ))
      .orderBy(desc(laundryDeliveries.deliveredAt))

    const batchRows = await db.query.laundryProcessBatches.findMany({
      where: (b, { and: andOp, eq: eqOp }) =>
        andOp(eqOp(b.propertyId, getPropertyId()), eqOp(b.date, date)),
      orderBy: (b, { asc }) => [asc(b.processedAt)],
    })

    const userIdSet = new Set<number>([
      ...rows.map(r => r.delivery.deliveredToId),
      ...batchRows.map(b => b.processedById),
    ])
    const userMap: Record<number, string> = {}
    if (userIdSet.size > 0) {
      const eu = await db.query.users.findMany({
        where: (u, { inArray: inn, and: andOp, eq: eqOp }) => andOp(inn(u.id, [...userIdSet]), eqOp(u.propertyId, getPropertyId())),
      })
      eu.forEach(u => { userMap[u.id] = userName(u) })
    }

    let batchItemRows: { batchId: number; itemType: string; status: string; count: number }[] = []
    if (batchRows.length > 0) {
      const batchIds = batchRows.map(b => b.id)
      const rawItems = await db.select().from(laundryProcessItems).where(inArray(laundryProcessItems.batchId, batchIds))
      batchItemRows = rawItems.map(i => ({ batchId: i.batchId, itemType: i.itemType, status: i.status, count: Number(i.count) }))
    }

    return c.json({
      data: rows.map(r => ({
        ...r.delivery,
        deliveredByName: `${r.deliveredByFirst ?? ''} ${r.deliveredByLast ?? ''}`.trim() || '—',
        deliveredToName: userMap[r.delivery.deliveredToId] ?? '—',
      })),
      batches: batchRows.map(b => ({
        id:                   b.id,
        processedById:        b.processedById,
        processedByName:      userMap[b.processedById] ?? '—',
        distributionLocation: b.distributionLocation,
        processedAt:          b.processedAt,
        items:                batchItemRows
          .filter(i => i.batchId === b.id)
          .map(i => ({ itemType: i.itemType, status: i.status, count: i.count })),
      })),
    })
  } catch (err) { return serverError(c, err) }
})

// ── GET /api/laundry/suggest ──────────────────────────────────────────────────
app.get('/suggest', zValidator('query', z.object({ date: z.string().date().optional() })), async (c) => {
  try {
    const date   = c.req.valid('query').date ?? await todayLocal()
    const userId = getUserId(c)
    if (!userId) return c.json({ data: { showerTowels: 0, handTowels: 0, sheetSets: 0, footTowels: 0, rooms: 0 } })

    const tasks = await db
      .select({
        maxOccupancy: roomTypes.maxOccupancy,
        taskType:     housekeepingTasks.taskType,
        linenChanges: housekeepingTasks.linenChanges,
      })
      .from(housekeepingTasks)
      .innerJoin(rooms,     eq(rooms.id,     housekeepingTasks.roomId))
      .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
      .where(and(
        eq(housekeepingTasks.propertyId, getPropertyId()),
        eq(housekeepingTasks.completedBy, userId),
        eq(housekeepingTasks.date, date),
        eq(housekeepingTasks.status, 'done'),
      ))

    let showerTowels = 0, handTowels = 0, sheetSets = 0, footTowels = 0, roomCount = 0
    for (const t of tasks) {
      const withLinens = t.taskType === 'departure' || (t.linenChanges?.length ?? 0) > 0
      if (withLinens) {
        showerTowels += t.maxOccupancy
        handTowels   += t.maxOccupancy
        footTowels   += t.maxOccupancy
        sheetSets    += Math.ceil(t.maxOccupancy / 2)
        roomCount++
      }
    }

    const alreadyRows = await db
      .select({
        shower: sql<number>`coalesce(sum(shower_towels), 0)`,
        hand:   sql<number>`coalesce(sum(hand_towels),   0)`,
        sheets: sql<number>`coalesce(sum(sheet_sets),    0)`,
        foot:   sql<number>`coalesce(sum(foot_towels),   0)`,
      })
      .from(laundryDeliveries)
      .where(and(
        eq(laundryDeliveries.propertyId, getPropertyId()),
        eq(laundryDeliveries.deliveredById, userId),
        eq(laundryDeliveries.date, date),
      ))
    const already = alreadyRows[0] ?? { shower: 0, hand: 0, sheets: 0, foot: 0 }

    return c.json({ data: {
      showerTowels: Math.max(0, showerTowels - Number(already.shower)),
      handTowels:   Math.max(0, handTowels   - Number(already.hand)),
      sheetSets:    Math.max(0, sheetSets    - Number(already.sheets)),
      footTowels:   Math.max(0, footTowels   - Number(already.foot)),
      rooms:        roomCount,
    } })
  } catch (err) { return serverError(c, err) }
})

const createSchema = z.object({
  date:          z.string().date().optional(),
  location:      z.string().min(1),
  deliveredToId: z.number().int().positive(),
  showerTowels:  z.number().int().min(0),
  handTowels:    z.number().int().min(0),
  sheetSets:     z.number().int().min(0),
  footTowels:    z.number().int().min(0),
  notes:         z.string().optional().nullable(),
})

// ── POST /api/laundry ─────────────────────────────────────────────────────────
app.post('/', zValidator('json', createSchema), async (c) => {
  try {
    const userId = getUserId(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const body = c.req.valid('json')
    const date = body.date ?? await todayLocal()
    if (!(await ownUser(body.deliveredToId))) return c.json({ error: 'Receptor no encontrado' }, 404)

    const [row] = await db.insert(laundryDeliveries).values({
      propertyId:    getPropertyId(),
      date,
      deliveredById: userId,
      location:      body.location,
      deliveredToId: body.deliveredToId,
      showerTowels:  body.showerTowels,
      handTowels:    body.handTowels,
      sheetSets:     body.sheetSets,
      footTowels:    body.footTowels,
      notes:         body.notes ?? null,
    }).returning()

    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

const editSchema = z.object({
  location:      z.string().min(1).optional(),
  deliveredToId: z.number().int().positive().optional(),
  showerTowels:  z.number().int().min(0).optional(),
  handTowels:    z.number().int().min(0).optional(),
  sheetSets:     z.number().int().min(0).optional(),
  footTowels:    z.number().int().min(0).optional(),
  notes:         z.string().nullable().optional(),
})

// ── PATCH /api/laundry/:id ───────────────────────────────────────────────────
app.patch('/:id', zValidator('json', editSchema), async (c) => {
  try {
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const id = Number(c.req.param('id'))
    const existing = await db.query.laundryDeliveries.findFirst({ where: and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())) })
    if (!existing)                                     return c.json({ error: 'No encontrado' }, 404)
    if (!admin && existing.deliveredById !== userId)   return c.json({ error: 'Sin permiso' }, 403)

    const body = c.req.valid('json')
    if (body.deliveredToId !== undefined && !(await ownUser(body.deliveredToId))) return c.json({ error: 'Receptor no encontrado' }, 404)
    const [row] = await db.update(laundryDeliveries)
      .set({
        ...(body.location      !== undefined && { location:      body.location }),
        ...(body.deliveredToId !== undefined && { deliveredToId: body.deliveredToId }),
        ...(body.showerTowels  !== undefined && { showerTowels:  body.showerTowels }),
        ...(body.handTowels    !== undefined && { handTowels:    body.handTowels }),
        ...(body.sheetSets     !== undefined && { sheetSets:     body.sheetSets }),
        ...(body.footTowels    !== undefined && { footTowels:    body.footTowels }),
        ...(body.notes         !== undefined && { notes:         body.notes }),
        updatedAt: new Date(),
      })
      .where(and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// ── PATCH /api/laundry/:id/confirm — receptor confirma recepción ─────────────
app.patch('/:id/confirm', zValidator('json', z.object({
  status: z.enum(['ok', 'discrepancy']),
  note:   z.string().optional().nullable(),
})), async (c) => {
  try {
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const id = Number(c.req.param('id'))
    const existing = await db.query.laundryDeliveries.findFirst({ where: and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())) })
    if (!existing)                                   return c.json({ error: 'No encontrado' }, 404)
    if (!admin && existing.deliveredToId !== userId) return c.json({ error: 'Solo el receptor puede confirmar la recepción' }, 403)

    const body = c.req.valid('json')
    const [row] = await db.update(laundryDeliveries)
      .set({
        recipientStatus:      body.status,
        recipientNote:        body.note ?? null,
        recipientConfirmedAt: new Date(),
        updatedAt:            new Date(),
      })
      .where(and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

// ── PATCH /api/laundry/:id/ack-discrepancy — entregador reconoce la discrepancia
app.patch('/:id/ack-discrepancy', async (c) => {
  try {
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const id = Number(c.req.param('id'))
    const existing = await db.query.laundryDeliveries.findFirst({ where: and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())) })
    if (!existing)                                      return c.json({ error: 'No encontrado' }, 404)
    if (existing.recipientStatus !== 'discrepancy')     return c.json({ error: 'Esta entrega no tiene discrepancia' }, 400)
    if (!admin && existing.deliveredById !== userId)    return c.json({ error: 'Solo el entregador puede reconocer la discrepancia' }, 403)

    const [row] = await db.update(laundryDeliveries)
      .set({ discrepancyAckAt: new Date(), discrepancyAckBy: userId, updatedAt: new Date() })
      .where(and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: row })
  } catch (err) { return serverError(c, err) }
})

const processBatchSchema = z.object({
  date:                 z.string().date().optional(),
  distributionLocation: z.string().min(1),
  items: z.array(z.object({
    itemType: z.enum(['shower', 'manos', 'sabanas', 'pies']),
    status:   z.enum(['listas', 'tendidas', 'en_agua', 'sucias', 'rotas']),
    count:    z.number().int().min(1),
  })).min(1),
})

// ── POST /api/laundry/process-batch ──────────────────────────────────────────
// El procesado es independiente de las entregas — el receptor declara libremente
// qué ha procesado y dónde, sin vincular a entregas concretas.
app.post('/process-batch', zValidator('json', processBatchSchema), async (c) => {
  try {
    const userId = getUserId(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const body = c.req.valid('json')
    const date = body.date ?? await todayLocal()

    const [batch] = await db.insert(laundryProcessBatches).values({
      propertyId:           getPropertyId(),
      date,
      processedById:        userId,
      distributionLocation: body.distributionLocation,
    }).returning()

    if (!batch) throw new Error('No se pudo crear el batch de procesado')

    await db.insert(laundryProcessItems).values(
      body.items.map(i => ({
        batchId:  batch.id,
        itemType: i.itemType,
        status:   i.status,
        count:    i.count,
      }))
    )

    return c.json({ data: { batchId: batch.id } })
  } catch (err) { return serverError(c, err) }
})

// ── DELETE /api/laundry/:id ───────────────────────────────────────────────────
app.delete('/:id', async (c) => {
  try {
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const id = Number(c.req.param('id'))
    const existing = await db.query.laundryDeliveries.findFirst({ where: and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())) })
    if (!existing)                                   return c.json({ error: 'No encontrado' }, 404)
    if (!admin && existing.deliveredById !== userId) return c.json({ error: 'Sin permiso' }, 403)

    await db.delete(laundryDeliveries).where(and(eq(laundryDeliveries.id, id), eq(laundryDeliveries.propertyId, getPropertyId())))
    return c.json({ data: { ok: true } })
  } catch (err) { return serverError(c, err) }
})

export default app
