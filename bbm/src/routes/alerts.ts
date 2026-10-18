import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, housekeepingTasks, userRoles, users, changeDrawerCounts, changeDrawerExpenses, changeDrawerDepositChecks, alertConfigs, alertSeenMarks, alertEvents, laundryProcessBatches, reservationSaleItems, reservationNotes, blockedBeds, rooms, guests, abandonedCarts, pricingRuleApplications, pricingRules, roomTypes, shifts, feedbackThreads, breakfastServiceRatings } from '../db/schema'
import { and, gte, lte, gt, inArray, not, eq, ne, sql, count, sum, isNull, isNotNull, desc, or } from 'drizzle-orm'
import type { Context } from 'hono'
import * as poolControl from '../lib/poolControl'
import { isAdmin } from '../middleware/auth'
import { computeCalendarAvailability } from '../lib/calendarOccupancy'
import { getPricingEngineStatus } from '../lib/pricingRulesEngine'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import { isConfigured as zktecoConfigured, getEvents as getZktecoEvents } from '../lib/zkteco'
import { getPropertyId, getBranding, hasFeature, getSetting, type FeatureKey } from '../lib/property'
import { currencySymbol } from '../lib/paymentAggregate'
import { propertyMs, addDaysIso } from '../lib/dates'
import { matchUserByName } from '../lib/externalStaffActivity'
import { computeShiftEndReport, shiftCommentary } from '../lib/shiftEndReport'

const app = new Hono()

// Ids de reservas del tenant (reservation_notes no lleva property_id)
const tenantResIds = () => db.select({ id: reservations.id }).from(reservations).where(eq(reservations.propertyId, getPropertyId()))

