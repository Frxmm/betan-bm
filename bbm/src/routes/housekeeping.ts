import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { housekeepingTasks, reservations, rooms, roomTypes, users, userRoles, breakfastNoService, breakfastServiceRatings, commonAreaTasks } from '../db/schema'
import { and, eq, lt, gt, inArray, notInArray, or } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { serverError } from '../lib/errors'
import { isAdmin } from '../middleware/auth'
import type { Context } from 'hono'
import { getPropertyId, getBranding, getSetting } from '../lib/property'

const app = new Hono()

// Hoy en la zona horaria del tenant
async function todayLocal(): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
}

// El usuario debe ser del tenant (asignaciones)
async function ownUser(id: number | null | undefined): Promise<boolean> {
  if (id == null) return true
  return !!(await db.query.users.findFirst({ where: and(eq(users.id, id), eq(users.propertyId, getPropertyId())), columns: { id: true } }))
}

// Ids de habitaciones del tenant
const tenantRoomIds = () => db.select({ id: rooms.id }).from(rooms).where(eq(rooms.propertyId, getPropertyId()))

function getUserId(c: Context): number | undefined {
  const p = c.get('jwtPayload') as any
  const id = Number(p?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

// GET /api/housekeeping?date=YYYY-MM-DD
// Genera automáticamente las tareas del día si no existen, devuelve el estado completo
app.get('/', zValidator('query', z.object({ date: z.string().date().optional() })), async (c) => {
  try {
    const date    = c.req.valid('query').date ?? await todayLocal()
    const userId  = getUserId(c)
    const admin   = isAdmin(c)

    // IDs de habitaciones virtuales (no requieren limpieza)
    const virtualRoomRows = await db
      .select({ id: rooms.id })
      .from(rooms)
      .innerJoin(roomTypes, eq(roomTypes.id, rooms.roomTypeId))
      .where(and(eq(rooms.propertyId, getPropertyId()), eq(roomTypes.isVirtual, true)))
    const virtualRoomIds = new Set(virtualRoomRows.map(r => r.id))

    // 1. Habitaciones ocupadas ese día: clientes que se quedan + salidas
    const occupied = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, getPropertyId()),
        or(
          // Cliente: entró estrictamente antes del día seleccionado, sale estrictamente después
          and(lt(reservations.checkInDate, date), gt(reservations.checkOutDate, date)),
          // Salida: check-out exactamente ese día
          eq(reservations.checkOutDate, date),
        ),
        inArray(reservations.status, ['checked_in', 'checking_out', 'checked_out']),
      ),
      with: { room: true },
    })

    // Deduplicar por roomId (podría haber salida+entrada el mismo día — priorizar salida)
    const roomMap = new Map<number, { roomId: number; roomCode: string; taskType: 'stay' | 'departure' }>()

    const addToMap = (roomId: number, roomCode: string, type: 'stay' | 'departure') => {
      if (virtualRoomIds.has(roomId)) return
      const existing = roomMap.get(roomId)
      if (!existing || type === 'departure') roomMap.set(roomId, { roomId, roomCode, taskType: type })
    }

    // Recoger IDs de habitaciones adicionales para cargar sus códigos en una sola query
    // stolenByRoom: para las salidas, si la reserva de esa habitación ya tiene el aviso marcado
    // checkedOutByRoom: para las salidas, si el huésped ya ha hecho check-out de verdad
    // (reserva en estado 'checked_out') — independiente de si la habitación ya está limpia.
    const extraRoomIds = new Set<number>()
    const stolenByRoom     = new Map<number, boolean>()
    const checkedOutByRoom = new Map<number, boolean>()
    // Nº de personas alojadas por habitación — para el mapa en vivo (Tiempo Real).
    // Viene de reservations.people, no de reservation_nights (que puede no tener
    // fila para el acompañante si no tiene huésped nombrado todavía).
    const peopleByRoom = new Map<number, number>()
    for (const r of occupied) {
      const type: 'stay' | 'departure' = r.checkOutDate === date ? 'departure' : 'stay'
      if (type === 'stay' && r.status !== 'checked_in') continue
      if (r.room) {
        addToMap(r.roomId!, (r.room as any).code, type)
        peopleByRoom.set(r.roomId!, r.people)
        if (type === 'departure') {
          stolenByRoom.set(r.roomId!, !!(r as any).stolenItemsReportedAt)
          checkedOutByRoom.set(r.roomId!, r.status === 'checked_out')
        }
      }
      for (const xid of (r.extraRoomIds ?? []) as number[]) extraRoomIds.add(xid)
    }

    if (extraRoomIds.size > 0) {
      const extraRoomRows = await db.select({ id: rooms.id, code: rooms.code })
        .from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, [...extraRoomIds])))
      const extraCodeMap = new Map(extraRoomRows.map(r => [r.id, r.code]))
      for (const r of occupied) {
        const type: 'stay' | 'departure' = r.checkOutDate === date ? 'departure' : 'stay'
        if (type === 'stay' && r.status !== 'checked_in') continue
        for (const xid of (r.extraRoomIds ?? []) as number[]) {
          const code = extraCodeMap.get(xid)
          if (code) {
            addToMap(xid, code, type)
            peopleByRoom.set(xid, r.people)
            if (type === 'departure') {
              stolenByRoom.set(xid, !!(r as any).stolenItemsReportedAt)
              checkedOutByRoom.set(xid, r.status === 'checked_out')
            }
          }
        }
      }
    }

    const roomEntries = [...roomMap.values()]

    // 2. Upsert tareas para cada habitación — actualiza taskType si cambió (ej: stay→departure)
    //    pero preserva status, assignedTo, linenChanges y notes ya guardados
    const validRoomIds = roomEntries.map(e => e.roomId)

    if (roomEntries.length > 0) {
      await db.insert(housekeepingTasks)
        .values(roomEntries.map(e => ({
          propertyId: getPropertyId(),
          date,
          roomId:     e.roomId,
          taskType:   e.taskType,
        })))
        .onConflictDoUpdate({
          target:  [housekeepingTasks.date, housekeepingTasks.roomId],
          set:     { taskType: sql`EXCLUDED.task_type` },
        })
    }

    // Eliminar tareas del día cuya habitación ya no tiene reserva válida
    await db.delete(housekeepingTasks).where(
      validRoomIds.length > 0
        ? and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.date, date), notInArray(housekeepingTasks.roomId, validRoomIds))
        : and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.date, date))
    )

    // 3. Cargar tareas (con filtro por usuario si es limpieza)
    const allTasks = await db.select().from(housekeepingTasks)
      .where(and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.date, date)))

    // 4. Personal de limpieza disponible (para el selector)
    const cleaners = await db
      .select({
        id:        users.id,
        firstName: users.firstName,
        lastName:  users.lastName,
      })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.propertyId, getPropertyId()), eq(userRoles.role, 'limpieza'), eq(users.active, true)))

    // 5. Mapa roomCode para las tareas
    const roomCodeMap = Object.fromEntries(roomEntries.map(e => [e.roomId, e.roomCode]))
    // Rellenar códigos de habitaciones que no estaban en occupied (tareas viejas del día)
    const unknownRoomIds = allTasks.map(t => t.roomId).filter(id => !roomCodeMap[id])
    if (unknownRoomIds.length > 0) {
      const extra = await db.select({ id: rooms.id, code: rooms.code })
        .from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), inArray(rooms.id, unknownRoomIds)))
      for (const r of extra) roomCodeMap[r.id] = r.code
    }

    const tasks = allTasks
      .map(t => ({
        ...t, roomCode: roomCodeMap[t.roomId] ?? '?',
        stolenItemsReported: stolenByRoom.get(t.roomId) ?? false,
        checkedOut:          checkedOutByRoom.get(t.roomId) ?? false,
        people:              peopleByRoom.get(t.roomId) ?? null,
      }))
      .sort((a, b) => (a.roomCode ?? '').localeCompare(b.roomCode ?? '', 'es', { numeric: true }))

    return c.json({ data: tasks, cleaners, date })
  } catch (err) {
    return serverError(c, err)
  }
})

