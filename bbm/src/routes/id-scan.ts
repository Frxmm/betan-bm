// ─── Escaneo de documentos de identidad (DNI/NIE/pasaporte) ────────────────
// Recepción fotografía el documento con el móvil (navegador, sin app nativa
// — ver frontend/views/IdScanView.tsx), el servidor extrae los datos con la
// IA (visión) y, tras que el usuario los revise/corrija, se guardan sobre el
// huésped correspondiente (titular o adicional) de la reserva.
//
// Solo se puede usar sobre reservas con check-in HOY y estado 'arriving' o
// 'confirmed' (no 'tentative' — aún no está nada confirmado; no
// 'checked_in'/posteriores — para eso ya está la ficha normal de huésped,
// sin esta restricción). Esto es DELIBERADAMENTE más estricto que
// PATCH /api/guests/:id o POST /api/reservations/:id/guests (que no tienen
// ninguna restricción de estado/fecha, se usan también para editar reservas
// de cualquier día) — por eso esta ruta no los reutiliza tal cual, repite su
// lógica de escritura con esta comprobación añadida.
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import Anthropic from '@anthropic-ai/sdk'
import { db } from '../db'
import { reservations, guests, reservationNights, rooms } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { notFound, serverError } from '../lib/errors'
import { canManageReservations } from '../middleware/auth'
import { checkBlockedGuestNames } from './guests'
import { tenantCurrencyId } from './reservations'
import { getPropertyId, getBranding, hasFeature } from '../lib/property'

import type { Context } from 'hono'

const app = new Hono()

function getUserId(c: Context): number | undefined {
  const payload = c.get('jwtPayload') as { sub?: string | number } | undefined
  const id = Number(payload?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

// Hoy en la zona horaria del tenant
async function todayLocal(): Promise<string> {
  return new Intl.DateTimeFormat('en-CA', { timeZone: (await getBranding()).timezone }).format(new Date())
}

// Cuándo se puede usar esta herramienta sobre una reserva — ver cabecera.
async function loadEligibleReservation(id: number) {
  const res = await db.query.reservations.findFirst({
    where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())),
    with: { room: true, guest: true },
  })
  if (!res) return { error: 'Reserva no encontrada' as const, status: 404 as const }
  if (res.checkInDate !== await todayLocal() || !['arriving', 'confirmed'].includes(res.status)) {
    return {
      error: 'Esta reserva no se puede completar aquí — solo vale para check-ins de hoy en estado "Por llegar" o "Confirmada"' as const,
      status: 403 as const,
    }
  }
  return { reservation: res }
}

