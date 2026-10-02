import { Hono } from 'hono'
import { db } from '../db'
import { reservations, guests, rooms, reservationNights } from '../db/schema'
import { eq, isNotNull, desc, and, gte, lte, ne, inArray } from 'drizzle-orm'
import { serverError, notFound } from '../lib/errors'
import { getPropertyId, hasFeature } from '../lib/property'
import { submitParte, consultarLote, validateGuest, isConfigured, type SesGuest } from '../lib/ses'

const app = new Hono()

// Módulo apagado → 404 en todas las rutas
app.use('*', async (c, next) => {
  if (!await hasFeature('ses')) return c.json({ error: 'Módulo no activado' }, 404)
  await next()
})

// GET /api/ses/partes — lista todos los partes enviados
app.get('/partes', async (c) => {
  try {
    const { from, to } = c.req.query()
    const conditions = [isNotNull(reservations.sesSubmittedAt), eq(reservations.propertyId, getPropertyId())]
    if (from) conditions.push(gte(reservations.sesSubmittedAt, new Date(from)))
    if (to)   conditions.push(lte(reservations.sesSubmittedAt, new Date(to + 'T23:59:59Z')))

    const rows = await db
      .select({
        id:             reservations.id,
        checkInDate:    reservations.checkInDate,
        checkOutDate:   reservations.checkOutDate,
        people:         reservations.people,
        sesSubmittedAt: reservations.sesSubmittedAt,
        sesLocutorioId: reservations.sesLocutorioId,
        status:         reservations.status,
        guestFirstName: guests.firstName,
        guestLastName:  guests.lastName,
        roomCode:       rooms.code,
      })
      .from(reservations)
      .leftJoin(guests, eq(guests.id, reservations.guestId))
      .leftJoin(rooms,  eq(rooms.id,  reservations.roomId))
      .where(and(...conditions))
      .orderBy(desc(reservations.sesSubmittedAt))

    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

// GET /api/ses/consultar/:lote — consulta estado de un lote directamente en SES
app.get('/consultar/:lote', async (c) => {
  try {
    if (!await isConfigured()) return c.json({ error: 'SES no configurado' }, 503)
    const lote = c.req.param('lote')
    const result = await consultarLote(lote)
    return c.json({ data: result })
  } catch (err) { return serverError(c, err) }
})

// POST /api/ses/submit/:reservationId
// Recoge titular + huéspedes adicionales de una reserva y los valida contra las
// reglas de SES. Devuelve null si la reserva no existe o le faltan requisitos base.
export async function collectAndValidate(id: number): Promise<
  | { error: string; status: 400 | 404 }
  | { res: NonNullable<Awaited<ReturnType<typeof db.query.reservations.findFirst>>>; allGuests: SesGuest[]; validationErrors: { field: string; message: string }[] }
> {
  const res = await db.query.reservations.findFirst({
    where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    with:  { guest: true, room: true },
  })
  if (!res)       return { error: 'Reserva no encontrada', status: 404 }
  if (!res.guest) return { error: 'La reserva no tiene huésped asociado', status: 400 }
  if (!res.room)  return { error: 'La reserva no tiene habitación asignada', status: 400 }

  // Cargar huéspedes adicionales (distintos al titular, deduplicados por guestId)
  const additionalRows = await db
    .selectDistinctOn([reservationNights.guestId], { guestId: reservationNights.guestId })
    .from(reservationNights)
    .innerJoin(guests, eq(reservationNights.guestId, guests.id))
    .where(and(
      eq(reservationNights.reservationId, id),
      eq(guests.propertyId, getPropertyId()),
      ne(reservationNights.guestId, res.guestId),
    ))

  const additionalGuests = additionalRows.length > 0
    ? await db.query.guests.findMany({ where: and(inArray(guests.id, additionalRows.map(r => r.guestId)), eq(guests.propertyId, getPropertyId())) })
    : []

  const allGuests: SesGuest[] = [res.guest as any, ...additionalGuests]

  const validationErrors = allGuests.flatMap((g, i) => {
    const errs = validateGuest(g as SesGuest, res.checkInDate)
    if (errs.length === 0) return []
    const prefix = i === 0 ? 'Titular' : `Huésped ${i + 1} (${(g as any).firstName} ${(g as any).lastName})`
    return errs.map(e => ({ ...e, field: `${prefix}: ${e.field}` }))
  })

  return { res, allGuests, validationErrors }
}

// GET /api/ses/validate/:id — pre-check local SIN enviar nada a SES
app.get('/validate/:id', async (c) => {
  try {
    const result = await collectAndValidate(Number(c.req.param('id')))
    if ('error' in result) return c.json({ data: { valid: false, errors: [{ field: 'reserva', message: result.error }] } })
    return c.json({ data: { valid: result.validationErrors.length === 0, errors: result.validationErrors, guests: result.allGuests.length } })
  } catch (err) { return serverError(c, err) }
})

app.post('/submit/:id', async (c) => {
  try {
    if (!await isConfigured()) {
      return c.json({ error: 'SES no configurado — faltan las credenciales SES_USERNAME, SES_PASSWORD, SES_CODIGO_ARRENDADOR y SES_CODIGO_ESTABLECIMIENTO del hotel' }, 503)
    }

    const id  = Number(c.req.param('id'))
    const result = await collectAndValidate(id)
    if ('error' in result) return result.status === 404 ? notFound(c, 'Reserva') : c.json({ error: result.error }, 400)

    const { res, allGuests, validationErrors } = result
    if (validationErrors.length > 0) {
      return c.json({ error: 'Datos incompletos para SES', missingFields: validationErrors }, 422)
    }

    const { lote } = await submitParte(allGuests, {
      referencia:   `RES-${res.externalCode ?? res.id}`,
      checkInDate:  res.checkInDate,
      checkOutDate: res.checkOutDate,
      numPersonas:  allGuests.length,
    })

    const [updatedRes] = await db.update(reservations)
      .set({ sesSubmittedAt: new Date(), sesLocutorioId: lote, updatedAt: new Date() })
      .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
      .returning({ checkinSesSent: reservations.checkinSesSent })

    // Si el check-in registró este paso como pendiente, marcarlo como completado
    if (updatedRes?.checkinSesSent === false) {
      await db.update(reservations)
        .set({ checkinSesSent: true, updatedAt: new Date() })
        .where(and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())))
    }

    return c.json({ data: { lote } })
  } catch (err) { return serverError(c, err) }
})

// GET /api/ses/status/:reservationId
app.get('/status/:id', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())) })
    if (!res) return notFound(c, 'Reserva')

    const lote = (res as any).sesLocutorioId ?? null

    // Si hay lote y SES está configurado, podemos consultar el estado actual
    if (lote && await isConfigured()) {
      try {
        const { codigoEstado, descEstado } = await consultarLote(lote)
        return c.json({
          data: {
            submitted:   true,
            submittedAt: (res as any).sesSubmittedAt,
            lote,
            codigoEstado,
            descEstado,
          },
        })
      } catch {
        // Si falla la consulta, devolvemos lo que tenemos en DB
      }
    }

    return c.json({
      data: {
        submitted:   !!(res as any).sesSubmittedAt,
        submittedAt: (res as any).sesSubmittedAt ?? null,
        lote,
      },
    })
  } catch (err) { return serverError(c, err) }
})

export default app
