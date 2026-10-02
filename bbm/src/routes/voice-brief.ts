// ─── Voice brief — app Android de wake word ────────────────────────────────
// Endpoint para la app nativa Android: detecta la palabra de activación en segundo plano (Picovoice
// Porcupine), transcribe lo que se pide con el reconocedor de voz del
// propio Android y llama aquí con el texto — reutiliza el mismo bucle de
// agente que el chat normal del panel (runAgentLoop, src/routes/ai.ts), así
// que entiende las mismas preguntas ("¿ha entrado alguna reserva nueva en
// las últimas 2 horas?") con las mismas herramientas. También expone un
// resumen de cifras (GET /dashboard) para la pantalla principal de la app,
// mismos datos que el "Resumen rápido" de dirección en el panel web
// (frontend/components/AdminQuickStats.tsx).
//
// Auth: token estático por cabecera (no JWT, no login) — mismo patrón que
// src/routes/zkteco.ts para integraciones de dispositivo. El token identifica
// al TENANT: secreto VOICE_APP_TOKEN del tenant (admite varios separados por
// coma) y VOICE_APP_USER_ID (o setting voice.userId) como usuario del agente.
// Montado ANTES de requireAuth en index.ts, así que resuelve el tenant aquí.
import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { reservations, rooms, financialTransactions, properties, users } from '../db/schema'
import { eq, and, or, count, countDistinct, notInArray, isNotNull, lte, gt, ne, between, sql } from 'drizzle-orm'
import { env } from '../lib/env'
import { timingSafeEqual } from 'node:crypto'
import { runWithProperty, getPropertyId, getBranding, hasFeature, settingOf } from '../lib/property'
import { serverError } from '../lib/errors'
import { realPaidByReservation, pendingBalance } from '../lib/paymentAggregate'
import { runAgentLoop, ctxForUser, type AiUserCtx } from './ai'

const app = new Hono()

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// Token → tenant (+ usuario del agente). Barrido de properties.settings; el .env
// global solo vale con ALLOW_ENV_SECRET_FALLBACK=1 (modo un-solo-hotel), y entonces
// el tenant es el del usuario VOICE_APP_USER_ID.
async function resolveVoiceTenant(token: string | undefined): Promise<{ propertyId: number; userId?: number } | null> {
  if (!token) return null
  const rows = await db.select().from(properties).where(eq(properties.active, true))
  for (const p of rows) {
    const tokens = (settingOf<string>(p, 'secrets.VOICE_APP_TOKEN') ?? '').split(',').map(t => t.trim()).filter(Boolean)
    if (tokens.some(t => safeEq(t, token))) {
      const uid = Number(settingOf<string | number>(p, 'secrets.VOICE_APP_USER_ID') ?? settingOf<string | number>(p, 'voice.userId')) || undefined
      return { propertyId: p.id, userId: uid }
    }
  }
  if (process.env.ALLOW_ENV_SECRET_FALLBACK === '1' && env.VOICE_APP_TOKEN && safeEq(env.VOICE_APP_TOKEN, token)) {
    if (env.VOICE_APP_USER_ID) {
      const u = await db.query.users.findFirst({ where: eq(users.id, Number(env.VOICE_APP_USER_ID)), columns: { propertyId: true } })
      if (u) return { propertyId: u.propertyId, userId: Number(env.VOICE_APP_USER_ID) }
    }
    if (rows.length === 1) return { propertyId: rows[0]!.id }
  }
  return null
}

// Middleware: resuelve tenant por token y corre todo dentro de runWithProperty
app.use('*', async (c, next) => {
  const token = c.req.header('Authorization')?.replace('Bearer ', '')
  const t = await resolveVoiceTenant(token)
  if (!t) return c.json({ error: 'No autorizado' }, 401)
  c.set('voiceUserId' as never, t.userId as never)
  return runWithProperty(t.propertyId, async () => {
    if (!await hasFeature('voice')) return c.json({ error: 'Módulo no activado' }, 404)
    return next()
  })
})

// Día actual en la zona horaria del hotel
async function todayStr(): Promise<string> {
  const tz = (await getBranding()).timezone
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
}