function getUserId(c: Context): number | undefined {
  const payload = c.get('jwtPayload') as { sub?: string | number } | undefined
  const id = Number(payload?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

// Alertas de módulos opcionales: solo se evalúan si el tenant tiene el módulo activo
const ALERT_FEATURE: Record<string, FeatureKey> = {
  'laundry-process-missing': 'laundry',
  'breakfast-inventory-stale': 'pool',
  'stale-room-incident': 'pool',
  'blocked-room-no-incident': 'pool',
  'in-house-no-access': 'zkteco',
  'zkteco-unenrolled-card': 'zkteco',
  'abandoned-cart-call': 'bookingEngine',
  'new-extras-web-directa': 'bookingEngine',
  'pricing-rule-applied': 'pricingRules',
  'pricing-engine-health': 'pricingRules',
}
const GATED_FEATURES: FeatureKey[] = ['laundry', 'pool', 'zkteco', 'bookingEngine', 'pricingRules', 'cashDrawer']

const addDaysISO = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// GET /api/alerts/urgent — alertas urgentes a mostrar en pantalla
app.get('/urgent', async (c) => {
  try {
    let alerts: {
      id: string; message: string; reservationId?: number
      doneAction?: { label: string; navigateTo?: string; confirmEndpoint?: string }
      severity?: 'urgent' | 'warning' | 'info' | 'suggestion'  // por defecto 'urgent' (rojo) si se omite
      // Alerta agrupada: se muestra como una sola línea desplegable con estos
      // elementos dentro, en vez de una línea por elemento (usado para no
      // saturar la barra cuando hay varias incidencias a la vez).
      items?: { label: string; reservationId?: number }[]
      // Cuándo se vio esta ocurrencia por primera vez (alert_events.first_seen_at)
      // — el frontend la usa para la escalada de las urgentes. Se rellena más
      // abajo, al registrar el historial; las de severidad 'info' no la llevan.
      firstSeenAt?: string
      // escalate: false si ha empezado un turno nuevo (según /api/turnos de
      // sistema de piscina) desde que se vio esta alerta por primera vez
      // — en ese caso el frontend la muestra como alerta normal, sin parpadeo
      // ni interrupción bloqueante, porque no es justo cargárselo a quien no
      // la causó. true (o ausente) = escala con normalidad. Se rellena más abajo.
      escalate?: boolean
      // shiftEndSummary: solo en la alerta de resumen de fin de turno — el
      // frontend la detecta por este campo y la muestra como un modal que se
      // superpone a lo que el empleado esté haciendo, en vez de la barra normal.
      shiftEndSummary?: { total: number; emoji: string; comment: string }
    }[] = []

    const pid  = getPropertyId()
    const prop = await getBranding()
    const tz   = prop.timezone
    const cur  = currencySymbol(prop.currencyCode)
    // Canales exentos de la alerta de cobro pendiente (ids, ajuste del tenant)
    const exemptChannelIds = new Set((await getSetting<number[]>('channels.exemptFromUnpaidAlert')) ?? [])
    // Módulos opcionales activos del tenant
    const featOn = {} as Record<FeatureKey, boolean>
    for (const k of GATED_FEATURES) featOn[k] = await hasFeature(k)
    // Títulos de tarifa que incluyen desayuno (por tenant)
    const bfPatterns = ((await getSetting<string[]>('breakfast.rateTitlePatterns')) ?? ['HD', 'HyD', 'desayuno']).map(p => `%${p}%`)
    const bfPatternsSql = sql`ARRAY[${sql.join(bfPatterns.map(p => sql`${p}`), sql`, `)}]::text[]`

    // Mapa de tipos de alerta habilitados (carga única por request)
    const configRows = await db.select({ alertType: alertConfigs.alertType, enabled: alertConfigs.enabled }).from(alertConfigs).where(eq(alertConfigs.propertyId, pid))
    const alertEnabled = (type: string) => {
      const needs = ALERT_FEATURE[type]
      if (needs && !featOn[needs]) return false  // módulo apagado → la alerta no existe para este tenant
      const row = configRows.find(r => r.alertType === type)
      return row === undefined ? true : row.enabled  // si no existe en la tabla, habilitada por defecto
    }

    // ── Check-out no marcado después de las 14:00 hora local ─────────────────
    const now   = new Date()
    const local = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz,
      hour: 'numeric', hour12: false,
    }).format(now)
    const hour = parseInt(local, 10)

    const uid = Number((c.get('jwtPayload') as { sub?: string | number } | undefined)?.sub)
    const roles = !isNaN(uid) && uid > 0
      ? (await db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, uid))).map(r => r.role as string)
      : []

    // Turnos del personal (sistema de piscina/mantenimiento /api/turnos) — para saber
    // si una alerta urgente sigue dentro del mismo turno en el que empezó, o
    // si ha habido cambio de turno mientras tanto (deja de escalar, ver
    // shiftChangedSince más abajo). Se piden de hoy y de ayer (por si una
    // alerta lleva abierta desde antes de medianoche) con una sola llamada de
    // solo lectura, igual que el resto de datos de esa app (inventario,
    // incidencias...). Si la API no está configurada o falla, no se bloquea
    // nada — simplemente no se puede desactivar la escalada por turno.
    const shiftStarts: Date[] = []
    // turnosToday: además de los inicios (shiftStarts, arriba), guarda cada
    // turno completo (nombre + inicio + fin) — lo usa el resumen de fin de
    // turno más abajo para encontrar CUÁNDO acaba el turno del usuario que
    // está haciendo esta petición ahora mismo.
    const turnosToday: { empleadoNombre: string; start: Date; end: Date | null }[] = []
    if (await poolControl.isConfigured()) {
      try {
        const yesterdayISO = new Intl.DateTimeFormat('en-CA', { timeZone: tz })
          .format(new Date(now.getTime() - 86400000))
        const todayLocalISO = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
        const res: any = await poolControl.getShifts(yesterdayISO, todayLocalISO)
        for (const t of (res?.items ?? [])) {
          const fecha = String(t?.fecha ?? '').slice(0, 10)
          const hi    = String(t?.hora_inicio ?? '')
          const hf    = String(t?.hora_fin ?? '')
          const mi    = hi.match(/^(\d{2}):(\d{2})/)
          const mf    = hf.match(/^(\d{2}):(\d{2})/)
          if (!fecha || !mi) continue
          const start = new Date(await propertyMs(fecha, Number(mi[1]), Number(mi[2])))
          shiftStarts.push(start)
          // Turno que cruza medianoche (p.ej. 15:30 → 00:15): si la hora de
          // fin es <= la de inicio, es del día siguiente al de `fecha` — si
          // no, la conversión calculaba un "fin" varias horas ANTES del inicio,
          // dejando el rango vacío y por eso el resumen salía siempre a cero
          // (check-ins, check-outs, extras... todas sus consultas filtran
          // entre start y end, y con end < start no hay filas que puedan caer
          // dentro nunca).
          let end: Date | null = null
          if (mf) {
            const crossesMidnight = (Number(mf[1]) * 60 + Number(mf[2])) <= (Number(mi[1]) * 60 + Number(mi[2]))
            const endFecha = crossesMidnight ? addDaysIso(fecha, 1) : fecha
            end = new Date(await propertyMs(endFecha, Number(mf[1]), Number(mf[2])))
          }
          turnosToday.push({ empleadoNombre: String(t?.empleado_nombre ?? ''), start, end })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo leyendo turnos del módulo de piscina', e)
      }
    }
    function shiftChangedSince(firstSeenAt: Date | undefined): boolean {
      if (!firstSeenAt) return false
      return shiftStarts.some(s => s > firstSeenAt && s <= now)
    }

    // ── Resumen de fin de turno (recepción) ───────────────────────────────────
    // ~15 min antes de que acabe el turno del usuario que hace esta petición,
    // se calcula su desempeño (check-ins, check-outs, depósitos, alertas,
    // carritos, extras — ver src/lib/shiftEndReport.ts) y se guarda en
    // shift_end_reports, UNA sola vez por turno (UNIQUE user_id+shift_start):
    // el propio INSERT sirve de dedup, así que no hace falta nada más para
    // que no se repita en el siguiente poll. Queda ahí para siempre — así
    // Dirección lo puede ver en Implicación, no solo como aviso puntual.
    if (roles.includes('recepcion') && !isNaN(uid) && uid > 0 && turnosToday.length > 0) {
      try {
        const me = await db.query.users.findFirst({
          where: eq(users.id, uid),
          columns: { firstName: true, lastName: true },
        })
        if (me) {
          const myName  = `${me.firstName} ${me.lastName}`
          const myShift = turnosToday.find(t =>
            t.end
            && matchUserByName(t.empleadoNombre, [{ id: uid, name: myName }]) === uid
            && now >= new Date(t.end.getTime() - 15 * 60_000)
            && now <= t.end,
          )
          if (myShift?.end) {
            // Los Date se pasan como ISO string explícito, no tal cual — un
            // objeto Date directo en una plantilla sql de Drizzle revienta
            // con INVALID_ARG_TYPE (confirmado al depurar por qué nunca se
            // generaba ni guardaba ningún resumen: este INSERT fallaba en
            // silencio cada vez, atrapado por el catch de abajo).
            const shiftStartIso = myShift.start.toISOString()
            const shiftEndIso   = myShift.end.toISOString()
            const existing = await db.execute(sql`
              SELECT id FROM shift_end_reports WHERE property_id = ${pid} AND user_id = ${uid} AND shift_start = ${shiftStartIso}
            `) as unknown as any[]
            if (existing.length === 0) {
              const breakdown = await computeShiftEndReport(uid, myShift.start, myShift.end)
              const shiftDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(myShift.start)
              await db.execute(sql`
                INSERT INTO shift_end_reports (property_id, user_id, shift_date, shift_start, shift_end, total_points, breakdown)
                VALUES (${pid}, ${uid}, ${shiftDate}, ${shiftStartIso}, ${shiftEndIso}, ${breakdown.total}, ${JSON.stringify(breakdown)}::jsonb)
                ON CONFLICT (user_id, shift_start) DO NOTHING
              `)
              const { emoji, text } = shiftCommentary(breakdown.total)
              alerts.push({
                id:       `shift-end-report-${uid}-${myShift.start.getTime()}`,
                message:  `${emoji} Resumen de tu turno: ${breakdown.total >= 0 ? '+' : ''}${breakdown.total} puntos de implicación — ${text} Lo tienes disponible en la pestaña de Implicación.`,
                severity: 'info',
                doneAction: { label: 'Ver en Implicación', navigateTo: '/engagement' },
                shiftEndSummary: { total: breakdown.total, emoji, comment: text },
              })
            }
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo generando resumen de fin de turno', e)
      }
    }

    // ── Limpieza sin asignar después de las 12:00 — SOLO para rol limpieza ───
    if (hour >= 12 && alertEnabled('hk-unassigned')) {
      if (roles.includes('limpieza')) {
        const todayLocal = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
        const [row] = await db.select({ n: count() }).from(housekeepingTasks)
          .where(and(
            eq(housekeepingTasks.propertyId, pid),
            eq(housekeepingTasks.date, todayLocal),
            isNull(housekeepingTasks.assignedTo),
            ne(housekeepingTasks.status, 'done'),
          ))
        const n = Number(row?.n ?? 0)
        if (n > 0) {
          alerts.push({
            id:      'hk-unassigned',
            message: `🧹 ${n} habitación${n !== 1 ? 'es' : ''} de limpieza sin asignar hoy (estancias y salidas)`,
          })
        }
      }
    }

    if (hour >= 14 && alertEnabled('checkout-pending')) {
      const pendingOuts = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, pid), inArray(reservations.status, ['checking_out'])),
        with: {
          room:  { columns: { code: true } },
          guest: { columns: { firstName: true, lastName: true } },
        },
        columns: { id: true, status: true },
      })

      for (const r of pendingOuts) {
        const hab  = (r.room  as any)?.code ?? '?'
        const g    = (r.guest as any)
        const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
        alerts.push({
          id:            `checkout-${r.id}`,
          message:       `Check-out pendiente — Hab. ${hab} (${name || '—'})`,
          reservationId: r.id,
        })
      }
    }

    // ── Reservas en el hotel sin cobrar (excluye los canales exentos del tenant) ──────────────
    if (alertEnabled('unpaid-reservation')) {
      const inHouse = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, pid), inArray(reservations.status, ['checked_in', 'checking_out'])),
        with: {
          room:           { columns: { code: true } },
          guest:          { columns: { firstName: true, lastName: true } },
          bookingChannel: { columns: { name: true } },
        },
      })

      // No cuenta los depósitos retenidos sin cobrar como pago de la
      // estancia (ver src/lib/paymentAggregate.ts) — si no, una reserva con
      // solo un depósito pagado dejaría de avisar como "sin cobrar".
      const realPaidById = await realPaidByReservation(inHouse.map(r => r.id))
      for (const r of inHouse) {
        if (r.bookingChannelId != null && exemptChannelIds.has(r.bookingChannelId)) continue

        const due = calcPendingBalance(r.total, realPaidById.get(r.id) ?? 0)

        if (due > 0.10) {
          const hab  = r.room?.code ?? '?'
          const g    = r.guest
          const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
          const dueStr = due.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          alerts.push({
            id:            `unpaid-${r.id}`,
            message:       `Reserva sin cobrar — Hab. ${hab} (${name || '—'}) · ${dueStr} ${cur} pendientes`,
            reservationId: r.id,
          })
        }
      }
    }

    // ── Reservas ampliadas (estancia alargada) que se quedan sin cobrar ─────
    // La marca "🛏️ Ampliación" la deja PATCH /api/reservations/:id en una
    // nota de tipo 'change' cada vez que se alarga la fecha de salida (ver
    // src/routes/reservations.ts) — aquí basta con mirar si esa reserva
    // sigue con saldo pendiente AHORA, se recalcula en cada poll igual que
    // unpaid-reservation, así que desaparece sola en cuanto se cobra.
    if (alertEnabled('extension-unpaid')) {
      const extendedRows = await db.selectDistinct({ id: reservationNotes.reservationId })
        .from(reservationNotes)
        .innerJoin(reservations, eq(reservations.id, reservationNotes.reservationId))
        .where(and(eq(reservations.propertyId, pid), eq(reservationNotes.type, 'change'), sql`${reservationNotes.note} LIKE '%🛏️ Ampliación%'`))

      if (extendedRows.length > 0) {
        const extended = await db.query.reservations.findMany({
          where: and(
            eq(reservations.propertyId, pid),
            inArray(reservations.id, extendedRows.map(r => r.id)),
            not(inArray(reservations.status, ['cancelled', 'no_show'])),
          ),
          with: {
            room:  { columns: { code: true } },
            guest: { columns: { firstName: true, lastName: true } },
          },
        })
        const realPaidByExtId = await realPaidByReservation(extended.map(r => r.id))
        for (const r of extended) {
          const due = calcPendingBalance(r.total, realPaidByExtId.get(r.id) ?? 0)
          if (due > 0.10) {
            const hab  = r.room?.code ?? '?'
            const g    = r.guest
            const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
            const dueStr = due.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            alerts.push({
              id:            `extension-unpaid-${r.id}`,
              message:       `🛏️ Hab. ${hab} (${name || '—'}) ampliada y sin cobrar · ${dueStr} ${cur} pendientes — cóbralo antes de ampliar más, y mientras tanto pon una nota bloqueando la habitación`,
              reservationId: r.id,
            })
          }
        }
      }
    }

    // ── Reservas con total 0 € (no canceladas, checkout >= hoy) ─────────────
    const todayISO = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
    if (alertEnabled('zero-total-reservation')) {
      const zeroTotal = await db.query.reservations.findMany({
        where: and(
          eq(reservations.propertyId, pid),
          not(eq(reservations.status, 'cancelled')),
          not(eq(reservations.status, 'no_show')),
          gte(reservations.checkOutDate, todayISO),
          sql`(${reservations.total} IS NULL OR ${reservations.total}::numeric = 0)`,
        ),
        with: {
          room:  { columns: { code: true } },
          guest: { columns: { firstName: true, lastName: true } },
        },
        columns: { id: true, checkInDate: true, checkOutDate: true },
      })

      for (const r of zeroTotal) {
        const hab  = (r.room  as any)?.code ?? '?'
        const g    = (r.guest as any)
        const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
        alerts.push({
          id:            `zero-total-${r.id}`,
          message:       `Reserva con total 0 ${cur} — Hab. ${hab} (${name || '—'}) · ${r.checkInDate} → ${r.checkOutDate}`,
          reservationId: r.id,
        })
      }
    }

    // ── Reservas sin habitación asignada con check-in >= hoy ─────────────────
    if (alertEnabled('unassigned-room')) {
      const unassigned = await db.query.reservations.findMany({
        where: and(
          eq(reservations.propertyId, pid),
          isNull(reservations.roomId),
          gte(reservations.checkInDate, todayISO),
          not(inArray(reservations.status, ['cancelled', 'no_show'])),
        ),
        with:    { guest: { columns: { firstName: true, lastName: true } } },
        columns: { id: true, checkInDate: true },
        orderBy: (t, { asc }) => asc(t.checkInDate),
      })

      if (unassigned.length > 0) {
        const list = unassigned.map(r => {
          const g    = (r.guest as any)
          const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
          return `${name || '—'} (${r.checkInDate})`
        }).join(', ')
        alerts.push({
          id:      'unassigned-room',
          message: `🚪 ${unassigned.length} reserva${unassigned.length !== 1 ? 's' : ''} sin habitación asignada — ${list}`,
        })
      }
    }

    // ── Extras nuevos de reservas "web directa" con check-in hoy o mañana ────
    // Se borra al visitar la vista de Extras (POST /api/alerts/seen), no sola.
    if (alertEnabled('new-extras-web-directa')) {
      const seenMark   = await db.query.alertSeenMarks.findFirst({ where: and(eq(alertSeenMarks.propertyId, pid), eq(alertSeenMarks.alertType, 'new-extras-web-directa')) })
      const seenAt     = seenMark?.seenAt ?? new Date(0)
      const tomorrowISO = addDaysISO(todayISO, 1)

      const newExtras = await db.query.reservationSaleItems.findMany({
        where: gt(reservationSaleItems.createdAt, seenAt),
        with:  { reservation: { columns: { propertyId: true, source: true, checkInDate: true, status: true } } },
        columns: { id: true },
      })
      const hasRelevant = newExtras.some(e => {
        const r = e.reservation as any
        return r && r.propertyId === pid && r.source === 'web_directa'
          && (r.checkInDate === todayISO || r.checkInDate === tomorrowISO)
          && !['cancelled', 'no_show'].includes(r.status)
      })
      if (hasRelevant) {
        alerts.push({
          id:      'new-extras-web-directa',
          message: '🛎️ Atiende a los extras nuevos de hoy y mañana',
          doneAction: { label: 'Hecho', navigateTo: '/extras' },
        })
      }
    }

    // ── Reserva de Booking.com sin check-in (aviso temprano) ─────────────────
    // Se activa a las 6:00 del día SIGUIENTE al check-in y sigue visible hasta
    // las 14:00 dos días después del check-in — antes de eso el huésped aún
    // puede estar llegando ese mismo día (checkIn) o de madrugada (checkIn+1
    // antes de las 6:00). Es el aviso previo a "no-show-booking" (que exige
    // marcarlo a mano en booking.com): esta solo informa de que aún no se ha
    // hecho el check-in en el sistema, se dispara mucho antes de que
    // autoStatus.ts pudiera marcar la reserva como no_show (eso solo pasa al
    // pasar la fecha de CHECK-OUT, que en estancias largas puede ser días
    // después). Se borra sola en cuanto se hace el check-in o pasa la ventana
    // — sin acción manual, a diferencia de no-show-booking.
    if (alertEnabled('booking-no-checkin')) {
      const todayLocalCI = todayISO
      const yesterdayLocal  = addDaysISO(todayLocalCI, -1)  // check-in ayer → activa desde las 6:00
      const twoDaysAgoLocal = addDaysISO(todayLocalCI, -2)  // check-in anteayer → activa hasta las 14:00
      const activeCheckInDates: string[] = []
      if (hour >= 6)  activeCheckInDates.push(yesterdayLocal)
      if (hour < 14)  activeCheckInDates.push(twoDaysAgoLocal)

      if (activeCheckInDates.length > 0) {
        const candidates = await db.query.reservations.findMany({
          where: and(
            eq(reservations.propertyId, pid),
            inArray(reservations.checkInDate, activeCheckInDates),
            not(inArray(reservations.status, ['checked_in', 'checking_out', 'checked_out', 'cancelled'])),
          ),
          with: {
            guest:          { columns: { firstName: true, lastName: true } },
            bookingChannel: { columns: { name: true, commissionPct: true } },
          },
          columns: { id: true, externalCode: true, checkInDate: true, total: true, originalTotal: true, bmCommission: true },
        })
        const candidatesRelevantEarly = candidates.filter(r => ((r.bookingChannel as any)?.name ?? '').toLowerCase().includes('booking'))

        // Mismo criterio que el aviso de abajo (no-show-booking): si la
        // reserva ya está totalmente saldada no hay urgencia ni comisión que
        // forzar a marcar a mano, no debería seguir avisando.
        const realPaidByIdEarly = await realPaidByReservation(candidatesRelevantEarly.map(r => r.id))
        const relevant = candidatesRelevantEarly.filter(r => calcPendingBalance(r.total, realPaidByIdEarly.get(r.id) ?? 0) > 0.10)

        for (const r of relevant) {
          const g    = (r.guest as any)
          const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
          const code = r.externalCode ?? `#${r.id}`
          // Misma fórmula que Informes → Comisiones: bm_commission si FDM lo
          // mandó (más preciso), si no el % del canal sobre el total original.
          const basis    = parseFloat(r.originalTotal ?? r.total ?? '0')
          const bm       = parseFloat(r.bmCommission ?? '0')
          const pct      = parseFloat((r.bookingChannel as any)?.commissionPct ?? '0')
          const comm     = bm > 0 ? bm : (basis * pct / 100)
          const commStr  = comm > 0 ? ` — se pierden ${comm.toFixed(2)} ${cur} de comisión si no se marca` : ''
          alerts.push({
            id:            `booking-no-checkin-${r.id}`,
            message:       `⚠️ Reserva ${code} (${name || '—'}) sin check-in — marcar No-show en Booking${commStr} (llegada ${r.checkInDate})`,
            reservationId: r.id,
            severity:      'warning',
          })
        }
      }
    }

    // ── No Show sin marcar en Booking.com ────────────────────────────────────
    // Dos disparadores: (1) la reserva pasó a status='no_show', o (2) se movió
    // a una habitación de tipo virtual (isVirtual=true — cupo sin habitación
    // física real asignada) sin haber hecho check-in — señal de que el huésped
    // probablemente no se presentó. Solo aplica a canal Booking.com (el resto
    // de OTAs no necesitan esta acción manual). Visible desde que se dispara
    // hasta 2 días después del check-in; se borra al pulsar "Hecho" en la
    // propia alerta (POST /alerts/no-show-confirm/:id), que deja una nota en
    // la reserva — esa nota es lo que hace que no vuelva a aparecer.
    if (alertEnabled('no-show-booking')) {
      const twoDaysAgoISO = addDaysISO(todayISO, -2)
      const candidates = await db.query.reservations.findMany({
        where: and(
          eq(reservations.propertyId, pid),
          gte(reservations.checkInDate, twoDaysAgoISO),
          lte(reservations.checkInDate, todayISO),
        ),
        with: {
          guest:          { columns: { firstName: true, lastName: true } },
          bookingChannel: { columns: { name: true } },
          room:           { with: { roomType: { columns: { isVirtual: true } } } },
        },
        columns: { id: true, externalCode: true, checkInDate: true, status: true, total: true },
      })

      const candidatesRelevant = candidates.filter(r => {
        const isBookingCom = ((r.bookingChannel as any)?.name ?? '').toLowerCase().includes('booking')
        if (!isBookingCom) return false
        const isNoShow          = r.status === 'no_show'
        const isVirtualNoCheckin = (r.room as any)?.roomType?.isVirtual === true
          && !['checked_in', 'checking_out', 'checked_out', 'cancelled'].includes(r.status)
        return isNoShow || isVirtualNoCheckin
      })

      // Solo avisa si la reserva no está totalmente saldada — si ya está
      // cobrada del todo no hay urgencia (ni comisión ni cargo) que forzar
      // a marcar a mano en booking.com.
      const realPaidById = await realPaidByReservation(candidatesRelevant.map(r => r.id))
      const relevant = candidatesRelevant.filter(r => calcPendingBalance(r.total, realPaidById.get(r.id) ?? 0) > 0.10)

      if (relevant.length > 0) {
        const confirmedRows = await db.query.reservationNotes.findMany({
          where: and(
            inArray(reservationNotes.reservationId, relevant.map(r => r.id)),
            eq(reservationNotes.type, 'no_show_ota_confirmed'),
          ),
          columns: { reservationId: true },
        })
        const confirmedIds = new Set(confirmedRows.map(n => n.reservationId))

        for (const r of relevant) {
          if (confirmedIds.has(r.id)) continue
          const g    = (r.guest as any)
          const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
          const code = r.externalCode ?? `#${r.id}`
          alerts.push({
            id:      `no-show-booking-${r.id}`,
            message: `⚠️ Reserva ${code} (${name}) de Booking marcar No Show en booking.com — check-in ${r.checkInDate}`,
            reservationId: r.id,
            severity: 'warning',
            doneAction: { label: 'Hecho', confirmEndpoint: `/api/alerts/no-show-confirm/${r.id}` },
          })
        }
      }
    }

    // ── Objetos robados marcados en housekeeping (para todos, hasta que se ──
    //    registre un depósito nuevo en la reserva) ────────────────────────────
    if (alertEnabled('stolen-items')) {
      const stolenRows = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, pid), isNotNull(reservations.stolenItemsReportedAt)),
        with: {
          room:  { columns: { code: true } },
          guest: { columns: { firstName: true, lastName: true } },
        },
        columns: { id: true },
      })

      for (const r of stolenRows) {
        const hab  = (r.room  as any)?.code ?? '?'
        const g    = (r.guest as any)
        const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
        alerts.push({
          id:            `stolen-${r.id}`,
          message:       `🥷 Posibles objetos robados — Hab. ${hab} (${name || '—'})`,
          reservationId: r.id,
        })
      }
    }

    const madridHour   = parseInt(new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10)
    const madridMinute = parseInt(new Intl.DateTimeFormat('es-ES', { timeZone: tz, minute: 'numeric' }).format(now), 10)
    const minuteOfDay  = madridHour * 60 + madridMinute

    // ── Procesado de lavandería sin declarar (16:30–19:00) — SOLO limpieza ───
    if (minuteOfDay >= 16 * 60 + 30 && minuteOfDay < 19 * 60 && alertEnabled('laundry-process-missing') && roles.includes('limpieza')) {
      const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
      const [batchRow] = await db.select({ n: count() }).from(laundryProcessBatches)
        .where(and(eq(laundryProcessBatches.propertyId, pid), eq(laundryProcessBatches.date, todayMadrid)))
      if (Number(batchRow?.n ?? 0) === 0) {
        alerts.push({
          id:      'laundry-process-missing',
          message: '🧺 No se ha declarado ningún procesado de lavandería hoy',
        })
      }
    }

    // ── Caja de cambio: verificar arqueos del día ─────────────────────────────
    // Recepción, dirección y admin deben hacer al menos 2 arqueos al día:
    //   1º antes de las 15:15 · 2º antes de las 23:15
    const canSeeDrawer = roles.includes('recepcion') || roles.includes('direccion')
      || (c.get('jwtPayload') as any)?.isPrimary
    if (canSeeDrawer && featOn.cashDrawer) {

      // Contar arqueos del día actual (hora Madrid)
      const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
      const [countRow] = await db.select({ n: count() }).from(changeDrawerCounts)
        .where(and(eq(changeDrawerCounts.propertyId, pid), sql`(${changeDrawerCounts.countedAt} AT TIME ZONE ${tz})::date = ${todayMadrid}::date`))
      const arqueos = Number(countRow?.n ?? 0)

      // Tras las 15:15 sin ningún arqueo
      if (minuteOfDay >= 15 * 60 + 15 && arqueos === 0 && alertEnabled('drawer-missing-first')) {
        alerts.push({
          id:      'drawer-missing-first',
          message: `Caja de cambio — falta el primer arqueo del día (pendiente desde las 15:15)`,
        })
      }
      // Tras las 23:15 con solo un arqueo
      if (minuteOfDay >= 23 * 60 + 15 && arqueos < 2 && alertEnabled('drawer-missing-second')) {
        alerts.push({
          id:      'drawer-missing-second',
          message: `Caja de cambio — falta el segundo arqueo del día (pendiente desde las 23:15)`,
        })
      }

      // Descuadre en el último arqueo: totalCash + gastos sin reponer < consigna
      if (alertEnabled('drawer-mismatch')) {
        const lastCount = await db.query.changeDrawerCounts.findFirst({
          where: eq(changeDrawerCounts.propertyId, pid),
          orderBy: (t, { desc }) => desc(t.id),
        })
        if (lastCount) {
          const [expRow] = await db.select({ total: sum(changeDrawerExpenses.amount) })
            .from(changeDrawerExpenses)
            .where(and(eq(changeDrawerExpenses.propertyId, pid), isNull(changeDrawerExpenses.replenishedAt)))
          const totalCash      = parseFloat(String(lastCount.totalCash ?? 0))
          const floatTarget    = parseFloat(String(lastCount.floatAmount ?? 0))
          const activeExpenses = parseFloat(String(expRow?.total ?? 0))
          const balance        = Math.round((totalCash + activeExpenses) * 100) / 100
          const diff           = Math.round((floatTarget - balance) * 100) / 100
          if (diff >= 1) {
            const diffStr = diff.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            alerts.push({
              id:      'drawer-mismatch',
              message: `Descuadre en caja de cambio — faltan ${diffStr} ${cur} (contado + gastos pendientes < consigna)`,
            })
          }
        }
      }

      // Descuadre en depósitos de caja: mismo espíritu que 'drawer-mismatch'
      // arriba, mirando la última verificación manual de depósitos en
      // efectivo (pestaña de caja de cambio) — se guarda registro de TODAS
      // las verificaciones (haya o no descuadre, ver POST /deposit-check),
      // así que aquí se comprueba explícitamente si esa última tuvo algo
      // pendiente; se apaga en cuanto se repite la verificación sin que
      // falte nada.
      if (alertEnabled('drawer-deposits-mismatch')) {
        const lastCheck = await db.query.changeDrawerDepositChecks.findFirst({
          where: eq(changeDrawerDepositChecks.propertyId, pid),
          orderBy: (t, { desc }) => desc(t.id),
        })
        if (lastCheck) {
          const missing = lastCheck.systemCount - lastCheck.countedCount
          if (missing > 0) {
            alerts.push({
              id:      'drawer-deposits-mismatch',
              message: `Descuadre en depósitos de caja — faltan ${missing} depósito(s) en efectivo por contabilizar`,
            })
          }
        }
      }

      // Verificación de depósitos en efectivo: igual que el arqueo normal de
      // arriba, se exigen 2 veces al día (antes de 15:15 y de 23:15) — cuenta
      // TODAS las verificaciones de hoy (haya o no descuadre en cada una).
      const [depCheckRow] = await db.select({ n: count() }).from(changeDrawerDepositChecks)
        .where(and(eq(changeDrawerDepositChecks.propertyId, pid), sql`(${changeDrawerDepositChecks.checkedAt} AT TIME ZONE ${tz})::date = ${todayMadrid}::date`))
      const depositChecksToday = Number(depCheckRow?.n ?? 0)

      if (minuteOfDay >= 15 * 60 + 15 && depositChecksToday === 0 && alertEnabled('drawer-deposits-missing-first')) {
        alerts.push({
          id:      'drawer-deposits-missing-first',
          message: `Caja de cambio — falta confirmar los depósitos en efectivo del primer arqueo (pendiente desde las 15:15)`,
        })
      }
      if (minuteOfDay >= 23 * 60 + 15 && depositChecksToday < 2 && alertEnabled('drawer-deposits-missing-second')) {
        alerts.push({
          id:      'drawer-deposits-missing-second',
          message: `Caja de cambio — falta confirmar los depósitos en efectivo del segundo arqueo (pendiente desde las 23:15)`,
        })
      }
    }

    // ── Check-in abandonado hoy (visible para recepción y dirección) ──────────
    const userRolesList = roles ?? []
    const canSeeAbandon = userRolesList.includes('recepcion') || userRolesList.includes('direccion')
      || (c.get('jwtPayload') as any)?.isPrimary
    if (canSeeAbandon && alertEnabled('checkin-abandoned')) {
      const abandoned = await db.query.reservations.findMany({
        where: and(
          eq(reservations.propertyId, pid),
          isNotNull(reservations.checkinAbandonedAt),
          eq(reservations.checkInDate, todayISO),
          not(inArray(reservations.status, ['checked_in', 'checking_out', 'checked_out', 'cancelled', 'no_show'])),
        ),
        with: {
          room:  { columns: { code: true } },
          guest: { columns: { firstName: true, lastName: true } },
        },
        columns: { id: true, checkinAbandonedAt: true, checkinAbandonedBy: true },
      })
      for (const r of abandoned) {
        const hab  = (r.room  as any)?.code ?? '?'
        const g    = (r.guest as any)
        const name = g ? `${g.firstName ?? ''} ${g.lastName ?? ''}`.trim() : '—'
        let emp = ''
        if (r.checkinAbandonedBy) {
          const u = await db.query.users.findFirst({ where: and(eq(users.id, r.checkinAbandonedBy), eq(users.propertyId, pid)), columns: { firstName: true, lastName: true } })
          if (u) emp = ` · por ${u.firstName ?? ''} ${u.lastName ?? ''}`.trim()
        }
        const hour = r.checkinAbandonedAt
          ? new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(r.checkinAbandonedAt))
          : ''
        alerts.push({
          id:            `checkin-abandoned-${r.id}`,
          message:       `🚨 Check-in abandonado — Hab. ${hab} (${name || '—'}) a las ${hour}${emp}`,
          reservationId: r.id,
        })
      }
    }

    // ── Desayunos sin confirmar (11:00–13:00 hora Madrid, para todos) ───────────
    if (hour >= 11 && hour < 13 && alertEnabled('breakfast-unconfirmed')) {
      const todayMadrid = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
      const [noServiceRow, breakfastCount, servedCount] = await Promise.all([
        db.execute(sql`SELECT 1 FROM breakfast_no_service WHERE property_id = ${pid} AND date = ${todayMadrid} LIMIT 1`),
        db.execute(sql`
          SELECT COUNT(*) AS n FROM reservations r
          JOIN rates rt ON rt.id = r.rate_id
          WHERE r.property_id = ${pid}
            AND r.status NOT IN ('cancelled','no_show')
            AND r.check_in_date  < ${todayMadrid}::date
            AND r.check_out_date >= ${todayMadrid}::date
            AND rt.title ILIKE ANY(${bfPatternsSql})
        `),
        db.execute(sql`SELECT COUNT(*) AS n FROM breakfast_logs bl JOIN reservations r ON r.id = bl.reservation_id WHERE r.property_id = ${pid} AND bl.date = ${todayMadrid}::date`),
      ])
      const hasBreakfasts = Number((breakfastCount as any[])[0]?.n ?? 0) > 0
      const anyServed     = Number((servedCount     as any[])[0]?.n ?? 0) > 0
      const noService     = (noServiceRow as any[]).length > 0
      if (hasBreakfasts && !anyServed && !noService) {
        alerts.push({
          id:      'breakfast-unconfirmed',
          message: '🍳 No se ha confirmado el servicio de desayunos de hoy',
        })
      }
    }

    // ── Inventario de desayunos desactualizado — SOLO para rol limpieza ──────
    // Se dispara si han pasado más de 4 días desde el último inventario
    // registrado en el sistema de piscina/mantenimiento, o si desde esa fecha
    // se han servido más de 25 desayunos (suma de personas en breakfast_logs,
    // tarifa + extras) — en ambos casos el inventario ya no refleja bien el
    // consumo real y toca repetirlo.
    if (alertEnabled('breakfast-inventory-stale') && (await poolControl.isConfigured()) && roles.includes('limpieza')) {
      try {
        const inv      = await poolControl.getBreakfastInventory()
        const lastDate = inv?.fecha as string | null
        if (lastDate) {
          const daysSince = Math.floor((now.getTime() - new Date(`${lastDate}T00:00:00Z`).getTime()) / 86400000)

          const servedRows = await db.execute(sql`
            SELECT COALESCE(SUM(
              GREATEST(r.people, 1 + (
                SELECT COUNT(DISTINCT rn.guest_id)::int FROM reservation_nights rn
                WHERE rn.reservation_id = r.id AND rn.guest_id != r.guest_id
              ))
            ), 0)::int AS n
            FROM breakfast_logs bl
            JOIN reservations r ON r.id = bl.reservation_id
            WHERE r.property_id = ${pid} AND bl.date > ${lastDate}::date AND bl.date <= ${todayISO}::date
          `) as unknown as any[]
          const servedSince = Number(servedRows[0]?.n ?? 0)

          if (daysSince > 4 || servedSince > 25) {
            const reasons: string[] = []
            if (daysSince > 4)   reasons.push(`${daysSince} días desde el último (${lastDate})`)
            if (servedSince > 25) reasons.push(`${servedSince} desayunos servidos desde entonces`)
            alerts.push({
              id:      'breakfast-inventory-stale',
              message: `📋 Toca repetir el inventario de desayunos — ${reasons.join(' · ')}`,
            })
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando inventario de desayunos', e)
      }
    }

    // ── Incidencias del sistema de piscina/mantenimiento: se piden una sola ──
    // vez y se comparten entre los dos bloques de abajo (evita pedirlas dos
    // veces a la API externa en la misma petición). "habitacion" allí ==
    // rooms.code aquí — no hay vínculo de BD entre las dos apps, se cruza por
    // ese código. Las incidencias de zonas comunes (planta="zonas_comunes")
    // nunca casan con ningún código de habitación real, quedan excluidas solas.
    const needsIncidents = alertEnabled('stale-room-incident') || alertEnabled('blocked-room-no-incident')
    let pendingIncidents: any[] = []
    if (needsIncidents && (await poolControl.isConfigured())) {
      try {
        const inc = await poolControl.getPendingIncidents()
        pendingIncidents = inc?.items ?? []
      } catch (e) {
        console.error('[alerts/urgent] fallo pidiendo incidencias a piscina/mantenimiento', e)
      }
    }

    // ── Incidencias de habitación abiertas >3 días con clientes dentro ───────
    // Las de prioridad Baja no generan alerta (quedan fuera del sistema de
    // alertas, pero siguen contando para el enlace con habitaciones
    // bloqueadas de más abajo — ahí no son una "alerta", son documentación).
    if (alertEnabled('stale-room-incident') && pendingIncidents.length > 0) {
      try {
        const stale = pendingIncidents
          .filter(it => (it.prioridad ?? '').toLowerCase() !== 'baja')
          .map(it => {
            const opened = String(it.fecha ?? '').slice(0, 10)
            const days   = opened ? Math.floor((now.getTime() - new Date(`${opened}T00:00:00Z`).getTime()) / 86400000) : 0
            return { ...it, days }
          })
          .filter(it => it.days > 3)

        if (stale.length > 0) {
          const occRows = await db.execute(sql`
            SELECT DISTINCT ON (code) code, reservation_id, guest_name FROM (
              SELECT ro.code AS code, res.id AS reservation_id,
                     TRIM(g.first_name || ' ' || g.last_name) AS guest_name
              FROM reservations res
              JOIN rooms  ro ON ro.id = res.room_id
              JOIN guests g  ON g.id  = res.guest_id
              WHERE res.property_id = ${pid} AND res.status IN ('checked_in', 'checking_out')
              UNION ALL
              SELECT ro2.code, res2.id, TRIM(g2.first_name || ' ' || g2.last_name)
              FROM reservations res2
              JOIN guests g2 ON g2.id = res2.guest_id
              CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(res2.extra_room_ids, '[]'::jsonb)) AS xrid(id)
              JOIN rooms ro2 ON ro2.id = xrid.id::int
              WHERE res2.property_id = ${pid} AND res2.status IN ('checked_in', 'checking_out')
            ) occ
          `) as unknown as { code: string; reservation_id: number; guest_name: string }[]
          const occupiedByRoom = new Map(occRows.map(r => [r.code, r]))

          const items: { label: string; reservationId?: number }[] = []
          for (const it of stale) {
            const room = String(it.habitacion ?? '').trim()
            const occ  = room ? occupiedByRoom.get(room) : undefined
            if (!occ) continue
            const comentario = String(it.comentario ?? '').trim().slice(0, 100)
            const prioridad  = it.prioridad ? ` (${it.prioridad})` : ''
            items.push({
              label:         `Hab. ${room} (${occ.guest_name || '—'}) · abierta hace ${it.days} días${prioridad}${comentario ? ` — ${comentario}` : ''}`,
              reservationId: occ.reservation_id,
            })
          }
          // Una sola alerta desplegable con todas las incidencias dentro, en vez
          // de una línea por incidencia (saturaba la barra con varias abiertas).
          if (items.length > 0) {
            alerts.push({
              id:       'stale-room-incident-group',
              message:  'Incidencias abiertas en habitaciones con cliente',
              severity: 'warning',
              items,
            })
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando incidencias de habitaciones', e)
      }
    }

    // ── Habitaciones bloqueadas ↔ incidencias de mantenimiento ───────────────
    // Cruza los bloqueos activos (hoy o en el futuro) de blocked_beds con las
    // incidencias pendientes por código de habitación:
    //   - Si hay incidencia que corresponde: enlaza añadiendo su texto al
    //     campo "reason" del bloqueo (una sola vez — se marca con
    //     "[inc#<id>]" para no repetirlo en cada sondeo).
    //   - Si NO hay incidencia que corresponda: alerta para que se abra una,
    //     porque una habitación bloqueada sin incidencia documentada no se
    //     sabe por qué está fuera de servicio.
    if (alertEnabled('blocked-room-no-incident')) {
      try {
        const blockedRows = await db.select({
          id:        blockedBeds.id,
          roomId:    blockedBeds.roomId,
          bedNumber: blockedBeds.bedNumber,
          blockDate: blockedBeds.blockDate,
          reason:    blockedBeds.reason,
          roomCode:  rooms.code,
          locked:    blockedBeds.lockedByDirection,
        }).from(blockedBeds)
          .innerJoin(rooms, eq(rooms.id, blockedBeds.roomId))
          .where(and(eq(blockedBeds.propertyId, pid), eq(rooms.propertyId, pid), gte(blockedBeds.blockDate, todayISO), eq(blockedBeds.lockedByDirection, false)))  // los de Dirección no necesitan incidencia

        if (blockedRows.length > 0) {
          const byRoom = new Map<string, typeof blockedRows>()
          for (const row of blockedRows) {
            const list = byRoom.get(row.roomCode)
            if (list) list.push(row); else byRoom.set(row.roomCode, [row])
          }

          for (const [roomCode, group] of byRoom) {
            const match = pendingIncidents.find(it => String(it.habitacion ?? '').trim() === roomCode)

            if (match) {
              // Enlazar: añadir el texto de la incidencia al motivo del bloqueo,
              // una sola vez por fila (marcador [inc#id] evita duplicarlo).
              const marker  = `[inc#${match.id}]`
              const snippet = `Incidencia mantenimiento #${match.id}${match.prioridad ? ` (${match.prioridad})` : ''}: ${String(match.comentario ?? '').trim().slice(0, 150)} ${marker}`
              for (const row of group) {
                if (row.reason?.includes(marker)) continue
                const newReason = row.reason ? `${row.reason} — ${snippet}` : snippet
                await db.update(blockedBeds).set({ reason: newReason }).where(and(eq(blockedBeds.id, row.id), eq(blockedBeds.propertyId, pid)))
              }
            } else {
              const dates = group.map(r => r.blockDate).sort()
              const range = dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} → ${dates[dates.length - 1]}`
              alerts.push({
                id:      `blocked-room-no-incident-${roomCode}`,
                message: `🔒 Hab. ${roomCode} bloqueada (${range}) sin incidencia abierta en mantenimiento — abre una incidencia`,
                doneAction: { label: 'Ver planning', navigateTo: '/planning' },
                severity: 'warning',
              })
            }
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo cruzando habitaciones bloqueadas con incidencias', e)
      }
    }

    // ── Descuadre de preferencia de camas ────────────────────────────────────
    // El huésped pidió "dos camas separadas" en el motor de reservas
    // (reservations.bedPreferenceTwin, es solo una preferencia, no una
    // garantía) pero la habitación que tiene asignada no tiene esa
    // característica (rooms.bedSize != 'twin') — o no está especificada.
    // Solo estancias con habitación ya asignada y que no hayan terminado
    // (sigue habiendo tiempo de reasignar antes o durante la estancia).
    if (alertEnabled('bed-preference-mismatch')) {
      try {
        const mismatches = await db.select({
          id:            reservations.id,
          checkInDate:   reservations.checkInDate,
          checkOutDate:  reservations.checkOutDate,
          roomCode:      rooms.code,
          bedSize:       rooms.bedSize,
          firstName:     guests.firstName,
          lastName:      guests.lastName,
        }).from(reservations)
          .innerJoin(rooms,   eq(rooms.id, reservations.roomId))
          .innerJoin(guests,  eq(guests.id, reservations.guestId))
          .where(and(
            eq(reservations.propertyId, pid),
            eq(reservations.bedPreferenceTwin, true),
            gte(reservations.checkOutDate, todayISO),
            inArray(reservations.status, ['confirmed', 'arriving', 'checked_in', 'checking_out']),
            sql`${rooms.bedSize} IS DISTINCT FROM 'twin'`,
          ))

        if (mismatches.length > 0) {
          const items = mismatches.map(r => ({
            label:         `Hab. ${r.roomCode} (${r.bedSize ?? 'sin especificar'}) — ${r.firstName} ${r.lastName} · ${r.checkInDate} → ${r.checkOutDate}`,
            reservationId: r.id,
          }))
          alerts.push({
            id:       'bed-preference-mismatch-group',
            message:  '🛏️ Huéspedes que pidieron dos camas separadas sin estar en una habitación con esa característica',
            severity: 'warning',
            items,
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando preferencia de camas', e)
      }
    }

    // ── Huésped alojado sin acceso (tarjeta ZKTeco) enrollado ────────────────
    // Alojado ahora mismo (checkInDate <= hoy < checkOutDate, status
    // checked_in/checking_out) pero sin tarjeta de acceso ACTIVA (zktecoCardNo
    // null, o revocada a mano y no reenrolada — ver zktecoCardRevokedAt en el
    // schema) — se saltó el enroll en el check-in, se le borró/revocó la
    // tarjeta por algún motivo y quedó sin acceso.
    if (alertEnabled('in-house-no-access')) {
      try {
        const noAccess = await db.select({
          id:           reservations.id,
          checkInDate:  reservations.checkInDate,
          checkOutDate: reservations.checkOutDate,
          roomCode:     rooms.code,
          firstName:    guests.firstName,
          lastName:     guests.lastName,
        }).from(reservations)
          .leftJoin(rooms,  eq(rooms.id, reservations.roomId))
          .innerJoin(guests, eq(guests.id, reservations.guestId))
          .where(and(
            eq(reservations.propertyId, pid),
            inArray(reservations.status, ['checked_in', 'checking_out']),
            lte(reservations.checkInDate, todayISO),
            gt(reservations.checkOutDate, todayISO),
            or(isNull(reservations.zktecoCardNo), isNotNull(reservations.zktecoCardRevokedAt)),
          ))

        if (noAccess.length > 0) {
          const items = noAccess.map(r => ({
            label:         `Hab. ${r.roomCode ?? '?'} — ${r.firstName} ${r.lastName} · ${r.checkInDate} → ${r.checkOutDate}`,
            reservationId: r.id,
          }))
          alerts.push({
            id:       'in-house-no-access-group',
            message:  '🔴 Huéspedes alojados sin tarjeta de acceso enrollada',
            severity: 'urgent',
            items,
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando accesos sin enrollar', e)
      }
    }

    // ── Intento de acceso con tarjeta no enrollada ───────────────────────────
    // event_type=2 ("Tarjeta no existe") = el controlador no reconoce la
    // tarjeta — no está enrollada a ninguna reserva (sin user_id asignado).
    // Se agrupa por tarjeta en ventanas de 24h: el primer intento rechazado
    // de una tarjeta abre una ventana con la puerta y la hora de ESE primer
    // intento; los intentos siguientes de la misma tarjeta dentro de esas 24h
    // se ignoran (no generan alerta nueva ni reinician la ventana). Pasadas
    // las 24h desde el primer intento, la alerta desaparece sola (el
    // mecanismo genérico de alert_events la auto-resuelve al dejar de
    // aparecer en vivo); si la tarjeta vuelve a intentarlo después, se abre
    // una ventana nueva (alerta nueva).
    if (alertEnabled('zkteco-unenrolled-card') && (await zktecoConfigured())) {
      try {
        const result = await getZktecoEvents(1000, 0)
        const evts: any[] = Array.isArray(result) ? result : result.data ?? []
        const denied = evts.filter(e =>
          Number(e.event_type) === 2 && e.card_no && e.card_no !== '0'
          && (!e.user_id || e.user_id === '0'))

        const byCard = new Map<string, any[]>()
        for (const e of denied) {
          const list = byCard.get(e.card_no)
          if (list) list.push(e); else byCard.set(e.card_no, [e])
        }

        const WINDOW_MS = 24 * 3_600_000
        for (const [cardNo, list] of byCard) {
          list.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
          let windowStart: { time: number; door: number | null } | null = null
          for (const e of list) {
            const t = new Date(e.timestamp).getTime()
            if (!windowStart || t - windowStart.time > WINDOW_MS) windowStart = { time: t, door: e.door }
          }
          if (windowStart && now.getTime() - windowStart.time <= WINDOW_MS) {
            const hora = new Intl.DateTimeFormat('es-ES', {
              timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
            }).format(windowStart.time)
            alerts.push({
              id:       `zkteco-unenrolled-card-${cardNo}`,
              message:  `🚨 Tarjeta no enrollada intentó acceder — Puerta ${windowStart.door ?? '?'} a las ${hora}`,
              severity: 'urgent',
            })
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando tarjetas no enrolladas ZKTeco', e)
      }
    }

    // ── Carrito abandonado con teléfono — llamar para verificar ─────────────
    // Solo recepción/dirección (son quienes llaman). Reservas provisionales o
    // canceladas nacidas de un carrito web sin pagar, con teléfono, que no se
    // hayan recuperado ya (ni por el link de descuento ni por otra vía) y no
    // sean demasiado viejas (pasado ese margen ya no tiene sentido llamar).
    // Se borra al pulsar "Llamado" (POST /alerts/abandoned-cart-call-confirm/:id),
    // que deja una nota en la reserva — esa nota es lo que evita que reaparezca.
    if (alertEnabled('abandoned-cart-call') && (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion'))) {
      try {
        const CALL_WINDOW_HOURS = 36  // día y medio
        const windowStart = new Date(now.getTime() - CALL_WINDOW_HOURS * 3600000)

        const cartCandidates = await db.select({
          cartId:        abandonedCarts.id,
          reservationId: abandonedCarts.reservationId,
          phone:         abandonedCarts.phone,
          guestName:     abandonedCarts.guestName,
          checkIn:       abandonedCarts.checkIn,
          checkOut:      abandonedCarts.checkOut,
          createdAt:     abandonedCarts.createdAt,
        }).from(abandonedCarts)
          .innerJoin(reservations, eq(reservations.id, abandonedCarts.reservationId))
          .where(and(
            eq(reservations.propertyId, pid),
            isNotNull(abandonedCarts.phone),
            isNull(abandonedCarts.recoveredAt),
            gt(abandonedCarts.createdAt, windowStart),
            inArray(reservations.status, ['tentative', 'cancelled']),
          ))

        if (cartCandidates.length > 0) {
          const confirmedRows = await db.query.reservationNotes.findMany({
            where: and(
              inArray(reservationNotes.reservationId, cartCandidates.map(r => r.reservationId)),
              eq(reservationNotes.type, 'abandoned_cart_called'),
            ),
            columns: { reservationId: true },
          })
          const confirmedIds = new Set(confirmedRows.map(n => n.reservationId))

          for (const r of cartCandidates) {
            if (confirmedIds.has(r.reservationId)) continue
            alerts.push({
              id:      `abandoned-cart-call-${r.cartId}`,
              message: `📞 Carrito abandonado — llamar cuando haya un momento: ${r.guestName ?? '—'} (${r.phone}) · ${r.checkIn ?? '?'} → ${r.checkOut ?? '?'}`,
              reservationId: r.reservationId,
              severity: 'suggestion',
              doneAction: { label: 'Llamado', confirmEndpoint: `/api/alerts/abandoned-cart-call-confirm/${r.reservationId}` },
            })
          }
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando carritos abandonados con teléfono', e)
      }
    }

    // ── Reglas automáticas de precio aplicadas ───────────────────────────────
    // Morada/informativa — el motor (pricingRulesEngine.ts) ya hizo el cambio
    // solo, esto es aviso, no una acción pendiente. Solo recepción/dirección
    // (quienes gestionan precios). Se borra entera al pulsar "Entendido"
    // (POST /alerts/pricing-rule-dismiss), que marca dismissed_at en todas las
    // filas mostradas — no hace falta ir una a una.
    if (alertEnabled('pricing-rule-applied') && (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion'))) {
      try {
        // Solo el tipo base (sin baseRoomTypeId — el único con precio propio
        // editable, ver price-resolver.ts) interesa aquí: el motor también
        // toca filas muertas de tipos derivados (nunca leídas por
        // resolvePrice()), que solo aportarían ruido a esta alerta.
        const rows = await db.select({
          date:         pricingRuleApplications.date,
          oldPrice:     pricingRuleApplications.oldPrice,
          newPrice:     pricingRuleApplications.newPrice,
          roomTypeName: roomTypes.name,
          ruleName:     pricingRules.name,
        }).from(pricingRuleApplications)
          .innerJoin(roomTypes,    eq(roomTypes.id, pricingRuleApplications.roomTypeId))
          .innerJoin(pricingRules, eq(pricingRules.id, pricingRuleApplications.ruleId))
          .where(and(eq(roomTypes.propertyId, pid), isNull(pricingRuleApplications.dismissedAt), isNull(roomTypes.baseRoomTypeId)))
          .orderBy(pricingRuleApplications.date)

        if (rows.length > 0) {
          const items = rows.map(r => {
            const oldP = parseFloat(r.oldPrice)
            const newP = parseFloat(r.newPrice)
            const pctChange = oldP > 0 ? ((newP - oldP) / oldP) * 100 : 0
            const sign = pctChange >= 0 ? '+' : ''
            return {
              label: `${r.ruleName} — ${r.roomTypeName} el ${r.date}: ${oldP.toFixed(2)}${cur} → ${newP.toFixed(2)}${cur} (${sign}${pctChange.toFixed(1)}%)`,
            }
          })
          alerts.push({
            id:      'pricing-rule-applied-group',
            message: '🟣 Reglas automáticas de precio aplicadas',
            severity: 'info',
            items,
            doneAction: { label: 'Entendido', confirmEndpoint: '/api/alerts/pricing-rule-dismiss' },
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando reglas de precio aplicadas', e)
      }
    }

    // ── Alta ocupación: quedan pocas habitaciones libres (global) ────────────
    // Solo salta mientras QUEDE alguna libre (1 o 2) — si ya está completo (0
    // libres) no hay nada que vender, así que no salta. Las bloqueadas ya no
    // cuentan como libres (computeCalendarAvailability las resta). Hoy..hoy+14.
    if (alertEnabled('high-occupancy') && (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion'))) {
      try {
        const HIGH_OCC_MAX_FREE = 2, HIGH_OCC_DAYS = 14
        const fromD = todayISO
        const toD   = new Date(new Date(`${fromD}T12:00:00Z`).getTime() + HIGH_OCC_DAYS * 86400000).toISOString().slice(0, 10)
        const { freeByDate } = await computeCalendarAvailability(fromD, toD)
        const items = [...freeByDate.entries()]
          .filter(([, free]) => free > 0 && free <= HIGH_OCC_MAX_FREE)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([date, free]) => ({ label: `${date}: ${free} libre${free === 1 ? '' : 's'}` }))
        if (items.length > 0) {
          alerts.push({
            id:      'high-occupancy',
            message: '🔥 Quedan pocas habitaciones libres',
            severity: 'warning',
            items,
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando alta ocupación', e)
      }
    }

    // ── Quejas de huéspedes recientes (primeras 24 h) ───────────────────────────
    // Hilos de feedback (feedback_threads) calificados como queja, abiertos o
    // en curso — solo durante las primeras 24 h desde que se recibieron; pasado
    // ese plazo la alerta caduca sola (no se queda años avisando de una queja
    // olvidada, para eso está la pestaña de feedback). Para el responsable
    // asignado y dirección.
    if (alertEnabled('feedback-complaint-open') && (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion'))) {
      try {
        const cutoff = new Date(Date.now() - 24 * 3_600_000)
        const recent = await db.select({ id: feedbackThreads.id, category: feedbackThreads.category, text: feedbackThreads.text, createdAt: feedbackThreads.createdAt })
          .from(feedbackThreads)
          .where(and(eq(feedbackThreads.propertyId, pid), eq(feedbackThreads.sentiment, 'complaint'), inArray(feedbackThreads.status, ['open', 'in_progress']), gte(feedbackThreads.createdAt, cutoff)))
          .orderBy(feedbackThreads.createdAt).limit(20)
        if (recent.length > 0) {
          alerts.push({
            id: 'feedback-complaint-open',
            message: `🗣 ${recent.length} queja${recent.length === 1 ? '' : 's'} de huéspedes en las últimas 24 h`,
            severity: 'warning',
            items: recent.map(t => ({ label: `#${t.id} [${t.category}] ${t.text.slice(0, 120)}` })),
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando quejas recientes', e)
      }
    }

    // ── Salud del motor de reglas de precio ───────────────────────────────────
    // Un fallo del motor (columna que falta tras una migración, error en una
    // pasada) es silencioso: solo deja de aplicar reglas. Esta alerta lo hace
    // visible a dirección. Estado en memoria del proceso (ver getPricingEngineStatus).
    if (alertEnabled('pricing-engine-health') && (isAdmin(c) || roles.includes('direccion'))) {
      try {
        const st = getPricingEngineStatus()
        const problems: string[] = []
        if (st.looksStalled) problems.push(st.schedulerStartedAt == null
          ? 'el scheduler no está arrancado en este proceso'
          : `no arranca ninguna pasada desde hace ${st.minutesSinceLastStart} min (debería cada ${st.intervalMinutes})`)
        if (st.lastPass?.outcome === 'error') problems.push(`la última pasada falló: ${st.lastPass.error ?? 'error desconocido'}`)
        for (const w of st.lastPass?.warnings ?? []) problems.push(w.message.replace('[pricingRules] ', ''))
        if (problems.length > 0) {
          alerts.push({
            id: 'pricing-engine-health',
            message: '⚙️ Motor de reglas de precio con problemas — puede que no se estén aplicando',
            severity: 'warning',
            items: problems.slice(0, 8).map(label => ({ label })),
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando salud del motor de precios', e)
      }
    }

    // ── Servicio de desayunos flojo (valoración <= 5) ────────────────────────
    // Se marca al final del turno (housekeeping/recepción, PUT
    // /api/housekeeping/breakfast/rating). <=5 = "alguna queja" o peor.
    // Solo activa para la valoración de HOY y solo hasta las 15:00 (Madrid)
    // — pasada esa hora ya no hay nada que hacer con el desayuno de hoy, y
    // seguir avisando de valoraciones de días anteriores es ruido: para eso
    // ya está el histórico en Informes → Desayunos.
    if (madridHour < 15 && alertEnabled('breakfast-service-low') && (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion'))) {
      try {
        const todayMadridBreakfast = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
        const rows = await db.select().from(breakfastServiceRatings)
          .where(and(eq(breakfastServiceRatings.propertyId, pid), lte(breakfastServiceRatings.rating, 5), eq(breakfastServiceRatings.date, todayMadridBreakfast)))
        if (rows.length > 0) {
          alerts.push({
            id: 'breakfast-service-low',
            message: `🥐 Servicio de desayunos flojo hoy (valoración ${rows[0]!.rating}/10)`,
            severity: 'warning',
            items: rows.map(r => ({ label: `${r.date}: ${r.rating}/10${r.notes ? ` — ${r.notes}` : ''}` })),
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando valoración de desayunos', e)
      }
    }

    // ── Ampliación de estancia pagada sin disponibilidad (portal de cliente) ──
    // Ver POST /api/public/stripe/webhook (tipo 'extend_stay', src/routes/public.ts):
    // si al confirmarse el pago ya no hay disponibilidad real, se deja una nota
    // 'extend_unavailable' en vez de cambiar el check-out. La nota ES la marca
    // (mismo patrón que abandoned_cart_called/no_show_ota_confirmed más abajo);
    // se resuelve insertando una nota 'extend_unavailable_resolved' posterior.
    if (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion')) {
      try {
        const notes = await db.select({
          id: reservationNotes.id, reservationId: reservationNotes.reservationId,
          note: reservationNotes.note, type: reservationNotes.type, createdAt: reservationNotes.createdAt,
        }).from(reservationNotes)
          .where(and(inArray(reservationNotes.reservationId, tenantResIds()), inArray(reservationNotes.type, ['extend_unavailable', 'extend_unavailable_resolved'])))
          .orderBy(reservationNotes.createdAt)

        const latestByReservation = new Map<number, typeof notes[number]>()
        for (const n of notes) latestByReservation.set(n.reservationId, n) // ya viene ordenado por fecha asc

        for (const [reservationId, n] of latestByReservation) {
          if (n.type !== 'extend_unavailable') continue // la más reciente ya es la de resolución
          alerts.push({
            id: `extend-unavailable-${n.id}`,
            message: `💳 ${n.note}`,
            severity: 'urgent',
            reservationId,
            doneAction: { label: 'Resuelto', confirmEndpoint: `/api/alerts/extend-unavailable-resolve/${reservationId}` },
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando ampliaciones sin disponibilidad', e)
      }
    }

    // ── Ampliación de estancia aplicada pero con la habitación coincidiendo
    // con otra reserva (portal de cliente) ────────────────────────────────────
    // Distinto del caso anterior: aquí SÍ hubo disponibilidad del mismo TIPO
    // de habitación y la ampliación se aplicó (webhook 'extend_stay'), pero la
    // habitación física concreta del huésped coincide con otra reserva esas
    // noches — hay que reubicar a uno de los dos antes de esa fecha. Mismo
    // patrón de nota-como-marca que el bloque anterior.
    if (isAdmin(c) || roles.includes('recepcion') || roles.includes('direccion')) {
      try {
        const notes = await db.select({
          id: reservationNotes.id, reservationId: reservationNotes.reservationId,
          note: reservationNotes.note, type: reservationNotes.type, createdAt: reservationNotes.createdAt,
        }).from(reservationNotes)
          .where(and(inArray(reservationNotes.reservationId, tenantResIds()), inArray(reservationNotes.type, ['extend_needs_relocation', 'extend_needs_relocation_resolved'])))
          .orderBy(reservationNotes.createdAt)

        const latestByReservation = new Map<number, typeof notes[number]>()
        for (const n of notes) latestByReservation.set(n.reservationId, n)

        for (const [reservationId, n] of latestByReservation) {
          if (n.type !== 'extend_needs_relocation') continue
          alerts.push({
            id: `extend-needs-relocation-${n.id}`,
            message: `🔀 ${n.note}`,
            severity: 'urgent',
            reservationId,
            doneAction: { label: 'Reubicado', confirmEndpoint: `/api/alerts/extend-needs-relocation-resolve/${reservationId}` },
          })
        }
      } catch (e) {
        console.error('[alerts/urgent] fallo comprobando ampliaciones pendientes de reubicar', e)
      }
    }

    // ── Historial de alertas (alert_events) ──────────────────────────────────
    // El resto de esta función solo calcula alertas EN VIVO — aquí se deja
    // rastro de esas alertas (abrir/refrescar/cerrar solas) y se añaden las
    // creadas a mano (p.ej. "Comunicarse con Dirección") que no dependen de
    // ninguna condición en vivo. Ver src/db/schema/alerts.ts.
    try {
      // Las de severidad 'info' no se registran ni cuentan para nada aquí
      // (ni historial, ni informe por empleado) — son avisos de bajo peso
      // (p.ej. "reglas de precio aplicadas"), no incidencias a atender.
      const trackableAlerts = alerts.filter(a => a.severity !== 'info')
      const liveIds = new Set(trackableAlerts.map(a => a.id))
      const openRows = await db.select().from(alertEvents).where(and(eq(alertEvents.propertyId, pid), isNull(alertEvents.resolvedAt)))
      const openByKey = new Map(openRows.map(r => [r.entityKey, r]))

      // firstSeenAt/escalate por alerta — el frontend usa firstSeenAt para la
      // escalada de las urgentes (parpadeo a los 5 min, interrupción cada 10
      // min sin resolver), y escalate para desactivarla si ha empezado un
      // turno nuevo (shiftChangedSince) desde que se vio por primera vez.
      const firstSeenByKey = new Map<string, Date>()
      const escalateByKey  = new Map<string, boolean>()

      for (const a of trackableAlerts) {
        const existing = openByKey.get(a.id)
        if (existing) {
          await db.update(alertEvents)
            .set({ lastSeenAt: new Date(), message: a.message })
            .where(and(eq(alertEvents.id, existing.id), eq(alertEvents.propertyId, pid)))
          firstSeenByKey.set(a.id, existing.firstSeenAt)
          escalateByKey.set(a.id, !shiftChangedSince(existing.firstSeenAt))
        } else {
          const [created] = await db.insert(alertEvents).values({
            propertyId: pid,
            alertType:  a.id.replace(/-\d+$/, '').replace(/-group$/, ''),
            entityKey:  a.id,
            message:    a.message,
            severity:   a.severity ?? 'urgent',
            reservationId: a.reservationId,
          }).returning()
          if (created) firstSeenByKey.set(a.id, created.firstSeenAt)
          escalateByKey.set(a.id, true)  // recién creada, no ha podido haber cambio de turno todavía
        }
      }
      for (const a of alerts) {
        const firstSeenAt = firstSeenByKey.get(a.id)
        if (firstSeenAt) a.firstSeenAt = firstSeenAt.toISOString()
        const escalate = escalateByKey.get(a.id)
        if (escalate !== undefined) a.escalate = escalate
      }
      // Auto-resolver: automáticas (createdBy null) que ya no salen en vivo.
      for (const row of openRows) {
        if (!row.createdBy && !liveIds.has(row.entityKey)) {
          await db.update(alertEvents).set({ resolvedAt: new Date() }).where(and(eq(alertEvents.id, row.id), eq(alertEvents.propertyId, pid)))
        }
      }
      // Ocultar las silenciadas (siguen abiertas, no se han resuelto solas).
      const silencedKeys = new Set(openRows.filter(r => r.silencedAt).map(r => r.entityKey))
      if (silencedKeys.size > 0) {
        alerts = alerts.filter(a => !silencedKeys.has(a.id))
      }
      // Alertas manuales activas (no ligadas a ninguna condición en vivo) —
      // solo las dirigidas a algún rol del usuario actual, o sin audiencia.
      const manualRows = openRows.filter(r => r.createdBy && !r.silencedAt
        && (!r.audienceRole || roles.includes(r.audienceRole)))
      for (const r of manualRows) {
        alerts.push({
          id: r.entityKey,
          message: r.message,
          severity: (r.severity as any) ?? 'urgent',
          doneAction: { label: 'Hecho', confirmEndpoint: `/api/alerts/manual/${r.id}/resolve` },
          firstSeenAt: r.firstSeenAt.toISOString(),
          escalate: !shiftChangedSince(r.firstSeenAt),
        })
      }
    } catch (e) {
      console.error('[alerts/urgent] fallo registrando historial de alertas', e)
    }

    return c.json({ data: alerts })
  } catch (err) {
    console.error('[alerts/urgent]', err)
    return c.json({ data: [] })
  }
})

// POST /api/alerts/manual/direccion-urgente — "Comunicarse con Dirección
// (urgente)": un botón de un solo clic, para dirección, que dispara un aviso
// urgente SOLO al rol de recepción con la hora en que se generó.
app.post('/manual/direccion-urgente', async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const uid = getUserId(c)
    const tz = (await getBranding()).timezone
    const time = new Intl.DateTimeFormat('es-ES', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date())
    const [row] = await db.insert(alertEvents).values({
      propertyId:   getPropertyId(),
      alertType:    'direccion-urgente',
      entityKey:    `direccion-urgente-${Date.now()}`,
      message:      `Ha ocurrido una incidencia urgente a las ${time} horas, comunícate urgente con dirección`,
      severity:     'urgent',
      audienceRole: 'recepcion',
      createdBy:    uid,
    }).returning()
    return c.json({ data: row }, 201)
  } catch (err) {
    console.error('[alerts/manual/direccion-urgente]', err)
    return c.json({ error: 'Error al crear la alerta' }, 500)
  }
})

// POST /api/alerts/manual/:id/resolve — recepción marca atendida una alerta
// manual (p.ej. tras llamar a dirección). :id es el id de alert_events (no el
// entityKey) — lo usa el botón "Hecho" de la barra de alertas.
app.post('/manual/:id/resolve', async (c) => {
  try {
    const uid = getUserId(c)
    if (!uid) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(alertEvents)
      .set({ resolvedAt: new Date(), resolvedBy: uid })
      .where(and(eq(alertEvents.id, id), eq(alertEvents.propertyId, getPropertyId()), isNull(alertEvents.resolvedAt)))
      .returning()
    if (!updated) return c.json({ error: 'Alerta no encontrada o ya resuelta' }, 404)
    return c.json({ data: updated })
  } catch (err) { return c.json({ error: 'Error al resolver la alerta' }, 500) }
})

// POST /api/alerts/silence — silencia la ocurrencia ACTIVA de una alerta
// (vive o manual): deja de aparecer en la barra hasta que se resuelva sola o
// vuelva a activarse más tarde como una alerta nueva. Solo admin/dirección,
// desde la vista Alertas.
app.post('/silence', zValidator('json', z.object({ entityKey: z.string().min(1) })), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const uid = getUserId(c)
    const { entityKey } = c.req.valid('json')
    const [updated] = await db.update(alertEvents)
      .set({ silencedAt: new Date(), silencedBy: uid })
      .where(and(eq(alertEvents.entityKey, entityKey), eq(alertEvents.propertyId, getPropertyId()), isNull(alertEvents.resolvedAt)))
      .returning()
    if (!updated) return c.json({ error: 'No hay ninguna alerta activa con ese identificador' }, 404)
    return c.json({ data: updated })
  } catch (err) { return c.json({ error: 'Error al silenciar la alerta' }, 500) }
})

// GET /api/alerts/history?from=&to= — alertas activadas en un rango de fechas
// (por firstSeenAt), para la vista Alertas. Solo admin/dirección.
app.get('/history', zValidator('query', z.object({
  from:  z.string().date().optional(),
  to:    z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { from, to, limit } = c.req.valid('query')

    // Comparar por el DÍA en la zona horaria del tenant, no en la del servidor (que va en
    // UTC) — si no, "hoy" en el selector de fechas y "hoy" en la BD podían no
    // coincidir según la hora, dejando fuera alertas recién activadas.
    // 'info' no se registra desde ahora, pero puede haber filas viejas de
    // antes de este cambio — se excluyen igual aquí por si acaso.
    const tz = (await getBranding()).timezone
    const conditions = [eq(alertEvents.propertyId, getPropertyId()), ne(alertEvents.severity, 'info')]
    if (from) conditions.push(sql`(${alertEvents.firstSeenAt} AT TIME ZONE ${tz})::date >= ${from}::date`)
    if (to)   conditions.push(sql`(${alertEvents.firstSeenAt} AT TIME ZONE ${tz})::date <= ${to}::date`)

    const rows = await db.query.alertEvents.findMany({
      where: conditions.length ? and(...conditions) : undefined,
      orderBy: desc(alertEvents.firstSeenAt),
      limit,
      with: {
        reservation:    { columns: { id: true, externalCode: true }, with: { guest: { columns: { firstName: true, lastName: true } } } },
        silencedByUser: { columns: { id: true, firstName: true, lastName: true } },
        createdByUser:  { columns: { id: true, firstName: true, lastName: true } },
      },
    })
    return c.json({ data: rows })
  } catch (err) {
    console.error('[alerts/history]', err)
    return c.json({ error: 'Error al listar el historial' }, 500)
  }
})

// GET /api/alerts/employee-report?from=&to= — por cada turno de caja cerrado
// (shifts) en el rango, cuántas alertas que estuvieron activas durante ese
// turno se resolvieron/silenciaron ANTES de que cerrara (el empleado las
// atendió) frente a cuántas seguían activas justo al cerrarlo (se fue sin
// solucionarlas — quedan para el siguiente turno o para nadie). Un mismo
// aviso, si sigue sin resolverse varios turnos seguidos, cuenta como
// "abandonada" en cada uno de ellos — cada empleado tuvo su oportunidad de
// solucionarla y no lo hizo. Solo admin/dirección.
// Limitación conocida: no todas las alertas se "resuelven" por una acción
// humana — algunas se autolimpian solas al pasar el tiempo o cambiar una
// condición sin intervención de nadie (p.ej. una ventana horaria que expira).
// Este informe usa resolvedAt/silencedAt como proxy de "atendida", no como
// prueba de que alguien hizo algo — trátalo como orientativo, no como
// auditoría exacta.
app.get('/employee-report', zValidator('query', z.object({
  from: z.string().date(),
  to:   z.string().date(),
})), async (c) => {
  try {
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { from, to } = c.req.valid('query')
    const fromDt = new Date(`${from}T00:00:00Z`)
    const toDt   = new Date(`${to}T23:59:59Z`)

    const shiftRows = await db.query.shifts.findMany({
      where: and(eq(shifts.propertyId, getPropertyId()), isNotNull(shifts.closedAt), gte(shifts.closedAt, fromDt), lte(shifts.closedAt, toDt)),
      with: { openedByUser: { columns: { id: true, firstName: true, lastName: true } } },
      columns: { id: true, openedBy: true, openedAt: true, closedAt: true },
    })
    if (shiftRows.length === 0) return c.json({ data: [] })

    const minOpen  = shiftRows.reduce((m, s) => s.openedAt < m ? s.openedAt : m, shiftRows[0]!.openedAt)
    const maxClose = shiftRows.reduce((m, s) => (s.closedAt! > m ? s.closedAt! : m), shiftRows[0]!.closedAt!)

    // Candidatas: cualquier alerta que pudiera solapar con algún turno del
    // rango — existía ya antes de que acabara el último turno, y (si se
    // resolvió) no lo hizo antes de que empezara el primero.
    const candidates = await db.query.alertEvents.findMany({
      where: and(
        eq(alertEvents.propertyId, getPropertyId()),
        ne(alertEvents.severity, 'info'),
        lte(alertEvents.firstSeenAt, maxClose),
        or(isNull(alertEvents.resolvedAt), gte(alertEvents.resolvedAt, minOpen))!,
      ),
      columns: { id: true, firstSeenAt: true, resolvedAt: true, silencedAt: true },
    })
    const alerts = candidates.map(a => {
      const resolved = a.resolvedAt ?? null
      const silenced = a.silencedAt ?? null
      const clearedAt = resolved && silenced ? (resolved < silenced ? resolved : silenced) : (resolved ?? silenced)
      return { firstSeenAt: a.firstSeenAt, clearedAt }
    })

    type Stat = { userId: number; name: string; resolved: number; abandoned: number; shiftsWorked: number }
    const byUser = new Map<number, Stat>()

    for (const s of shiftRows) {
      const u = s.openedByUser as any
      const key = s.openedBy
      const stat = byUser.get(key) ?? {
        userId: key, name: u ? `${u.firstName} ${u.lastName}` : `#${key}`, resolved: 0, abandoned: 0, shiftsWorked: 0,
      }
      stat.shiftsWorked++
      for (const a of alerts) {
        const overlaps = a.firstSeenAt < s.closedAt! && (a.clearedAt == null || a.clearedAt > s.openedAt)
        if (!overlaps) continue
        if (a.clearedAt != null && a.clearedAt <= s.closedAt!) stat.resolved++
        else stat.abandoned++
      }
      byUser.set(key, stat)
    }

    const data = [...byUser.values()].sort((a, b) => b.abandoned - a.abandoned || a.name.localeCompare(b.name))
    return c.json({ data })
  } catch (err) {
    console.error('[alerts/employee-report]', err)
    return c.json({ error: 'Error al calcular el informe' }, 500)
  }
})

// POST /api/alerts/seen — marca un tipo de alerta como visto ahora mismo.
// Usado por vistas que "resuelven" una alerta con solo visitarlas (ej. Extras):
// la alerta deja de mostrarse hasta que haya novedades posteriores a esta marca.
app.post('/seen', zValidator('json', z.object({
  alertType: z.string().min(1),
})), async (c) => {
  try {
    const { alertType } = c.req.valid('json')
    await db.insert(alertSeenMarks)
      .values({ propertyId: getPropertyId(), alertType, seenAt: new Date() })
      .onConflictDoUpdate({ target: [alertSeenMarks.propertyId, alertSeenMarks.alertType], set: { seenAt: new Date() } })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/seen]', err)
    return c.json({ error: 'Error al marcar la alerta como vista' }, 500)
  }
})

// POST /api/alerts/no-show-confirm/:id — marca como hecho el aviso de "marcar
// No Show en booking.com" para esa reserva concreta: deja una nota en la
// reserva (tipo 'no_show_ota_confirmed') que la alerta de arriba excluye a
// partir de ahora — no hay que borrar nada más, la nota ES la marca.
app.post('/no-show-confirm/:id', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const uid = getUserId(c)
    if (!id) return c.json({ error: 'Reserva inválida' }, 400)

    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!res) return c.json({ error: 'Reserva no encontrada' }, 404)

    await db.insert(reservationNotes).values({
      reservationId: id,
      authorId:      uid ?? null,
      note:          'No Show marcado manualmente en booking.com',
      type:          'no_show_ota_confirmed',
    })
    // Marca quién la resolvió (urgente, "no es suya" — la causa Booking, no
    // recepción) — la nota de arriba ya hace que deje de salir en vivo; esto
    // solo es para poder atribuir el +1 del resumen de fin de turno.
    await db.update(alertEvents)
      .set({ resolvedAt: new Date(), resolvedBy: uid })
      .where(and(eq(alertEvents.propertyId, getPropertyId()), eq(alertEvents.entityKey, `no-show-booking-${id}`), isNull(alertEvents.resolvedAt)))
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/no-show-confirm]', err)
    return c.json({ error: 'Error al confirmar' }, 500)
  }
})

// POST /api/alerts/abandoned-cart-call-confirm/:id — marca como hecho el
// aviso de "llamar por carrito abandonado" para esa reserva: deja una nota
// (tipo 'abandoned_cart_called') que la alerta de arriba excluye a partir de
// ahora — no hay que borrar nada más, la nota ES la marca.
app.post('/abandoned-cart-call-confirm/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    if (!id) return c.json({ error: 'Reserva inválida' }, 400)

    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, id), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!res) return c.json({ error: 'Reserva no encontrada' }, 404)

    await db.insert(reservationNotes).values({
      reservationId: id,
      authorId:      getUserId(c) ?? null,
      note:          'Llamada realizada por carrito abandonado',
      type:          'abandoned_cart_called',
    })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/abandoned-cart-call-confirm]', err)
    return c.json({ error: 'Error al confirmar' }, 500)
  }
})

