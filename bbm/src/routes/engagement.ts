// Implicación de los empleados con la plataforma — solo dirección.
// Agrega, por usuario, las acciones que dejan rastro con autor + fecha en la
// base de datos (reservas creadas, cambios de estado, cobros, notas, tareas de
// limpieza, cambios manuales de precio, alertas silenciadas, turnos de caja
// abiertos) y calcula un "rating de implicación" 0-100.
//
// El rating es una heurística transparente, NO una auditoría:
//   - Volumen (50): acciones por día activo frente a lo normal de su MISMO rol
//     (tope = 1,5 × mediana del rol) — así limpieza no se compara con recepción.
//   - Constancia (50): días con actividad frente al empleado más constante de
//     su mismo rol en el rango.
// Rating "oficial" de cada persona (lo que ve ella y lo que se muestra en el
// aviso semanal): media PONDERADA de los últimos 3 periodos de 30 días
// (50 % el más reciente, 30 % el anterior, 20 % el más antiguo; solo cuentan
// los periodos en que ya existía el usuario, con los pesos renormalizados) MÁS
// los puntos de compensación que dirección haya dado en esos 90 días
// (engagement_adjustments, vía el agente de IA). Máximo 100.
// Penalizaciones automáticas (siempre restan, no dependen de dirección): cada
// check-in hecho SIN contrato firmado (checkin_had_contract = false) o SIN parte
// SES enviado (checkin_ses_sent = false) resta PENALTY_PER_FAILURE puntos al
// periodo de 30 días en que se hizo, hasta un máximo de MAX_PENALTY por periodo.
// Solo cuentan los check-ins registrados a nombre del usuario (checked_in_by) y
// solo se penaliza a quien tiene rol de recepción.
// Limitación: solo mide lo que se registra en la plataforma. Quien trabaja
// mucho sin tocarla (o sin que quede autor en el registro) sale bajo.
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { sql } from 'drizzle-orm'
import { isAdmin } from '../middleware/auth'
import { serverError } from '../lib/errors'
import { getExternalStaffActivity, matchUserByName } from '../lib/externalStaffActivity'
import { getPropertyId, getBranding } from '../lib/property'

const app = new Hono()

const KIND_LABEL: Record<string, string> = {
  reservas: 'Reservas creadas', estados: 'Cambios de estado', cobros: 'Cobros / movimientos',
  notas: 'Notas en reservas', limpieza: 'Tareas de limpieza', precios: 'Cambios de precio',
  alertas: 'Alertas atendidas', turnos: 'Turnos de caja', desayunos: 'Desayunos marcados servidos',
  inventario: 'Inventarios (personal.)', incidencias: 'Incidencias (personal.)',
  higiene: 'Registros de higiene (personal.)', tareas: 'Tareas completadas (personal.)',
}

const PENALTY_PER_FAILURE = 4
const MAX_PENALTY = 40

const median = (xs: number[]) => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}


type Row = {
  userId: number; name: string; roles: string[]; role: string; lastLoginAt: string | null; createdAt: string | null
  total: number; activeDays: number; perActiveDay: number
  byKind: Record<string, number>; byDay: Record<string, number>; byHour: number[]
  rating: number; volumeScore: number; consistencyScore: number
  noContract: number; noSes: number; penalty: number   // resta OBLIGATORIA: check-ins sin contrato firmado / sin parte SES
  series: { day: string; n: number }[]
}

// Nombres de la plataforma externa de personal que no se pudieron emparejar con ningún usuario (última pasada).
export let lastUnmatched: string[] = []

