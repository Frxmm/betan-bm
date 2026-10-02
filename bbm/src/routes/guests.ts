import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { guests, reservations, properties } from '../db/schema'
import { eq, or, ilike, asc, desc, count, and, gte, lte, inArray, type SQL, sql } from 'drizzle-orm'
import { notFound, serverError } from '../lib/errors'
import { getPropertyId } from '../lib/property'
import MUNICIPALITIES from '../../frontend/data/municipalities.json'

const app = new Hono()

// ─── Provincias por prefijo INE (2 primeros dígitos del código de municipio) ──
const PROVINCE_NAMES: Record<string, string> = {
  '01': 'Álava', '02': 'Albacete', '03': 'Alicante', '04': 'Almería', '05': 'Ávila',
  '06': 'Badajoz', '07': 'Baleares', '08': 'Barcelona', '09': 'Burgos', '10': 'Cáceres',
  '11': 'Cádiz', '12': 'Castellón', '13': 'Ciudad Real', '14': 'Córdoba', '15': 'A Coruña',
  '16': 'Cuenca', '17': 'Girona', '18': 'Granada', '19': 'Guadalajara', '20': 'Gipuzkoa',
  '21': 'Huelva', '22': 'Huesca', '23': 'Jaén', '24': 'León', '25': 'Lleida',
  '26': 'La Rioja', '27': 'Lugo', '28': 'Madrid', '29': 'Málaga', '30': 'Murcia',
  '31': 'Navarra', '32': 'Ourense', '33': 'Asturias', '34': 'Palencia', '35': 'Las Palmas',
  '36': 'Pontevedra', '37': 'Salamanca', '38': 'S.C. Tenerife', '39': 'Cantabria', '40': 'Segovia',
  '41': 'Sevilla', '42': 'Soria', '43': 'Tarragona', '44': 'Teruel', '45': 'Toledo',
  '46': 'Valencia', '47': 'Valladolid', '48': 'Bizkaia', '49': 'Zamora', '50': 'Zaragoza',
  '51': 'Ceuta', '52': 'Melilla',
}