const patchSchema = z.object({
  assignedTo:   z.number().int().positive().nullable().optional(),
  status:       z.enum(['pending', 'done', 'dnd']).optional(),
  linenChanges: z.array(z.string()).optional(),
  dnd:          z.boolean().optional(),
  notes:        z.string().max(300).nullable().optional(),
})

// PATCH /api/housekeeping/:id
app.patch('/:id', zValidator('json', patchSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    const body   = c.req.valid('json')

    const task = await db.query.housekeepingTasks.findFirst({ where: and(eq(housekeepingTasks.id, id), eq(housekeepingTasks.propertyId, getPropertyId())) })
    if (!task) return c.json({ error: 'Tarea no encontrada' }, 404)
    if (!(await ownUser(body.assignedTo))) return c.json({ error: 'Usuario no encontrado' }, 404)

    if (!admin) {
      // Limpieza solo puede asignarse a sí mismo o quitarse (no asignar a otros)
      if (body.assignedTo !== undefined && body.assignedTo !== userId && body.assignedTo !== null) {
        return c.json({ error: 'Solo puedes asignarte a ti mismo' }, 403)
      }
      // Limpieza puede editar tareas asignadas a él o sin asignar
      if (task.assignedTo !== null && task.assignedTo !== userId) {
        return c.json({ error: 'Esta tarea está asignada a otro compañero' }, 403)
      }
    }

    const now = new Date()
    const updates: Record<string, any> = { updatedAt: now }
    // assignedAt: momento de ESTA asignación (se usa en el informe de housekeeping
    // para medir el tiempo de respuesta desde que se asigna hasta que se completa).
    // Solo se toca si el asignado realmente cambia — reasignar al mismo no reinicia
    // el reloj, y desasignar (null) lo limpia para que la próxima asignación sea fresca.
    if (body.assignedTo !== undefined && body.assignedTo !== task.assignedTo) {
      updates.assignedTo = body.assignedTo
      updates.assignedAt = body.assignedTo !== null ? now : null
    }
    if (body.linenChanges !== undefined) updates.linenChanges = body.linenChanges
    if (body.dnd          !== undefined) updates.dnd          = body.dnd
    if (body.notes        !== undefined) updates.notes        = body.notes
    if (body.status       !== undefined) {
      updates.status = body.status
      if (body.status === 'done') {
        updates.completedAt = now
        updates.completedBy = userId
        // Si la tarea no tenía asignado, asignarla al usuario que la completa —
        // asignación y finalización caen en el mismo instante, así que el tiempo
        // de respuesta calculado sale ~0 (el informe la excluye del promedio).
        if (task.assignedTo === null && userId) {
          updates.assignedTo = userId
          updates.assignedAt = now
        }
      } else {
        updates.completedAt = null
        updates.completedBy = null
      }
    }

    const [updated] = await db.update(housekeepingTasks)
      .set(updates)
      .where(and(eq(housekeepingTasks.id, id), eq(housekeepingTasks.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// Resuelve la reserva que hace check-out en esta habitación/fecha (incluye
// habitaciones adicionales de la reserva, no solo la principal)
async function findDepartureReservation(task: { date: string; roomId: number }) {
  return db.query.reservations.findFirst({
    where: and(
      eq(reservations.propertyId, getPropertyId()),
      eq(reservations.checkOutDate, task.date),
      or(
        eq(reservations.roomId, task.roomId),
        sql`${reservations.extraRoomIds} @> ${JSON.stringify([task.roomId])}::jsonb`,
      ),
    ),
  })
}

// POST /api/housekeeping/:id/stolen-items — marcar objetos robados en una salida
// Dispara una alerta global (UrgentAlertsBar). Se quita marcando un depósito
// nuevo en la reserva, o manualmente con DELETE en este mismo endpoint.
app.post('/:id/stolen-items', async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)

    const task = await db.query.housekeepingTasks.findFirst({ where: and(eq(housekeepingTasks.id, id), eq(housekeepingTasks.propertyId, getPropertyId())) })
    if (!task) return c.json({ error: 'Tarea no encontrada' }, 404)
    if (task.taskType !== 'departure') return c.json({ error: 'Solo aplica a salidas' }, 422)

    const res = await findDepartureReservation(task)
    if (!res) return c.json({ error: 'No se encontró la reserva de esta salida' }, 404)

    await db.update(reservations)
      .set({ stolenItemsReportedAt: new Date(), stolenItemsReportedBy: userId ?? null })
      .where(and(eq(reservations.id, res.id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ data: { reservationId: res.id } })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/housekeeping/:id/stolen-items — desmarcar manualmente
app.delete('/:id/stolen-items', async (c) => {
  try {
    const id = Number(c.req.param('id'))

    const task = await db.query.housekeepingTasks.findFirst({ where: and(eq(housekeepingTasks.id, id), eq(housekeepingTasks.propertyId, getPropertyId())) })
    if (!task) return c.json({ error: 'Tarea no encontrada' }, 404)
    if (task.taskType !== 'departure') return c.json({ error: 'Solo aplica a salidas' }, 422)

    const res = await findDepartureReservation(task)
    if (!res) return c.json({ error: 'No se encontró la reserva de esta salida' }, 404)

    await db.update(reservations)
      .set({ stolenItemsReportedAt: null, stolenItemsReportedBy: null })
      .where(and(eq(reservations.id, res.id), eq(reservations.propertyId, getPropertyId())))

    return c.json({ data: { reservationId: res.id } })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/housekeeping/assign-bulk — asignar bloque de habitaciones a un limpiador
app.post('/assign-bulk', zValidator('json', z.object({
  date:       z.string().date(),
  taskIds:    z.array(z.number().int().positive()),
  assignedTo: z.number().int().positive().nullable(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { date, taskIds, assignedTo } = c.req.valid('json')
    if (!(await ownUser(assignedTo))) return c.json({ error: 'Usuario no encontrado' }, 404)
    await db.update(housekeepingTasks)
      .set({ assignedTo, assignedAt: assignedTo !== null ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(housekeepingTasks.propertyId, getPropertyId()),
        eq(housekeepingTasks.date, date),
        inArray(housekeepingTasks.id, taskIds),
      ))
    return c.json({ success: true, count: taskIds.length })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── Zonas comunes ────────────────────────────────────────────────────────────
// Lista fija (no editable desde la UI) — a diferencia de las habitaciones, estas
// zonas no salen de ninguna reserva, así que no hay nada que "generar" salvo
// crear la fila de cada una la primera vez que se pide un día (ver GET más abajo).
// isBathroom: zonas con botón aparte de "Papel Higiénico" (reposición, marca
// independiente de si la zona está limpia).
export const COMMON_AREAS: { key: string; label: string; isBathroom: boolean }[] = [
  { key: 'bathroom_reception',  label: 'Baño hombres y mujeres Recepción', isBathroom: true },
  { key: 'bathroom_floor2',     label: 'Baños Planta 2',                  isBathroom: true },
  { key: 'reception',           label: 'Recepción',                       isBathroom: false },
  { key: 'dining_room',         label: 'Comedor',                         isBathroom: false },
  { key: 'lounge_floor2',       label: 'Salón Planta 2',                  isBathroom: false },
  { key: 'hallways_floor1',     label: 'Pasillos Planta 1',               isBathroom: false },
  { key: 'hallways_floor2',     label: 'Pasillos Planta 2',               isBathroom: false },
  { key: 'hallways_floor3',     label: 'Pasillos Planta 3',               isBathroom: false },
  { key: 'hallways_floor4',     label: 'Pasillos Planta 4',               isBathroom: false },
  { key: 'hallways_floor5',     label: 'Pasillos Planta 5',               isBathroom: false },
  { key: 'stairs_elevator_low', label: 'Escalera y Ascensor Bajo',        isBathroom: false },
  { key: 'elevator_high',       label: 'Ascensor Alto',                   isBathroom: false },
]

// GET /api/housekeeping/common-areas?date=YYYY-MM-DD
app.get('/common-areas', zValidator('query', z.object({ date: z.string().date().optional() })), async (c) => {
  try {
    const date = c.req.valid('query').date ?? await todayLocal()

    // Crea la fila de cada zona para este día si no existía ya — así todas
    // tienen un id real con el que asignar/marcar desde el primer momento.
    await db.insert(commonAreaTasks)
      .values(COMMON_AREAS.map(a => ({ propertyId: getPropertyId(), date, areaKey: a.key })))
      .onConflictDoNothing({ target: [commonAreaTasks.propertyId, commonAreaTasks.date, commonAreaTasks.areaKey] })

    const rows = await db.select().from(commonAreaTasks).where(and(eq(commonAreaTasks.propertyId, getPropertyId()), eq(commonAreaTasks.date, date)))
    const byKey = new Map(rows.map(r => [r.areaKey, r]))

    const cleaners = await db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .where(and(eq(users.propertyId, getPropertyId()), eq(userRoles.role, 'limpieza'), eq(users.active, true)))

    // Nombres de quien asignó/completó/repuso papel — no se limita al personal
    // de limpieza (dirección/recepción también pueden marcarlo), así que se
    // resuelve aparte contra todos los usuarios implicados.
    const userIds = new Set<number>()
    for (const r of rows) {
      if (r.assignedTo)     userIds.add(r.assignedTo)
      if (r.completedBy)    userIds.add(r.completedBy)
      if (r.paperRefilledBy) userIds.add(r.paperRefilledBy)
    }
    const nameRows = userIds.size > 0
      ? await db.select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
          .from(users).where(and(eq(users.propertyId, getPropertyId()), inArray(users.id, [...userIds])))
      : []
    const nameById = new Map(nameRows.map(u => [u.id, `${u.firstName} ${u.lastName}`]))

    const data = COMMON_AREAS.map(a => {
      const row = byKey.get(a.key)!
      return {
        ...row, ...a,
        assignedToName:      row.assignedTo      ? nameById.get(row.assignedTo)      ?? null : null,
        completedByName:     row.completedBy     ? nameById.get(row.completedBy)     ?? null : null,
        paperRefilledByName: row.paperRefilledBy ? nameById.get(row.paperRefilledBy) ?? null : null,
      }
    })

    return c.json({ data, cleaners, date })
  } catch (err) {
    return serverError(c, err)
  }
})

const commonAreaPatchSchema = z.object({
  assignedTo:     z.number().int().positive().nullable().optional(),
  status:         z.enum(['pending', 'done']).optional(),
  paperRefilled:  z.boolean().optional(),
})

// PATCH /api/housekeeping/common-areas/:id
app.patch('/common-areas/:id', zValidator('json', commonAreaPatchSchema), async (c) => {
  try {
    const id     = Number(c.req.param('id'))
    const userId = getUserId(c)
    const admin  = isAdmin(c)
    const body   = c.req.valid('json')

    const task = await db.query.commonAreaTasks.findFirst({ where: and(eq(commonAreaTasks.id, id), eq(commonAreaTasks.propertyId, getPropertyId())) })
    if (!task) return c.json({ error: 'Zona no encontrada' }, 404)
    if (!(await ownUser(body.assignedTo))) return c.json({ error: 'Usuario no encontrado' }, 404)

    if (!admin) {
      if (body.assignedTo !== undefined && body.assignedTo !== userId && body.assignedTo !== null) {
        return c.json({ error: 'Solo puedes asignarte a ti mismo' }, 403)
      }
      if (task.assignedTo !== null && task.assignedTo !== userId) {
        return c.json({ error: 'Esta zona está asignada a otro compañero' }, 403)
      }
    }

    const now = new Date()
    const updates: Record<string, any> = { updatedAt: now }
    if (body.assignedTo !== undefined && body.assignedTo !== task.assignedTo) {
      updates.assignedTo = body.assignedTo
      updates.assignedAt = body.assignedTo !== null ? now : null
    }
    if (body.status !== undefined) {
      updates.status = body.status
      if (body.status === 'done') {
        updates.completedAt = now
        updates.completedBy = userId
        if (task.assignedTo === null && userId) {
          updates.assignedTo = userId
          updates.assignedAt = now
        }
      } else {
        updates.completedAt = null
        updates.completedBy = null
      }
    }
    if (body.paperRefilled !== undefined) {
      updates.paperRefilledAt = body.paperRefilled ? now : null
      updates.paperRefilledBy = body.paperRefilled ? (userId ?? null) : null
    }

    const [updated] = await db.update(commonAreaTasks)
      .set(updates)
      .where(and(eq(commonAreaTasks.id, id), eq(commonAreaTasks.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/housekeeping/common-areas/assign-bulk
app.post('/common-areas/assign-bulk', zValidator('json', z.object({
  date:       z.string().date(),
  taskIds:    z.array(z.number().int().positive()),
  assignedTo: z.number().int().positive().nullable(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { date, taskIds, assignedTo } = c.req.valid('json')
    if (!(await ownUser(assignedTo))) return c.json({ error: 'Usuario no encontrado' }, 404)
    await db.update(commonAreaTasks)
      .set({ assignedTo, assignedAt: assignedTo !== null ? new Date() : null, updatedAt: new Date() })
      .where(and(
        eq(commonAreaTasks.propertyId, getPropertyId()),
        eq(commonAreaTasks.date, date),
        inArray(commonAreaTasks.id, taskIds),
      ))
    return c.json({ success: true, count: taskIds.length })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/housekeeping/breakfast?date=YYYY-MM-DD
app.get('/breakfast', zValidator('query', z.object({ date: z.string().date().optional() })), async (c) => {
  try {
    const date = c.req.valid('query').date ?? await todayLocal()

    // 1. Desayunos por tarifa (HD / HyD / Desayuno) — una fila por reserva
    // No se usa UNION ALL con extra_room_ids porque r.people ya representa el total
    // de personas de toda la reserva; duplicar la fila provocaría doble conteo.
    const pid = getPropertyId()
    // Títulos de tarifa que incluyen desayuno (por tenant; por defecto HD / HyD / desayuno)
    const bfPatterns = ((await getSetting<string[]>('breakfast.rateTitlePatterns')) ?? ['HD', 'HyD', 'desayuno']).map(p => `%${p}%`)
    const bfPatternsSql = sql`ARRAY[${sql.join(bfPatterns.map(p => sql`${p}`), sql`, `)}]::text[]`
    const rateRows = await db.execute(sql`
      SELECT
        r.id            AS reservation_id,
        GREATEST(
          r.people,
          1 + (
            SELECT COUNT(DISTINCT rn.guest_id)::int
            FROM reservation_nights rn
            WHERE rn.reservation_id = r.id AND rn.guest_id != r.guest_id
          )
        )               AS people,
        ro.code         AS room_code,
        (
          SELECT string_agg(xro.code, ', ' ORDER BY xro.code)
          FROM jsonb_array_elements_text(COALESCE(r.extra_room_ids, '[]'::jsonb)) AS xrid
          JOIN rooms xro ON xro.id = xrid::int
        )               AS extra_room_codes,
        g.first_name,
        g.last_name,
        rt.title        AS rate_title,
        EXISTS (
          SELECT 1 FROM breakfast_logs bl
          WHERE bl.reservation_id = r.id AND bl.date = ${date}::date AND bl.extra_id IS NULL
        ) AS served,
        (
          SELECT u.first_name || ' ' || u.last_name
          FROM breakfast_logs bl JOIN users u ON u.id = bl.served_by
          WHERE bl.reservation_id = r.id AND bl.date = ${date}::date AND bl.extra_id IS NULL
        ) AS served_by_name
      FROM reservations r
      JOIN rooms  ro ON ro.id = r.room_id
      JOIN guests g  ON g.id  = r.guest_id
      JOIN rates  rt ON rt.id = r.rate_id
      WHERE r.property_id = ${pid}
        AND r.status NOT IN ('cancelled', 'no_show')
        AND r.check_in_date  < ${date}::date
        AND r.check_out_date >= ${date}::date
        AND rt.title ILIKE ANY(${bfPatternsSql})
      ORDER BY room_code
    `) as unknown as {
      reservation_id: number; people: number; room_code: string; extra_room_codes: string | null
      first_name: string; last_name: string; rate_title: string; served: boolean; served_by_name: string | null
    }[]

    // 2. Extras de desayuno comprados con unidades restantes
    const extraRows = await db.execute(sql`
      SELECT
        rsi.id                                          AS extra_id,
        rsi.reservation_id,
        rsi.quantity,
        GREATEST(
          r.people,
          1 + (
            SELECT COUNT(DISTINCT rn.guest_id)::int
            FROM reservation_nights rn
            WHERE rn.reservation_id = r.id AND rn.guest_id != r.guest_id
          )
        )                                               AS people,
        ro.code                                         AS room_code,
        g.first_name,
        g.last_name,
        si.title                                        AS item_title,
        (
          SELECT COUNT(*) FROM breakfast_logs bl
          WHERE bl.extra_id = rsi.id
        )                                               AS times_served,
        EXISTS (
          SELECT 1 FROM breakfast_logs bl
          WHERE bl.reservation_id = rsi.reservation_id AND bl.date = ${date}::date AND bl.extra_id = rsi.id
        ) AS served,
        (
          SELECT u.first_name || ' ' || u.last_name
          FROM breakfast_logs bl JOIN users u ON u.id = bl.served_by
          WHERE bl.reservation_id = rsi.reservation_id AND bl.date = ${date}::date AND bl.extra_id = rsi.id
        ) AS served_by_name
      FROM reservation_sale_items rsi
      JOIN reservations r  ON r.id  = rsi.reservation_id
      JOIN rooms        ro ON ro.id = r.room_id
      JOIN guests       g  ON g.id  = r.guest_id
      JOIN sale_items   si ON si.id = rsi.sale_item_id
      WHERE r.property_id = ${pid}
        AND r.status NOT IN ('cancelled', 'no_show')
        AND r.check_in_date  <= ${date}::date
        AND r.check_out_date >= ${date}::date
        AND si.title ILIKE '%desayuno%'
      ORDER BY ro.code
    `) as unknown as {
      extra_id: number; reservation_id: number; quantity: number; people: number
      room_code: string; first_name: string; last_name: string
      item_title: string; times_served: number; served: boolean; served_by_name: string | null
    }[]

    const extras = extraRows
      .map(e => ({
        ...e,
        remaining: Math.max(0, e.quantity - Number(e.times_served) * Math.max(1, Number(e.people))),
      }))
      .filter(e => e.remaining > 0 || e.served)

    const noServiceRow = await db.query.breakfastNoService.findFirst({ where: and(eq(breakfastNoService.propertyId, pid), eq(breakfastNoService.date, date)) })
    const ratingRow    = await db.query.breakfastServiceRatings.findFirst({ where: and(eq(breakfastServiceRatings.propertyId, pid), eq(breakfastServiceRatings.date, date)) })
    return c.json({ date, rateBreakfasts: rateRows, extraBreakfasts: extras, noService: !!noServiceRow, serviceRating: ratingRow ?? null })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/housekeeping/breakfast/serve — marcar desayuno como servido
app.post('/breakfast/serve', zValidator('json', z.object({
  reservationId: z.number().int().positive(),
  date:          z.string().date(),
  extraId:       z.number().int().positive().nullable().optional(),
})), async (c) => {
  try {
    const { reservationId, date, extraId = null } = c.req.valid('json')
    const userId = getUserId(c)
    const own = await db.query.reservations.findFirst({ where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!own) return c.json({ error: 'Reserva no encontrada' }, 404)
    await db.execute(sql`
      INSERT INTO breakfast_logs (reservation_id, date, extra_id, served_by)
      VALUES (${reservationId}, ${date}::date, ${extraId}, ${userId ?? null})
      ON CONFLICT DO NOTHING
    `)
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/housekeeping/breakfast/serve — desmarcar desayuno
app.delete('/breakfast/serve', zValidator('json', z.object({
  reservationId: z.number().int().positive(),
  date:          z.string().date(),
  extraId:       z.number().int().positive().nullable().optional(),
})), async (c) => {
  try {
    const { reservationId, date, extraId = null } = c.req.valid('json')
    const own = await db.query.reservations.findFirst({ where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!own) return c.json({ error: 'Reserva no encontrada' }, 404)
    if (extraId != null) {
      await db.execute(sql`
        DELETE FROM breakfast_logs
        WHERE reservation_id = ${reservationId} AND date = ${date}::date AND extra_id = ${extraId}
      `)
    } else {
      await db.execute(sql`
        DELETE FROM breakfast_logs
        WHERE reservation_id = ${reservationId} AND date = ${date}::date AND extra_id IS NULL
      `)
    }
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// PUT /api/housekeeping/breakfast/rating — valorar el servicio de desayunos del
// día (1-10: 1 muchas quejas, 5 alguna queja, 10 ninguna queja/perfecto). Una
// vez al día — si ya existía, se sobreescribe (rectificar antes de cerrar el día).
app.put('/breakfast/rating', zValidator('json', z.object({
  date:   z.string().date(),
  rating: z.number().int().min(1).max(10),
  notes:  z.string().max(500).optional(),
})), async (c) => {
  try {
    const { date, rating, notes } = c.req.valid('json')
    const userId = getUserId(c)
    await db.insert(breakfastServiceRatings)
      .values({ propertyId: getPropertyId(), date, rating, notes: notes ?? null, ratedBy: userId ?? null })
      .onConflictDoUpdate({ target: [breakfastServiceRatings.propertyId, breakfastServiceRatings.date], set: { rating, notes: notes ?? null, ratedBy: userId ?? null, ratedAt: new Date() } })
    return c.json({ success: true })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/housekeeping/breakfast/no-service — marcar que hoy no se ha servido desayuno
app.post('/breakfast/no-service', zValidator('json', z.object({ date: z.string().date() })), async (c) => {
  try {
    const { date } = c.req.valid('json')
    const userId = getUserId(c)
    await db.insert(breakfastNoService)
      .values({ propertyId: getPropertyId(), date, markedBy: userId ?? null })
      .onConflictDoNothing()
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/housekeeping/breakfast/no-service — desmarcar
app.delete('/breakfast/no-service', zValidator('json', z.object({ date: z.string().date() })), async (c) => {
  try {
    const { date } = c.req.valid('json')
    await db.delete(breakfastNoService).where(and(eq(breakfastNoService.propertyId, getPropertyId()), eq(breakfastNoService.date, date)))
    return c.json({ success: true })
  } catch (err) { return serverError(c, err) }
})

export default app