export async function computeEngagement(from: string, to: string): Promise<Row[]> {
    const fromTs = `${from}T00:00:00+00:00`, toTs = `${to}T23:59:59+00:00`
    const pid = getPropertyId()
    const tz = (await getBranding()).timezone

    const users = await db.execute(sql`
      SELECT u.id, u.first_name, u.last_name, u.last_login_at, u.created_at,
             COALESCE((SELECT array_agg(role::text ORDER BY role::text) FROM user_roles ur WHERE ur.user_id = u.id), '{}') AS roles
      FROM users u WHERE u.property_id = ${pid} AND u.active = true AND u.is_primary = false
    `) as unknown as { id: number; first_name: string; last_name: string; last_login_at: string | null; created_at: string | null; roles: string[] | string }[]

    // Todas las acciones con autor: (user_id, ts, kind). Día en la zona horaria del tenant.
    const events = await db.execute(sql`
      SELECT user_id, kind, (ts AT TIME ZONE ${tz})::date::text AS day,
             EXTRACT(HOUR FROM ts AT TIME ZONE ${tz})::int AS hour
      FROM (
        SELECT created_by AS user_id, created_at AS ts, 'reservas' AS kind FROM reservations WHERE property_id = ${pid} AND created_by IS NOT NULL
        UNION ALL SELECT sl.user_id, sl.changed_at, 'estados' FROM reservation_status_logs sl JOIN reservations rs ON rs.id = sl.reservation_id WHERE rs.property_id = ${pid} AND sl.user_id IS NOT NULL
        UNION ALL SELECT created_by, created_at, 'cobros' FROM financial_transactions WHERE property_id = ${pid} AND created_by IS NOT NULL
        UNION ALL SELECT rn.author_id, rn.created_at, 'notas' FROM reservation_notes rn JOIN reservations rr ON rr.id = rn.reservation_id WHERE rr.property_id = ${pid} AND rn.author_id IS NOT NULL AND rn.type = 'note'
        UNION ALL SELECT completed_by, completed_at, 'limpieza' FROM housekeeping_tasks WHERE property_id = ${pid} AND completed_by IS NOT NULL AND completed_at IS NOT NULL
        UNION ALL SELECT changed_by_user_id, changed_at, 'precios' FROM price_change_log WHERE property_id = ${pid} AND changed_by_user_id IS NOT NULL
        UNION ALL SELECT silenced_by, silenced_at, 'alertas' FROM alert_events WHERE property_id = ${pid} AND silenced_by IS NOT NULL AND silenced_at IS NOT NULL
        UNION ALL SELECT opened_by, opened_at, 'turnos' FROM shifts WHERE property_id = ${pid}
        UNION ALL SELECT bl.served_by, bl.served_at, 'desayunos' FROM breakfast_logs bl JOIN reservations rb ON rb.id = bl.reservation_id WHERE rb.property_id = ${pid} AND bl.served_by IS NOT NULL
      ) e
      WHERE ts BETWEEN ${fromTs}::timestamptz AND ${toTs}::timestamptz
    `) as unknown as { user_id: number; kind: string; day: string; hour: number }[]

    // Acciones de la plataforma externa de mantenimiento/personal, solo lectura.
    // Sin hora (solo fecha): cuentan para volumen/constancia pero no para la gráfica por horas.
    const ext = await getExternalStaffActivity(from, to)
    const people = users.map(u => ({ id: Number(u.id), name: `${u.first_name} ${u.last_name}`.trim() }))
    const unmatched = new Set<string>()
    const extEvents: { user_id: number; kind: string; day: string; hour: number | null }[] = []
    for (const e of ext) {
      const id = matchUserByName(e.name, people)
      if (id == null) { unmatched.add(e.name); continue }
      extEvents.push({ user_id: id, kind: e.kind, day: e.day, hour: null })
    }
    lastUnmatched = [...unmatched]

    const failRows = await db.execute(sql`
      SELECT checked_in_by AS user_id,
             COUNT(*) FILTER (WHERE checkin_had_contract = false)::int AS no_contract,
             COUNT(*) FILTER (WHERE checkin_ses_sent = false)::int AS no_ses
      FROM reservations
      WHERE property_id = ${pid} AND checked_in_by IS NOT NULL AND checked_in_at BETWEEN ${fromTs}::timestamptz AND ${toTs}::timestamptz
      GROUP BY checked_in_by
    `) as unknown as { user_id: number; no_contract: number; no_ses: number }[]
    const fails = new Map(failRows.map(f => [Number(f.user_id), { noContract: Number(f.no_contract), noSes: Number(f.no_ses) }]))

    type Agg = { total: number; byKind: Record<string, number>; byDay: Record<string, number>; byHour: number[] }
    const agg = new Map<number, Agg>()
    for (const e of [...events, ...extEvents]) {
      const uid = Number(e.user_id)
      let a = agg.get(uid)
      if (!a) agg.set(uid, a = { total: 0, byKind: {}, byDay: {}, byHour: Array(24).fill(0) })
      a.total++
      a.byKind[e.kind] = (a.byKind[e.kind] ?? 0) + 1
      a.byDay[e.day] = (a.byDay[e.day] ?? 0) + 1
      if (e.hour != null) a.byHour[Number(e.hour)]!++
    }

    const days: string[] = []
    for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10))

    const rows = users.map(u => {
      const roles = Array.isArray(u.roles) ? u.roles : String(u.roles).replace(/[{}]/g, '').split(',').filter(Boolean)
      const a = agg.get(Number(u.id))
      const activeDays = a ? Object.keys(a.byDay).length : 0
      return {
        userId: Number(u.id), name: `${u.first_name} ${u.last_name}`.trim(), roles,
        role: roles.includes('recepcion') ? 'recepcion' : (roles[0] ?? 'sin rol'),
        lastLoginAt: u.last_login_at, createdAt: u.created_at,
        total: a?.total ?? 0, activeDays,
        perActiveDay: activeDays > 0 ? a!.total / activeDays : 0,
        byKind: a?.byKind ?? {}, byDay: a?.byDay ?? {}, byHour: a?.byHour ?? Array(24).fill(0),
      }
    })

    // Referencias por rol.
    const roleRef = new Map<string, { cap: number; maxDays: number }>()
    for (const role of new Set(rows.map(r => r.role))) {
      const g = rows.filter(r => r.role === role && r.activeDays > 0)
      roleRef.set(role, { cap: Math.max(3, 1.5 * median(g.map(r => r.perActiveDay))), maxDays: Math.max(1, ...g.map(r => r.activeDays)) })
    }

    return rows.map(r => {
      const ref = roleRef.get(r.role)!
      const volume = Math.min(1, r.perActiveDay / ref.cap) * 50
      const consistency = Math.min(1, r.activeDays / ref.maxDays) * 50
      // Solo penaliza a quien tiene rol de recepción (el que hace los check-ins).
      const f = r.roles.includes('recepcion') ? (fails.get(r.userId) ?? { noContract: 0, noSes: 0 }) : { noContract: 0, noSes: 0 }
      const penalty = Math.min(MAX_PENALTY, PENALTY_PER_FAILURE * (f.noContract + f.noSes))
      const rating = Math.max(0, Math.round(volume + consistency) - penalty)
      return {
        noContract: f.noContract, noSes: f.noSes, penalty,
        ...r,
        perActiveDay: Math.round(r.perActiveDay * 10) / 10,
        rating, volumeScore: Math.round(volume), consistencyScore: Math.round(consistency),
        series: days.map(d => ({ day: d, n: r.byDay[d] ?? 0 })),
      }
    })

}