// El historial de la conversación lo manda la propia app (mismo patrón que
// POST /api/ai/chat con el panel web: quien llama manda el array completo de
// turnos, el servidor no guarda nada entre llamadas) — la app Android
// mantiene la conversación en memoria mientras esté reciente (unas horas) y
// la reenvía entera en cada pregunta, igual que ya hacía el micrófono del
// panel (frontend/components/AgentFloat.tsx, estado `msgs`).
// Se lee en voz alta con el TTS del móvil — una respuesta larga se hace
// pesada de escuchar. Solo se pide más detalle si el propio usuario lo pide
// explícitamente en la pregunta.
const VOICE_SYSTEM_EXTRA = 'Estás respondiendo a una pregunta hablada por voz, que se lee en voz alta con un sintetizador de voz (no hay pantalla). Sé breve: 1-3 frases como mucho, directas, sin listas largas ni relatar pasos intermedios. Solo entra en más detalle o enumera varios elementos si el usuario lo pide explícitamente (p.ej. "dame más detalle", "cuéntame todas").'

app.post('/', zValidator('json', z.object({
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string().min(1).max(2000),
  })).min(1).max(40),
})), async (c) => {
  try {
    const { messages } = c.req.valid('json')
    const voiceUserId = c.get('voiceUserId' as never) as number | undefined
    const userCtx: AiUserCtx = voiceUserId
      ? await ctxForUser(voiceUserId)
      : { roles: ['direccion'] }

    const { text: answer } = await runAgentLoop(messages, userCtx, VOICE_SYSTEM_EXTRA)

    return c.json({ text: answer })
  } catch (err) { return serverError(c, err) }
})

// ─── GET /dashboard — cifras rápidas para la pantalla principal de la app ──
// Mismos criterios que src/routes/dashboard.ts (/occupancy, /arrivals, /) y
// src/routes/financial.ts (/reports/summary) — duplicado aquí a propósito
// (no son funciones exportadas, son handlers de ruta) en vez de tocar esos
// archivos para exportar algo que solo usa este endpoint.
app.get('/dashboard', async (c) => {
  try {
    const today = await todayStr()
    const pid = getPropertyId()

    const [roomRow] = await db.select({ total: count() }).from(rooms)
      .where(and(eq(rooms.propertyId, pid), eq(rooms.active, true), ne(rooms.code, 'VIRTUAL')))
    const totalRooms = Number(roomRow?.total ?? 0)

    const [occRow] = await db.select({ occupied: countDistinct(reservations.roomId) }).from(reservations)
      .where(and(
        eq(reservations.propertyId, pid),
        lte(reservations.checkInDate, today),
        gt(reservations.checkOutDate, today),
        notInArray(reservations.status, ['cancelled', 'no_show']),
        isNotNull(reservations.roomId),
      ))
    const occupied = Number(occRow?.occupied ?? 0)
    const occupancyPct = totalRooms > 0 ? Math.round((occupied / totalRooms) * 100) : 0

    const [newResRow] = await db.select({ count: count() }).from(reservations)
      .where(and(eq(reservations.propertyId, pid), sql`${reservations.bookedAt}::date = ${today}::date`))

    const txs = await db.query.financialTransactions.findMany({
      where: and(
        eq(financialTransactions.propertyId, pid),
        between(financialTransactions.transactionDate, today, today),
        notInArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
        sql`${financialTransactions.category} IS DISTINCT FROM 'movimiento_caja'`,
      ),
    })
    const totalPaidToday = txs.reduce((s, t) => s + parseFloat(t.amount), 0)
    const byMethod: Record<string, { count: number; total: number }> = {}
    for (const t of txs) {
      byMethod[t.paymentMethod] ??= { count: 0, total: 0 }
      byMethod[t.paymentMethod]!.count++
      byMethod[t.paymentMethod]!.total += parseFloat(t.amount)
    }

    const arrivals = await db.query.reservations.findMany({
      where: and(
        eq(reservations.propertyId, pid),
        eq(reservations.checkInDate, today),
        or(eq(reservations.status, 'tentative'), eq(reservations.status, 'arriving'), eq(reservations.status, 'confirmed')),
      ),
      with: { room: true, bookingChannel: true },
      limit: 200,
    })
    const realPaidById = await realPaidByReservation(arrivals.map(r => r.id))
    const pendingArrivals = arrivals.map(r => ({
      roomCode: (r as any).room?.code ?? '—',
      channel: (r as any).bookingChannel?.name ?? '—',
      pendingBalance: pendingBalance(r.total, realPaidById.get(r.id) ?? 0),
    }))

    return c.json({
      occupancyPct,
      totalPaidToday,
      newReservationsToday: Number(newResRow?.count ?? 0),
      byMethod,
      pendingArrivals,
    })
  } catch (err) { return serverError(c, err) }
})

export default app