// POST /api/alerts/extend-unavailable-resolve/:reservationId — dirección/recepción
// marca resuelta (reubicada o reembolsada a mano) una ampliación de estancia
// pagada por el huésped que no pudo aplicarse por falta de disponibilidad real.
app.post('/extend-unavailable-resolve/:reservationId', async (c) => {
  try {
    const reservationId = Number(c.req.param('reservationId'))
    if (!reservationId) return c.json({ error: 'Reserva inválida' }, 400)

    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!res) return c.json({ error: 'Reserva no encontrada' }, 404)

    await db.insert(reservationNotes).values({
      reservationId,
      authorId: getUserId(c) ?? null,
      note:     'Ampliación sin disponibilidad resuelta a mano',
      type:     'extend_unavailable_resolved',
    })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/extend-unavailable-resolve]', err)
    return c.json({ error: 'Error al confirmar' }, 500)
  }
})

// POST /api/alerts/extend-needs-relocation-resolve/:reservationId — dirección/
// recepción marca resuelta una ampliación aplicada que necesitaba reubicar a
// alguien (habitación concreta coincidía con otra reserva). También libera
// el bloqueo temporal creado en esa habitación de reserva (ver
// src/routes/public.ts, rama 'extend_stay' del webhook de Stripe) — si el
// bloqueo ya no está (p.ej. porque ya se usó al reubicar de verdad), no pasa
// nada por no encontrarlo.
app.post('/extend-needs-relocation-resolve/:reservationId', async (c) => {
  try {
    const reservationId = Number(c.req.param('reservationId'))
    if (!reservationId) return c.json({ error: 'Reserva inválida' }, 400)

    const res = await db.query.reservations.findFirst({ where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())), columns: { id: true } })
    if (!res) return c.json({ error: 'Reserva no encontrada' }, 404)

    await db.delete(blockedBeds).where(and(eq(blockedBeds.propertyId, getPropertyId()), eq(blockedBeds.reason, `Reservado para reubicación — ampliación de la reserva #${reservationId}`)))

    await db.insert(reservationNotes).values({
      reservationId,
      authorId: getUserId(c) ?? null,
      note:     'Reubicación de la ampliación resuelta a mano',
      type:     'extend_needs_relocation_resolved',
    })
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/extend-needs-relocation-resolve]', err)
    return c.json({ error: 'Error al confirmar' }, 500)
  }
})

// POST /api/alerts/pricing-rule-dismiss — marca como vistas TODAS las
// aplicaciones de reglas de precio pendientes de confirmar (botón "Entendido"
// de la alerta agrupada) — no una a una, de golpe.
app.post('/pricing-rule-dismiss', async (c) => {
  try {
    await db.update(pricingRuleApplications)
      .set({ dismissedAt: new Date() })
      .where(and(
        isNull(pricingRuleApplications.dismissedAt),
        inArray(pricingRuleApplications.roomTypeId, db.select({ id: roomTypes.id }).from(roomTypes).where(eq(roomTypes.propertyId, getPropertyId()))),
      ))
    return c.json({ ok: true })
  } catch (err) {
    console.error('[alerts/pricing-rule-dismiss]', err)
    return c.json({ error: 'Error al confirmar' }, 500)
  }
})

export default app