// Ventanas de 30 días terminando hoy (zona horaria del tenant): [más reciente, anterior, más antigua].
const WEIGHTS = [0.5, 0.3, 0.2]
const isoAdd = (base: string, n: number) => { const d = new Date(`${base}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())

export type Official = { userId: number; name: string; role: string; rating: number; base: number; bonus: number; periods: { from: string; to: string; rating: number | null }[] }

// Rating oficial (ponderado 3 meses + compensaciones) de todos los empleados.
export async function computeOfficialRatings(): Promise<Official[]> {
  const today = todayIn((await getBranding()).timezone)
  const wins = [0, 1, 2].map(i => ({ from: isoAdd(today, -29 - 30 * i), to: isoAdd(today, -30 * i) }))
  const perWin = await Promise.all(wins.map(w => computeEngagement(w.from, w.to)))
  const bonusRows = await db.execute(sql`
    SELECT ea.user_id, COALESCE(SUM(ea.points), 0)::int AS pts FROM engagement_adjustments ea
    JOIN users ue ON ue.id = ea.user_id AND ue.property_id = ${getPropertyId()}
    WHERE ea.created_at >= ${`${wins[2]!.from}T00:00:00+00:00`}::timestamptz GROUP BY ea.user_id
  `) as unknown as { user_id: number; pts: number }[]
  const bonus = new Map(bonusRows.map(b => [Number(b.user_id), Number(b.pts)]))
  const base = perWin[0]!
  return base.map(u => {
    let sum = 0, wsum = 0
    const periods = wins.map((w, i) => {
      const r = perWin[i]!.find(x => x.userId === u.userId)
      // Solo cuenta el periodo si el usuario ya existía al acabar la ventana.
      const existed = u.createdAt ? new Date(u.createdAt) <= new Date(`${w.to}T23:59:59Z`) : true
      if (!r || !existed) return { ...w, rating: null }
      sum += WEIGHTS[i]! * r.rating; wsum += WEIGHTS[i]!
      return { ...w, rating: r.rating }
    })
    const b = wsum > 0 ? sum / wsum : 0
    const bonusPts = bonus.get(u.userId) ?? 0
    return { userId: u.userId, name: u.name, role: u.role, base: Math.round(b), bonus: bonusPts, rating: Math.max(0, Math.min(100, Math.round(b + bonusPts))), periods }
  })
}

const userId = (c: any): number | null => { const n = Number((c.get('jwtPayload') as any)?.sub); return Number.isFinite(n) && n > 0 ? n : null }

// GET /api/engagement?from=&to= — vista completa de dirección (rango libre) + rating oficial.
app.get('/', zValidator('query', z.object({ from: z.string().date(), to: z.string().date() })), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { from, to } = c.req.valid('query')
    const [rows, official] = await Promise.all([computeEngagement(from, to), computeOfficialRatings()])
    const off = new Map(official.map(o => [o.userId, o]))
    const data = rows.map(r => ({ ...r, official: off.get(r.userId) ?? null }))
      .sort((a, b) => (b.official?.rating ?? 0) - (a.official?.rating ?? 0) || b.total - a.total)
    const days = Math.round((new Date(`${to}T12:00:00Z`).getTime() - new Date(`${from}T12:00:00Z`).getTime()) / 86400000) + 1
    return c.json({ data, meta: { from, to, days, kinds: KIND_LABEL, unmatchedExternalNames: lastUnmatched } })
  } catch (err) { return serverError(c, err) }
})

// GET /api/engagement/me — SOLO el rating de quien pregunta (cada usuario ve el suyo).
app.get('/me', async (c) => {
  try {
    const uid = userId(c)
    if (!uid) return c.json({ data: null })
    const today = todayIn((await getBranding()).timezone)
    const [official, mine] = await Promise.all([computeOfficialRatings(), computeEngagement(isoAdd(today, -29), today)])
    const o = official.find(x => x.userId === uid)
    if (!o) return c.json({ data: null })   // p.ej. usuario principal: sin rating
    const m = mine.find(x => x.userId === uid)
    const adj = await db.execute(sql`
      SELECT ea.points, ea.reason, ea.created_at FROM engagement_adjustments ea JOIN users ue ON ue.id = ea.user_id WHERE ea.user_id = ${uid} AND ue.property_id = ${getPropertyId()} ORDER BY ea.created_at DESC LIMIT 10
    `) as unknown as { points: number; reason: string | null; created_at: string }[]
    return c.json({ data: { ...o, showWeekly: o.rating > 80, series: m?.series ?? [], byKind: m?.byKind ?? {}, noContract: m?.noContract ?? 0, noSes: m?.noSes ?? 0, penalty: m?.penalty ?? 0, total30: m?.total ?? 0, activeDays30: m?.activeDays ?? 0, adjustments: adj }, meta: { kinds: KIND_LABEL } })
  } catch (err) { return serverError(c, err) }
})

// GET/POST /api/engagement/adjustments — compensaciones de dirección (el agente usa la misma función).
export async function addEngagementAdjustment(userIdTarget: number, points: number, reason: string | null, by: number | null) {
  // El empleado destino debe ser del tenant actual (evita compensar a usuarios de otro hotel)
  const ok = await db.execute(sql`SELECT 1 FROM users WHERE id = ${userIdTarget} AND property_id = ${getPropertyId()}`) as unknown as unknown[]
  if (ok.length === 0) throw new Error('Usuario no encontrado')
  await db.execute(sql`INSERT INTO engagement_adjustments (user_id, points, reason, created_by) VALUES (${userIdTarget}, ${points}, ${reason}, ${by})`)
}
app.post('/adjustments', zValidator('json', z.object({ userId: z.number().int(), points: z.number().int().min(-30).max(30), reason: z.string().max(300).optional() })), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const b = c.req.valid('json')
    await addEngagementAdjustment(b.userId, b.points, b.reason ?? null, userId(c))
    return c.json({ ok: true }, 201)
  } catch (err: any) {
    if (err?.message === 'Usuario no encontrado') return c.json({ error: 'Usuario no encontrado' }, 404)
    return serverError(c, err)
  }
})

// GET /api/engagement/shift-reports?userId= — resúmenes de fin de turno
// (src/lib/shiftEndReport.ts). Sin userId: los del propio usuario. Con
// userId: solo dirección, para ver los de cualquier empleado en Implicación.
app.get('/shift-reports', zValidator('query', z.object({ userId: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).optional() })), async (c) => {
  try {
    const { userId: targetParam, limit } = c.req.valid('query')
    const uid = userId(c)
    if (!uid) return c.json({ data: [] })
    const target = targetParam ?? uid
    if (target !== uid && !isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const rows = await db.execute(sql`
      SELECT id, user_id, shift_date, shift_start, shift_end, total_points, breakdown, created_at
      FROM shift_end_reports
      WHERE property_id = ${getPropertyId()} AND user_id = ${target}
      ORDER BY shift_start DESC
      LIMIT ${limit ?? 20}
    `) as unknown as any[]
    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

export default app