// GET /api/id-scan/done-today — huéspedes cuyo escaneo se guardó hoy, con
// hora y empleado que lo hizo — lista "Ya realizados" de la pantalla
// principal, aparte de la lista de llegadas pendientes.
app.get('/done-today', async (c) => {
  try {
    if (!canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)
    const today = await todayLocal()
    const tz    = (await getBranding()).timezone
    const pid   = getPropertyId()

    const rows = await db.execute(sql`
      WITH scanned AS (
        SELECT g.id AS guest_id, g.first_name, g.last_name, g.id_doc_scanned_at, g.id_doc_scanned_by,
               COALESCE(
                 (SELECT r.id FROM reservations r WHERE r.guest_id = g.id AND r.property_id = ${pid} AND r.check_in_date = ${today}::date LIMIT 1),
                 (SELECT r.id FROM reservation_nights rn JOIN reservations r ON r.id = rn.reservation_id
                  WHERE rn.guest_id = g.id AND r.property_id = ${pid} AND r.check_in_date = ${today}::date LIMIT 1)
               ) AS reservation_id
        FROM guests g
        WHERE g.property_id = ${pid} AND g.id_doc_scanned_at IS NOT NULL
          AND (g.id_doc_scanned_at AT TIME ZONE ${tz})::date = ${today}::date
      )
      SELECT s.guest_id, s.first_name, s.last_name, s.id_doc_scanned_at AS scanned_at,
             u.first_name AS emp_first_name, u.last_name AS emp_last_name,
             s.reservation_id, ro.code AS room_code
      FROM scanned s
      LEFT JOIN users u        ON u.id = s.id_doc_scanned_by AND u.property_id = ${pid}
      LEFT JOIN reservations r ON r.id = s.reservation_id AND r.property_id = ${pid}
      LEFT JOIN rooms ro       ON ro.id = r.room_id
      ORDER BY s.id_doc_scanned_at DESC
    `)

    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

// GET /api/id-scan/:id/slots — titular + huéspedes adicionales ya cargados,
// y cuántos huecos quedan por rellenar (reservation.people es el total).
app.get('/:id/slots', async (c) => {
  try {
    if (!canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const loaded = await loadEligibleReservation(id)
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
    const res = loaded.reservation

    const nightRows = await db.query.reservationNights.findMany({
      where: eq(reservationNights.reservationId, id),  // la reserva ya está verificada como del tenant
      with: { guest: true, room: { columns: { code: true } } },
    })
    const seen = new Set<number>([res.guestId])
    const additional: any[] = []
    for (const night of nightRows) {
      if (night.guest && !seen.has(night.guest.id)) {
        seen.add(night.guest.id)
        additional.push({ ...night.guest, roomId: night.roomId, roomCode: (night.room as any)?.code ?? null })
      }
    }

    return c.json({
      data: {
        reservationId: res.id,
        people: res.people,
        primary: res.guest,
        additional,
        emptySlots: Math.max(0, res.people - 1 - additional.length),
      },
    })
  } catch (err) { return serverError(c, err) }
})

// ── Extracción con IA (visión) ──────────────────────────────────────────────
// La IA es un secreto de PLATAFORMA (una sola clave compartida por todos los
// tenants), no por tenant: se lee del entorno global. El módulo 'ai' del tenant
// decide si puede usarla.

let _anthropic: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (_anthropic) return _anthropic
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY no está configurada en el entorno de la plataforma')
  _anthropic = new Anthropic({ apiKey: key })
  return _anthropic
}

// Mismo modelo que usa el chat normal (ai.ts) — más barato que Sonnet (mitad
// de precio), a cambio de algo menos de precisión leyendo el documento. Si
// se notan muchos errores de lectura (sobre todo en el número de DNI/NIE,
// que ya se valida con la letra de control real al revisar), subir a
// 'claude-sonnet-5' aquí es el único cambio que haría falta.
const VISION_MODEL = 'claude-sonnet-5'

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_id_document',
  description: 'Extrae los datos de un documento de identidad (DNI, NIE, pasaporte u otro) a partir de su foto.',
  input_schema: {
    type: 'object',
    properties: {
      idDocType:          { type: 'string', enum: ['dni', 'nie', 'passport', 'driving_licence', 'other'], description: 'Tipo de documento' },
      firstName:          { type: 'string', description: 'Nombre de pila' },
      lastName:           { type: 'string', description: 'Primer apellido' },
      secondLastName:     { type: ['string', 'null'], description: 'Segundo apellido, si lo hay (típico en DNI español)' },
      gender:             { type: ['string', 'null'], enum: ['male', 'female', 'non_binary', 'unspecified', null], description: 'Sexo si aparece indicado (M/F) en el documento' },
      dateOfBirth:        { type: ['string', 'null'], description: 'Fecha de nacimiento en formato YYYY-MM-DD' },
      nationality:        { type: ['string', 'null'], description: 'Nacionalidad tal como aparece en el documento' },
      idDocNumber:        { type: ['string', 'null'], description: 'Número del documento (DNI/NIE/pasaporte)' },
      idDocSupportNumber: { type: ['string', 'null'], description: 'Número de soporte (solo DNI/NIE español, no pasaporte) — en el DNI suele ir en la parte de atrás' },
      idDocIssueDate:     { type: ['string', 'null'], description: 'Fecha de expedición YYYY-MM-DD, si aparece' },
      idDocExpiryDate:    { type: ['string', 'null'], description: 'Fecha de caducidad YYYY-MM-DD, si aparece' },
      lowConfidenceNote:  { type: ['string', 'null'], description: 'Si algún dato es dudoso/ilegible en la foto, indícalo brevemente aquí (p.ej. "número de soporte borroso") — si todo se lee con claridad, deja esto en null' },
    },
    required: ['idDocType', 'firstName', 'lastName'],
  },
}

// POST /api/id-scan/extract — body: { image: "data:image/jpeg;base64,..." }
// No escribe nada en BD — solo devuelve lo leído, para que el usuario lo
// revise/corrija antes de guardarlo con POST /:id/apply.
app.post('/extract', zValidator('json', z.object({
  image: z.string().regex(/^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=]+$/).max(8_000_000),
})), async (c) => {
  try {
    if (!canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)
    if (!(await hasFeature('ai'))) return c.json({ error: 'Módulo de IA no activado para este hotel' }, 403)
    const { image } = c.req.valid('json')
    const match = image.match(/^data:(image\/[a-z]+);base64,(.+)$/)!
    const mediaType = match[1] as 'image/jpeg' | 'image/png' | 'image/webp'
    const base64Data = match[2]!

    const response = await getAnthropicClient().messages.create({
      model: VISION_MODEL,
      max_tokens: 1024,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'extract_id_document' },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
          { type: 'text', text: 'Lee este documento de identidad y extrae sus datos con la herramienta extract_id_document. Si una foto muestra la parte de atrás de un DNI español (donde suele ir el número de soporte y los apellidos de los padres), céntrate solo en el número de soporte y deja el resto en null si ya se había leído en otra foto.' },
        ],
      }],
    })

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    if (!toolUse) return c.json({ error: 'No se pudo leer el documento en esta foto — prueba con más luz o más cerca' }, 422)

    return c.json({ data: toolUse.input })
  } catch (err) { return serverError(c, err) }
})