function normTxt(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// Bloquea nombres/apellidos "placeholder" configurados en Reservas → Configuración
// (p.ej. "Recepción", "Hotel", el nombre del establecimiento). Comparación exacta normalizada (sin
// mayúsculas ni acentos) — solo revisa los campos presentes en `fields`.
export async function checkBlockedGuestNames(fields: {
  firstName?: string; lastName?: string; secondLastName?: string | null
}): Promise<string | null> {
  const prop = await db.query.properties.findFirst({
    where: eq(properties.id, getPropertyId()),
    columns: { blockedGuestNames: true },
  })
  const blocked = new Set((prop?.blockedGuestNames ?? []).map(normTxt))
  if (blocked.size === 0) return null

  const checks: [string, string | null | undefined][] = [
    ['nombre', fields.firstName], ['apellido', fields.lastName], ['segundo apellido', fields.secondLastName],
  ]
  for (const [label, val] of checks) {
    if (val && blocked.has(normTxt(val))) {
      return `"${val}" no se puede usar como ${label} — está en la lista de nombres bloqueados (Reservas → Configuración)`
    }
  }
  return null
}

// nombre de municipio normalizado → código INE (para ciudades sin INE, ej. enrich FDM)
const MUNI_BY_NAME = new Map<string, string>(
  (MUNICIPALITIES as { code: string; name: string }[]).map(m => [normTxt(m.name), m.code])
)

function buildOrder(sortBy: string, sortDir: 'asc' | 'desc') {
  const colMap: Record<string, any> = {
    lastName:         guests.lastName,
    email:            guests.email,
    dateOfBirth:      guests.dateOfBirth,
    nationality:      guests.nationality,
    guestRating:      guests.guestRating,
    hotelRating:      guests.hotelRating,
    createdAt:        guests.createdAt,
    // OJO: cualificar guests.id a mano — drizzle renderiza ${guests.id} sin tabla
    // dentro de sql`` y el scope interno de la subconsulta lo captura (reservations.id)
    reservationCount: sql`(SELECT COUNT(*)::int FROM reservations r WHERE r.guest_id = guests.id)`,
    totalNights:      sql`(SELECT COALESCE(SUM(r.nights),0)::int FROM reservations r WHERE r.guest_id = guests.id)`,
  }
  const col = colMap[sortBy] ?? guests.createdAt
  return sortDir === 'asc' ? asc(col) : desc(col)
}

const guestSchema = z.object({
  firstName:          z.string().min(1),
  lastName:           z.string().min(1),
  secondLastName:     z.string().nullable().optional(),
  email:              z.string().email().optional().or(z.literal('')),
  phone:              z.string().optional(),
  gender:             z.enum(['male', 'female', 'non_binary', 'unspecified']).default('unspecified'),
  dateOfBirth:        z.string().date().optional(),
  nationality:        z.string().optional(),
  idDocType:          z.enum(['dni', 'nie', 'passport', 'driving_licence', 'other']).optional(),
  idDocNumber:        z.string().optional(),
  idDocSupportNumber: z.string().optional(),
  idDocIssuer:        z.string().optional(),
  idDocIssueDate:     z.string().date().optional(),
  idDocExpiryDate:    z.string().date().optional(),
  address1:              z.string().optional(),
  zipCode:               z.string().optional(),
  city:                  z.string().optional(),
  cityIneCode:           z.string().optional(),
  addressCountryCode:    z.string().length(2).optional(),
  countryId:             z.number().int().optional(),
  isVip:              z.boolean().default(false),
  blacklistReason:    z.string().nullable().optional(),
  blacklistSeverity:  z.string().nullable().optional(),
  purposeOfStay:      z.string().optional(),
  emailConsentGiven:  z.boolean().default(false),
  guestRating:        z.number().int().min(1).max(5).nullable().optional(),
  hotelRating:        z.number().int().min(1).max(5).nullable().optional(),
})

// GET /api/guests — listar y buscar huéspedes
app.get('/', zValidator('query', z.object({
  q:           z.string().optional(),
  nationality: z.string().max(2).optional(),
  stayFrom:    z.string().optional(),
  stayTo:      z.string().optional(),
  sortBy:    z.enum(['lastName','email','dateOfBirth','nationality','reservationCount','totalNights','guestRating','hotelRating','createdAt']).default('createdAt'),
  sortDir:   z.enum(['asc','desc']).default('desc'),
  page:      z.coerce.number().int().min(1).default(1),
  limit:     z.coerce.number().int().min(1).max(100).default(50),
})), async (c) => {
  try {
    const { q, nationality, stayFrom, stayTo, sortBy, sortDir, page, limit } = c.req.valid('query')
    const offset = (page - 1) * limit

    const conditions: SQL[] = [eq(guests.propertyId, getPropertyId())]

    if (q) {
      const tokens = q.trim().split(/\s+/).filter(Boolean)
      const qCondition = tokens.length > 1
        ? and(...tokens.map(t => or(
            ilike(guests.firstName, `%${t}%`),
            ilike(guests.lastName, `%${t}%`),
            ilike(guests.email, `%${t}%`),
            ilike(guests.phone, `%${t}%`),
            ilike(guests.idDocNumber, `%${t}%`),
          )!))
        : or(
            ilike(guests.firstName, `%${q}%`),
            ilike(guests.lastName, `%${q}%`),
            ilike(guests.email, `%${q}%`),
            ilike(guests.phone, `%${q}%`),
            ilike(guests.idDocNumber, `%${q}%`),
          )
      conditions.push(qCondition!)
     }

    if (nationality && nationality.length === 2) {
      conditions.push(ilike(guests.nationality, nationality))
    }

    if (stayFrom || stayTo) {
      const dateConds: SQL[] = []
      if (stayFrom) dateConds.push(lte(reservations.checkInDate, stayTo ?? '9999-12-31'))
      if (stayTo)   dateConds.push(gte(reservations.checkOutDate, stayFrom ?? '0001-01-01'))
      const sub = db.select({ guestId: reservations.guestId }).from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), ...dateConds))
      conditions.push(inArray(guests.id, sub))
    }

    const where = conditions.length === 0 ? undefined
                : conditions.length === 1 ? conditions[0]
                : and(...conditions as [SQL, SQL, ...SQL[]])

    const [list, total] = await Promise.all([
      db.select({
        id:                 guests.id,
        propertyId:         guests.propertyId,
        firstName:          guests.firstName,
        lastName:           guests.lastName,
        secondLastName:     guests.secondLastName,
        title:              guests.title,
        gender:             guests.gender,
        email:              guests.email,
        phone:              guests.phone,
        dateOfBirth:        guests.dateOfBirth,
        nationality:        guests.nationality,
        idDocType:          guests.idDocType,
        idDocNumber:        guests.idDocNumber,
        idDocSupportNumber: guests.idDocSupportNumber,
        idDocIssuer:        guests.idDocIssuer,
        idDocIssueDate:     guests.idDocIssueDate,
        idDocExpiryDate:    guests.idDocExpiryDate,
        address1:           guests.address1,
        address2:           guests.address2,
        zipCode:               guests.zipCode,
        city:                  guests.city,
        cityIneCode:           guests.cityIneCode,
        addressCountryCode:    guests.addressCountryCode,
        countryId:             guests.countryId,
        isVip:              guests.isVip,
        blacklistReason:    guests.blacklistReason,
        blacklistSeverity:  guests.blacklistSeverity,
        purposeOfStay:      guests.purposeOfStay,
        specialInfo1:       guests.specialInfo1,
        specialInfo2:       guests.specialInfo2,
        emailConsentGiven:  guests.emailConsentGiven,
        photoUrl:           guests.photoUrl,
        guestRating:        guests.guestRating,
        hotelRating:        guests.hotelRating,
        createdAt:          guests.createdAt,
        updatedAt:          guests.updatedAt,
        reservationCount: sql<number>`(SELECT COUNT(*)::int FROM reservations r WHERE r.guest_id = guests.id)`,
        totalNights:      sql<number>`(SELECT COALESCE(SUM(r.nights),0)::int FROM reservations r WHERE r.guest_id = guests.id)`,
      }).from(guests).where(where)
        .orderBy(buildOrder(sortBy, sortDir)).limit(limit).offset(offset),
      db.select({ count: count() }).from(guests).where(where),
    ])

    return c.json({ data: list, meta: { total: total[0]?.count ?? 0, page, limit } })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/guests/stats — demografía agregada (edad + nacionalidad)
app.get('/stats', async (c) => {
  try {
    const pid = getPropertyId()
    const [summary] = await db.execute(sql`
      SELECT
        COUNT(*)::int                                                          AS total,
        COUNT(date_of_birth)::int                                              AS with_age,
        COUNT(NULLIF(nationality, ''))::int                                    AS with_nationality,
        ROUND(AVG(EXTRACT(YEAR FROM AGE(date_of_birth::date))))::int          AS avg_age
      FROM guests
      WHERE property_id = ${pid}
    `)

    const ageDist = await db.execute(sql`
      SELECT
        CASE
          WHEN date_of_birth IS NULL THEN 'unknown'
          WHEN EXTRACT(YEAR FROM AGE(date_of_birth::date)) < 18 THEN 'lt18'
          WHEN EXTRACT(YEAR FROM AGE(date_of_birth::date)) BETWEEN 18 AND 25 THEN '18_25'
          WHEN EXTRACT(YEAR FROM AGE(date_of_birth::date)) BETWEEN 26 AND 35 THEN '26_35'
          WHEN EXTRACT(YEAR FROM AGE(date_of_birth::date)) BETWEEN 36 AND 50 THEN '36_50'
          WHEN EXTRACT(YEAR FROM AGE(date_of_birth::date)) BETWEEN 51 AND 65 THEN '51_65'
          ELSE 'gt65'
        END AS bucket,
        COUNT(*)::int AS count
      FROM guests
      WHERE property_id = ${pid}
      GROUP BY bucket
    `)

    const natDist = await db.execute(sql`
      SELECT UPPER(nationality) AS nationality, COUNT(*)::int AS count
      FROM guests
      WHERE property_id = ${pid} AND nationality IS NOT NULL AND nationality != ''
      GROUP BY UPPER(nationality)
      ORDER BY count DESC
      LIMIT 30
    `)

    // Reservas por provincia española: agrupa las reservas de huéspedes con
    // ciudad en España. Provincia = 2 primeros dígitos del INE; si el huésped
    // no tiene INE (p.ej. enriquecido desde FDM), se cruza la ciudad por nombre.
    const esRows = await db.execute(sql`
      SELECT g.city, g.city_ine_code AS ine, COUNT(r.id)::int AS n
      FROM guests g
      JOIN reservations r ON r.guest_id = g.id AND r.status != 'cancelled'
      WHERE g.property_id = ${pid} AND r.property_id = ${pid}
        AND ((g.city_ine_code IS NOT NULL AND g.city_ine_code != '')
         OR (UPPER(COALESCE(g.address_country_code, '')) = 'ES' AND TRIM(COALESCE(g.city, '')) != ''))
      GROUP BY 1, 2
    `) as unknown as { city: string | null; ine: string | null; n: number }[]

    const provCount = new Map<string, number>()
    for (const row of esRows as any[]) {
      let prov: string | undefined = row.ine?.slice(0, 2)
      if (!prov && row.city) prov = MUNI_BY_NAME.get(normTxt(row.city))?.slice(0, 2)
      if (!prov || !PROVINCE_NAMES[prov]) continue
      provCount.set(prov, (provCount.get(prov) ?? 0) + Number(row.n))
    }
    const provinceDist = [...provCount.entries()]
      .map(([code, count]) => ({ code, province: PROVINCE_NAMES[code]!, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20)

    const genderDist = await db.execute(sql`
      SELECT gender, COUNT(*)::int AS count FROM guests WHERE property_id = ${pid} GROUP BY gender
    `)

    return c.json({ summary, ageDist, natDist, provinceDist, genderDist })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/guests/:id — detalle de huésped
app.get('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, id), eq(guests.propertyId, getPropertyId())) })
    if (!guest) return notFound(c, 'Huésped')
    return c.json({ data: guest })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/guests — crear huésped
app.post('/', zValidator('json', guestSchema), async (c) => {
  try {
    const body = c.req.valid('json')
    const blockedMsg = await checkBlockedGuestNames(body)
    if (blockedMsg) return c.json({ error: blockedMsg }, 422)
    const [guest] = await db.insert(guests).values({ ...body, propertyId: getPropertyId() }).returning()
    return c.json({ data: guest }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/guests/:id — actualizar huésped
app.patch('/:id', zValidator('json', guestSchema.partial()), async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const body = c.req.valid('json')

    // No se puede guardar mientras el email sea el alias temporal de Booking
    // (caduca tras la estancia): hay que registrar el email real del cliente
    const BOOKING_ALIAS = /@guest\.booking\.com$/i
    const existing = await db.query.guests.findFirst({ where: and(eq(guests.id, id), eq(guests.propertyId, getPropertyId())), columns: { email: true } })
    if (!existing) return notFound(c, 'Huésped')
    const resultingEmail = body.email !== undefined ? body.email : existing.email
    if (resultingEmail && BOOKING_ALIAS.test(resultingEmail.trim())) {
      return c.json({ error: 'Sustituye el email temporal @guest.booking.com por el email real del cliente antes de guardar' }, 422)
    }

    const blockedMsg = await checkBlockedGuestNames(body)
    if (blockedMsg) return c.json({ error: blockedMsg }, 422)

    const [updated] = await db.update(guests)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(guests.id, id), eq(guests.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Huésped')
    return c.json({ data: updated })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/guests/:id — anonimización RGPD (borra datos identificativos, conserva historial)
app.delete('/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const guest = await db.query.guests.findFirst({ where: and(eq(guests.id, id), eq(guests.propertyId, getPropertyId())) })
    if (!guest) return notFound(c, 'Huésped')

    const [updated] = await db.update(guests).set({
      email:              null,
      phone:              null,
      dateOfBirth:        null,
      nationality:        null,
      idDocType:          null,
      idDocNumber:        null,
      idDocSupportNumber: null,
      idDocIssuer:        null,
      idDocIssueDate:     null,
      idDocExpiryDate:    null,
      address1:           null,
      address2:           null,
      zipCode:            null,
      city:               null,
      cityIneCode:        null,
      countryId:          null,
      photoUrl:           null,
      documentUrl:        null,
      emailConsentGiven:  false,
      updatedAt:          new Date(),
    }).where(and(eq(guests.id, id), eq(guests.propertyId, getPropertyId()))).returning()

    return c.json({ data: { anonymized: true, id: updated.id } })
  } catch (err) {
    return serverError(c, err)
  }
})

export default app