// ── Guardar lo extraído (y revisado) sobre un huésped de la reserva ───────────

const applyFieldsSchema = z.object({
  firstName:          z.string().min(1).optional(),
  lastName:           z.string().min(1).optional(),
  secondLastName:     z.string().nullable().optional(),
  gender:             z.enum(['male', 'female', 'non_binary', 'unspecified']).optional(),
  dateOfBirth:        z.string().date().nullable().optional(),
  nationality:        z.string().nullable().optional(),
  idDocType:          z.enum(['dni', 'nie', 'passport', 'driving_licence', 'other']).optional(),
  idDocNumber:        z.string().nullable().optional(),
  idDocSupportNumber: z.string().nullable().optional(),
  idDocIssueDate:     z.string().date().nullable().optional(),
  idDocExpiryDate:    z.string().date().nullable().optional(),
})
const applySchema = z.object({
  // guestId: huésped ya existente de ESTA reserva (titular o adicional ya
  // creado) al que sobreescribir los datos. Si no se manda, se crea un
  // huésped adicional nuevo (hueco todavía vacío).
  guestId: z.number().int().positive().optional(),
  fields:  applyFieldsSchema,
})

app.post('/:id/apply', zValidator('json', applySchema), async (c) => {
  try {
    if (!canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const { guestId, fields } = c.req.valid('json')

    const loaded = await loadEligibleReservation(id)
    if ('error' in loaded) return c.json({ error: loaded.error }, loaded.status)
    const reservation = loaded.reservation

    // Limpia campos vacíos ("" del formulario) sin pisar lo que ya hubiera.
    const cleanFields = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== ''))

    const blockedMsg = await checkBlockedGuestNames(cleanFields)
    if (blockedMsg) return c.json({ error: blockedMsg }, 422)

    const userId = getUserId(c)
    const scanMeta = { idDocScannedAt: new Date(), idDocScannedBy: userId ?? null }

    if (guestId != null) {
      // Debe ser un huésped que YA pertenezca a esta reserva (titular o
      // adicional) — no cualquier guestId del sistema.
      const belongsToReservation = guestId === reservation.guestId || !!(await db.query.reservationNights.findFirst({
        where: and(eq(reservationNights.reservationId, id), eq(reservationNights.guestId, guestId)),
      }))
      if (!belongsToReservation) return c.json({ error: 'Ese huésped no pertenece a esta reserva' }, 400)

      const [updated] = await db.update(guests).set({ ...cleanFields, ...scanMeta, updatedAt: new Date() }).where(and(eq(guests.id, guestId), eq(guests.propertyId, getPropertyId()))).returning()
      if (!updated) return notFound(c, 'Huésped')
      return c.json({ data: updated })
    }

    // Sin guestId: hueco vacío todavía sin huésped — crear uno nuevo y
    // vincularlo (misma lógica que POST /api/reservations/:id/guests).
    if (!cleanFields.firstName || !cleanFields.lastName) {
      return c.json({ error: 'Faltan nombre y apellido para crear el huésped' }, 400)
    }
    const inserted = await db.insert(guests).values({ ...(cleanFields as any), ...scanMeta, propertyId: getPropertyId() }).returning({ id: guests.id })
    const newGuestId = inserted[0]!.id

    const room = reservation.room as any
    if (!room?.roomTypeId) return c.json({ error: 'La habitación no tiene tipo configurado' }, 400)

    const checkIn  = new Date(reservation.checkInDate)
    const checkOut = new Date(reservation.checkOutDate)
    const currencyId = await tenantCurrencyId()
    const nightRows = []
    for (let d = new Date(checkIn); d < checkOut; d.setDate(d.getDate() + 1)) {
      nightRows.push({
        reservationId: id, date: d.toISOString().slice(0, 10), guestId: newGuestId,
        roomId: reservation.roomId, roomTypeId: room.roomTypeId,
        price: '0', commission: '0', currencyId, isOriginal: false,
      })
    }
    await db.insert(reservationNights).values(nightRows as any)
    await db.execute(sql`
      UPDATE reservations SET people = (
        SELECT COUNT(DISTINCT guest_id)::int FROM reservation_nights WHERE reservation_id = ${id}
      ) + 1 WHERE id = ${id} AND property_id = ${getPropertyId()}
    `)

    const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, newGuestId), eq(guests.propertyId, getPropertyId())) })
    return c.json({ data: guest }, 201)
  } catch (err) { return serverError(c, err) }
})

export default app
