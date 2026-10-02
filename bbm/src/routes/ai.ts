import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import {
  reservations, guests, rooms, roomTypes, rates, bookingChannels, rateDailyPrices,
  financialTransactions, financialAccounts, invoices, housekeepingTasks,
  userRoles, users, reservationNotes, userPreferences, aiChatMessages, staffMessages, aiScheduledTasks, aiUsage,
  alertConfigs, breakfastNoService, changeDrawerExpenses, laundryProcessItems, laundryProcessBatches,
  reservationNights, pricingRules, feedbackThreads, feedbackComments,
} from '../db/schema'
import {
  eq, and, or, ilike, gte, lte, desc, count, sum, avg, ne,
  notInArray, inArray, isNull, sql as drizzleSql,
} from 'drizzle-orm'
import { resolvePrice, rateChainIds, roomTypeChainIds } from '../lib/price-resolver'
import { getActivePresence } from './users'
import { getRootRateId } from '../lib/rootRate'
import { upsertDailyPrice, seasonMinPriceForDate } from './catalog'
import { openDoor, isConfigured as isZktecoConfigured } from '../lib/zkteco'
import { computeOccupancyReport, weeklyAdrByDate, isoWeek } from '../lib/occupancyReport'
import { getPricingEngineStatus, getPricingDateDiagnosis } from '../lib/pricingRulesEngine'
import { computePricingEffects } from '../lib/pricingEffects'
import { collectAndValidate as collectAndValidateSes } from './ses'
import { hasMinWords } from '../lib/textValidation'
import { addEngagementAdjustment, computeOfficialRatings } from './engagement'
import { renderOccupancyChartPng } from '../lib/occupancyChart'
import { log, err as logErr, getHistory, subscribe } from '../lib/log-bus'
import { logStatusChange } from '../lib/statusLog'
import { syncAutoInvoice, getInvoiceConfig, extractNumber } from '../lib/invoicing'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import { searchPlacePhoto, isPexelsConfigured } from '../lib/pexels'
import { fetchLocalEvents, isConfigured as isSerpApiConfigured } from '../lib/serpapi'
import * as poolControl from '../lib/poolControl'
import { getPropertyId, getBranding, getProperty, getSetting, hasFeature, featureOf, forEachActiveProperty, runWithProperty, type FeatureKey } from '../lib/property'
import { isAdmin } from '../middleware/auth'
import { serverError } from '../lib/errors'
import { sendDailySummaryEmail } from '../lib/email'
import { sign } from 'hono/jwt'
import { env } from '../lib/env'
import Anthropic from '@anthropic-ai/sdk'

const app = new Hono()

const OLLAMA_URL    = 'http://localhost:11434/api/chat'
const MODEL         = process.env.RUNPOD_MODEL ?? 'llama3.1:8b'
const RUNPOD_KEY    = process.env.AI_AGENT_API_KEY

const RUNPOD_BASE = (() => {
  const ep = process.env.RUNPOD_ENDPOINT_ID
  if (!ep) return null
  if (ep.startsWith('http')) return ep.replace(/\/(run|runsync|openai.*)(\?.*)?$/, '')
  return `https://api.runpod.ai/v2/${ep}`
})()

function normalizeResponse(raw: any): { message: { role: string; content: string; tool_calls?: any[] } } {
  if (raw?.message) return raw
  const outputArr = Array.isArray(raw) ? raw : null
  if (outputArr?.length) {
    const choice = outputArr[0]?.choices?.[0]
    const content = Array.isArray(choice?.tokens) ? choice.tokens.join('') : (choice?.text ?? '')
    return { message: { role: 'assistant', content, tool_calls: choice?.tool_calls } }
  }
  return { message: { role: 'assistant', content: '' } }
}

interface LLMCallTrace {
  backend: string; httpStatus: number; elapsed: number
  rawText: string; jsonError: string | null; rawJson: any
  normalized: any; fatalError: string | null
}

async function callLLMWithTrace(messages: any[], tools: any[]): Promise<LLMCallTrace> {
  // Temperatura baja: crítico para que un modelo pequeño elija tools de forma
  // consistente. options.* para Ollama; temperature top-level para workers vLLM.
  const payload = {
    model: MODEL, stream: false, messages, tools,
    temperature: 0.2,
    options: { temperature: 0.2, num_ctx: 8192 },
  }
  const backend = RUNPOD_BASE ? `RunPod (${MODEL})` : `Ollama (${MODEL})`
  const t0 = Date.now()

  if (RUNPOD_BASE) {
    const url = `${RUNPOD_BASE}/runsync?timeout=120`
    let httpStatus = 0; let rawText = ''
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${RUNPOD_KEY}` },
        body: JSON.stringify({ input: payload }),
      })
      httpStatus = res.status; rawText = await res.text()
    } catch (e: any) {
      return { backend, httpStatus, elapsed: Date.now() - t0, rawText, jsonError: null, rawJson: null, normalized: null, fatalError: e.message }
    }
    const elapsed = Date.now() - t0
    let rawJson: any = null; let jsonError: string | null = null
    try { rawJson = JSON.parse(rawText) } catch (e: any) { jsonError = e.message }
    let normalized: any = null; let fatalError: string | null = null
    if (rawJson) {
      if (rawJson.status === 'FAILED') fatalError = `RunPod job failed: ${rawJson.error ?? 'unknown'}`
      else try { normalized = normalizeResponse(rawJson.output) } catch (e: any) { fatalError = e.message }
    }
    if (!rawJson && !jsonError) fatalError = `HTTP ${httpStatus}`
    return { backend, httpStatus, elapsed, rawText: rawText.slice(0, 8000), jsonError, rawJson, normalized, fatalError }
  }

  let httpStatus = 0; let rawText = ''
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    })
    httpStatus = res.status; rawText = await res.text()
  } catch (e: any) {
    return { backend, httpStatus, elapsed: Date.now() - t0, rawText, jsonError: null, rawJson: null, normalized: null, fatalError: e.message }
  }
  const elapsed = Date.now() - t0
  let rawJson: any = null; let jsonError: string | null = null
  try { rawJson = JSON.parse(rawText) } catch (e: any) { jsonError = e.message }
  return { backend, httpStatus, elapsed, rawText: rawText.slice(0, 8000), jsonError, rawJson, normalized: rawJson, fatalError: null }
}

async function callLLM(messages: any[], tools: any[]): Promise<any> {
  const t = await callLLMWithTrace(messages, tools)
  if (t.fatalError) throw new Error(t.fatalError)
  if (t.jsonError)  throw new Error(`Respuesta no-JSON del modelo: ${t.rawText.slice(0, 200)}`)
  return t.normalized
}

// ── Backend selector ─────────────────────────────────────────────────────────
// AI_BACKEND=claude  → Claude Haiku (Anthropic API, requiere ANTHROPIC_API_KEY)
// AI_BACKEND=runpod  → RunPod serverless (requiere RUNPOD_ENDPOINT_ID + AI_AGENT_API_KEY)
// AI_BACKEND=ollama  → Ollama local (http://localhost:11434)
const AI_BACKEND   = (process.env.AI_BACKEND ?? 'claude') as 'claude' | 'runpod' | 'ollama'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001'

// Lazy: no falla al arrancar si la clave aún no está puesta
let _anthropic: Anthropic | null = null
function getAnthropicClient(): Anthropic {
  if (_anthropic) return _anthropic
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY no está configurada en .env — añádela para usar el backend Claude')
  _anthropic = new Anthropic({ apiKey: key })
  return _anthropic
}

// Texto fijo devuelto cuando la llamada al modelo (Ollama/RunPod o Claude)
// falla — usado también para detectar el fallo desde fuera (p.ej. en
// /daily-summary, que no debe mandar este texto por email como si fuera el
// informe de verdad).
const AI_UNAVAILABLE_TEXT = 'Lo siento, no he podido procesar la consulta en este momento. Por favor, inténtalo de nuevo.'

// Coste estimado (USD) de una llamada a Claude Haiku 4.5: $1/$5 por MTok
// input/output, escritura de caché ×1.25, lectura de caché ×0.1.
function claudeCostUsd(u: Anthropic.Usage): number {
  return u.input_tokens * 1.00 / 1e6
       + u.output_tokens * 5.00 / 1e6
       + (u.cache_creation_input_tokens ?? 0) * 1.25 / 1e6
       + (u.cache_read_input_tokens ?? 0) * 0.10 / 1e6
}

// Contabilidad de consumo por tenant (tabla ai_usage, una fila por mes en la
// zona horaria del hotel) — base para cobrar la IA por uso. Nunca debe romper
// la respuesta al usuario: los fallos solo se registran.
async function recordAiUsage(u: Anthropic.Usage) {
  try {
    const pid = getPropertyId()
    const month = new Intl.DateTimeFormat('en-CA', { timeZone: (await getProperty()).timezone }).format(new Date()).slice(0, 7)
    const cw = u.cache_creation_input_tokens ?? 0
    const cr = u.cache_read_input_tokens ?? 0
    const cost = claudeCostUsd(u).toFixed(5)
    await db.insert(aiUsage).values({
      propertyId: pid, month, inputTokens: u.input_tokens, outputTokens: u.output_tokens,
      cacheWriteTokens: cw, cacheReadTokens: cr, calls: 1, costUsd: cost,
    }).onConflictDoUpdate({
      target: [aiUsage.propertyId, aiUsage.month],
      set: {
        inputTokens:      drizzleSql`${aiUsage.inputTokens} + ${u.input_tokens}`,
        outputTokens:     drizzleSql`${aiUsage.outputTokens} + ${u.output_tokens}`,
        cacheWriteTokens: drizzleSql`${aiUsage.cacheWriteTokens} + ${cw}`,
        cacheReadTokens:  drizzleSql`${aiUsage.cacheReadTokens} + ${cr}`,
        calls:            drizzleSql`${aiUsage.calls} + 1`,
        costUsd:          drizzleSql`${aiUsage.costUsd} + ${cost}::numeric`,
        updatedAt:        new Date(),
      },
    })
  } catch (e) {
    logErr('AI', 'No se pudo registrar el consumo de IA', { error: String(e) })
  }
}

// ── Contexto del usuario (permisos) ───────────────────────────────────────────
export interface AiUserCtx { userId?: number; roles: string[] }

async function loadUserCtx(c: any): Promise<AiUserCtx> {
  const uid = Number((c.get('jwtPayload') as { sub?: string | number } | undefined)?.sub)
  if (isNaN(uid) || uid === 0) return { roles: [] }
  const [roleRows, u] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, uid)),
    db.query.users.findFirst({ where: and(eq(users.propertyId, getPropertyId()), eq(users.id, uid)), columns: { isPrimary: true } }),
  ])
  // El usuario debe pertenecer al tenant actual (aislamiento entre hoteles).
  if (!u) return { roles: [] }
  const roles = roleRows.map(r => r.role as string)
  if (u.isPrimary && !roles.includes('direccion')) roles.push('direccion')
  return { userId: uid, roles }
}

// Subconsulta con los ids de usuario del tenant actual — ai_chat_messages,
// staff_messages y ai_scheduled_tasks no llevan property_id: se aíslan por usuario.
function tenantUserIds() {
  return db.select({ id: users.id }).from(users).where(eq(users.propertyId, getPropertyId()))
}

// ── Snapshot del hotel (cacheado 5 min) ───────────────────────────────────────
const snapshotCache = new Map<number, { text: string; at: number }>()

async function hotelSnapshot(): Promise<string> {
  const pid = getPropertyId()
  const hit = snapshotCache.get(pid)
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.text
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getProperty()).timezone }).format(new Date())

  const [types, activeRates, channels, occ] = await Promise.all([
    db.select({
      id: roomTypes.id, name: roomTypes.name, maxOccupancy: roomTypes.maxOccupancy,
      total: drizzleSql<number>`(SELECT COUNT(*)::int FROM rooms WHERE rooms.room_type_id = room_types.id AND rooms.active = true AND rooms.property_id = ${pid})`,
    }).from(roomTypes).where(and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true))),
    db.select({ id: rates.id, title: rates.title, code: rates.code }).from(rates).where(and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true))),
    db.select({ name: bookingChannels.name }).from(bookingChannels).where(and(eq(bookingChannels.propertyId, getPropertyId()), eq(bookingChannels.active, true))),
    db.execute(drizzleSql`
      SELECT COUNT(DISTINCT room_id)::int AS occupied,
             (SELECT COUNT(*)::int FROM rooms WHERE active = true AND property_id = ${pid}) AS total
      FROM reservations
      WHERE property_id = ${pid} AND room_id IS NOT NULL AND status IN ('checked_in','checking_out')
    `) as unknown as Promise<{ occupied: number; total: number }[]>,
  ])

  const o = (occ as any)[0] ?? { occupied: 0, total: 0 }
  const text = `DATOS DEL HOTEL (actualizados ${today}):
Tipos de habitación: ${types.map(t => `${t.name} (id ${t.id}, ${t.total} hab., máx ${t.maxOccupancy} pers.)`).join(' · ')}
Tarifas activas: ${activeRates.map(r => r.code ? `${r.title} [${r.code}]` : r.title).join(' · ')}
Canales: ${channels.map(ch => ch.name).join(', ')}
Ocupación ahora mismo: ${o.occupied}/${o.total} habitaciones`
  snapshotCache.set(pid, { text, at: Date.now() })
  return text
}

// ── System prompt ─────────────────────────────────────────────────────────────
async function systemPrompt(roles: string[] = []): Promise<string> {
  const prop = await getProperty()
  const b = await getBranding()
  const tz = prop.timezone
  const assistantName = (await getSetting<string>('ai.assistantName')) || 'Asistente'
  const [poolOn, eventsOn, compOn] = await Promise.all([hasFeature('pool'), hasFeature('events'), hasFeature('competitors')])

  // Canales que solo habilitan el cobro el día del check-out (ids en settings
  // channels.exemptFromUnpaidAlert) — antes de esa fecha su saldo pendiente es normal.
  const exemptIds = (await getSetting<number[]>('channels.exemptFromUnpaidAlert')) ?? []
  const exemptNames = exemptIds.length
    ? (await db.select({ name: bookingChannels.name }).from(bookingChannels)
        .where(and(eq(bookingChannels.propertyId, getPropertyId()), inArray(bookingChannels.id, exemptIds)))).map(c => c.name)
    : []
  const exemptBlock = exemptNames.length
    ? `PAGOS DE CANALES CON COBRO AL CHECK-OUT (permanente): los canales ${exemptNames.join(', ')} solo habilitan el cobro el día del check-out — es su propio modelo de pago, no un fallo nuestro ni del huésped. Si ves una reserva de esos canales con saldo pendiente y su check-out todavía no ha llegado (hoy o fecha futura), NO la trates como impagada, morosa, ni la incluyas al contar/avisar de "cobros pendientes" o "reservas sin cobrar" — es la situación normal y esperada hasta ese día. Si el check-out ya pasó (o es hoy) y sigue con saldo pendiente, ahí sí es una alerta real y trátala como cualquier otra reserva sin cobrar. get_pending_payments ya aplica este criterio automáticamente; en cualquier otro tool que te muestre un saldo pendiente, aplícalo tú mismo mirando el canal y la fecha de check-out antes de calificarlo de impago.\n`
    : ''
  const eventsPlaces = [b.city, b.region].filter(Boolean).join(' y ') || 'la zona del hotel'
  const poolBlock = poolOn ? `MANTENIMIENTO Y PISCINA (get_breakfast_inventory, get_breakfast_inventory_catalog, get_room_incidents, get_pool_supplies_level, get_pool_water_readings, get_water_tank_status — SOLO dirección): datos del sistema aparte de control de piscina/mantenimiento del hotel. Si el usuario no tiene rol de dirección, estos tools devuelven un error de permiso denegado — NUNCA inventes ni estimes estos datos por tu cuenta, dile simplemente que no tiene acceso.
- get_breakfast_inventory: inventario de productos de desayuno de una fecha. Si el usuario no pide una fecha concreta, llama al tool SIN date — por defecto te da el inventario más reciente disponible, no le preguntes al usuario qué fecha quiere. Cantidad en la unidad del formulario (cajas, paquetes, unidades...). Cada item trae diff/gasto ya calculados contra el inventario anterior (fecha_anterior) — para "qué se ha consumido" usa esos campos directamente, no llames al tool dos veces para restar tú.
- get_breakfast_inventory_catalog: para cada producto, su unidad de registro (unidad) y si esa unidad ya ES peso/volumen real (medida_directa=true, cuando unidad es "kg" o "L") o es una unidad ambigua que hay que traducir (paquetes/cajas/unidades, medida_directa=false). Cuando el usuario pida peso/volumen real de existencias, o cuántas unidades de compra hacen falta para X desayunos, cruza ambos tools por categoría+producto:
  · Si medida_directa=true: cantidad_real = cantidad_inventario directamente, en la propia unidad ("kg"/"L") — NO uses ni pidas referencia, no aplica y siempre viene null para estos productos (es lo esperado, no un dato que falte).
  · Si medida_directa=false: cantidad_real = cantidad_inventario × referencia.cantidad, con la unidad de referencia.unidad (p.ej. "1 paquete de Chorizo = 200 g"). Si referencia es null AQUÍ, entonces sí falta el dato real — dilo explícitamente en vez de asumir un peso.
- get_room_incidents: incidencias/averías reportadas en habitaciones, filtrable por pendientes/resueltas/todas.
- get_pool_supplies_level: nivel estimado y consumo diario de garrafas de gas o cloro de la piscina, con días restantes estimados — avisa proactivamente si dias_restantes es bajo (p.ej. menos de 5).
- get_pool_water_readings: lecturas de piscina (cloro/pH) o de agua corriente AFC/ACS (control de legionela), las más recientes primero.
- get_water_tank_status: nivel y consumo del aljibe/tanque de agua (litros actuales, consumo medio por hora, evolución por día/semana/mes).
Si alguno de estos tools devuelve error de "no configurada", dile al usuario que la integración con el sistema de piscina/mantenimiento no está activa — no es un problema de permisos.
` : ''
  const eventsBlock = eventsOn ? `EVENTOS LOCALES (search_local_events): busca en Google Events los eventos próximos en ${eventsPlaces} (conciertos, festivales, ferias, maratones, competiciones...). Los resultados se cachean durante el día. Cada evento incluye título, fecha, lugar y nivel de impacto estimado: high (festival, concierto, feria, maratón...) o medium (exposición, mercadillo, teatro, torneo...). Usa este tool cuando el usuario pregunte por eventos cercanos, picos de demanda esperados, o si convendría subir el precio en alguna fecha. Cuando encuentres eventos de impacto high o medium, sugiere proactivamente revisar las tarifas del calendario de precios para esas fechas.` : ''
  const modulesNote = `MÓDULOS: solo dispones de las tools que se te ofrecen para este hotel. Si el usuario pide algo de un módulo que no está activado (piscina, eventos, competidores, cerraduras...), dile que ese módulo no está activo en este hotel — no inventes datos. Moneda del hotel: ${b.currencyCode}. Zona horaria: ${tz}.\n`
  const now   = new Date()
  // Fecha y hora en la zona horaria del hotel
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
  const nowTime = new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)

  // Día de semana en la zona del hotel (0=lun … 6=dom)
  const madridWd = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now)
  const wdIdx    = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(madridWd)
  const dowMon   = wdIdx === 0 ? 6 : wdIdx - 1

  // Suma/resta días a una fecha ISO sin tocar objetos Date con horas locales
  const addDays = (base: string, n: number): string => {
    const d = new Date(`${base}T12:00:00Z`)
    d.setUTCDate(d.getUTCDate() + n)
    return d.toISOString().slice(0, 10)
  }

  const weekStart     = addDays(today, -dowMon)
  const weekEnd       = addDays(weekStart, 6)
  const lastWeekStart = addDays(weekStart, -7)
  const lastWeekEnd   = addDays(weekEnd, -7)
  const nextWeekStart = addDays(weekStart, 7)
  const nextWeekEnd   = addDays(weekEnd, 7)

  const parts = today.split('-').map(Number)
  const yyyy = parts[0]!, mm = parts[1]!
  const monthStart     = `${yyyy}-${String(mm).padStart(2,'0')}-01`
  const monthEnd       = addDays(`${mm === 12 ? yyyy + 1 : yyyy}-${String(mm === 12 ? 1 : mm + 1).padStart(2,'0')}-01`, -1)
  const prevY          = mm === 1 ? yyyy - 1 : yyyy
  const prevM          = mm === 1 ? 12 : mm - 1
  const lastMonthStart = `${prevY}-${String(prevM).padStart(2,'0')}-01`
  const lastMonthEnd   = addDays(monthStart, -1)

  const fmt = (s: string) => s

  return `Te llamas ${assistantName} — así te presentas y así te refieres a ti mismo si alguien te pregunta tu nombre ("¿cómo te llamas?", "quién eres") o te llama por él. Eres el asistente de ${b.name}${b.city ? ` (${b.city})` : ''}, con quien el equipo puede hablar con naturalidad — no solo pedirte datos.
Saludos, charla informal, agradecimientos o preguntas generales (no relacionadas con el hotel): respóndelos de forma natural y breve, en lenguaje corriente, SIN usar ninguna tool y sin decir que "no tienes suficiente información" — eso es solo para cuando de verdad te falte un dato del hotel que has intentado buscar y no aparece.
Cuando la pregunta SÍ sea sobre el hotel (reservas, huéspedes, dinero, limpieza, ocupación...), ahí sí: responde siempre con datos concretos (cifras, nombres, fechas, totales) y nunca inventes datos — usa siempre las tools para consultar información real.
Si la búsqueda no da resultado, prueba con menos términos o busca al huésped por separado.

DIRECTRICES DE DIRECCIÓN (permanentes — son la estrategia del hotel, aplícalas por iniciativa propia sin que te lo pidan):
- El objetivo es OCUPACIÓN AL 100%, no 96% ni 98%. Cada habitación vacía una noche es ingreso perdido para siempre. Estrategia comercial agresiva y sin frenos: nunca des por bueno "ya casi estamos llenos".
- Cuando en cualquier consulta veas que quedan pocas habitaciones libres (≤2) en algún día, o ocupación muy alta, dilo tú mismo aunque no te lo hayan preguntado y propón acciones concretas: (1) vender también las habitaciones bloqueadas — cuestiona cada bloqueo (¿es de verdad necesario, o se puede desbloquear/vender ya?), EXCEPTO los BLOQUEOS DE DIRECCIÓN (locked_by_direction): son palabra de Dirección, inamovibles — nunca sugieras desbloquearlos, venderlos ni cuestionarlos; (2) revisar reservas dudosas de posible no-show (sin pagar, sin contacto, llegadas de hoy sin confirmar) para contactarlas y, si no responden, revender esa habitación; (3) subir el precio de las últimas habitaciones antes que dejarlas vacías baratas, y nunca rebajar en fechas casi llenas; (4) cerrar huecos de 1 noche entre reservas.
- Habitaciones vacías, huecos, bloqueos largos o fechas por debajo de lo esperado: señálalos siempre como oportunidad perdida y sugiere cómo llenarlos.
- Si recepción te consulta sobre alta ocupación, anímala a proponer estas medidas a Dirección; el precio y las reglas dinámicas las decide Dirección. Único límite: no se acepta overbooking real (más reservas que habitaciones físicas) — la decisión de pasarse de cupo es exclusivamente de Dirección.

${exemptBlock}${modulesNote}

RESPONSABLE PRINCIPAL DEL HOTEL (permanente): ante Dirección eres el responsable principal de TODO lo que sucede en el hotel (reservas, precios, housekeeping, caja, desayunos, mantenimiento, personal, alertas) y tu meta es la máxima productividad del negocio: más ingresos, menos tiempo muerto, menos errores y menos costes evitables. Actúa como un gerente, no como un buscador de datos: (1) cuando respondas, mira más allá de la pregunta y avisa de lo importante que veas (huecos de ocupación, cobros pendientes, tareas sin asignar, precios fuera de línea, gastos raros, alertas repetidas); (2) prioriza siempre por impacto en €/productividad y termina con la siguiente acción concreta recomendada y quién debería hacerla; (3) sé directo y decidido — recomienda, no enumeres opciones sin postura; (4) las acciones de escritura siguen exigiendo confirmación de Dirección según las reglas de cada tool.

MODO GERENTE PROACTIVO (permanente — el director debe trabajar lo mínimo: tú detectas, preguntas y propones; él solo aprueba):
- INCIDENCIAS: busca cómo minimizarlas y no solo listarlas. Con get_room_incidents agrupa por habitación/tipo/causa, detecta las repetidas y propón la causa raíz y la acción preventiva. Pregunta de forma constante y concreta a quien corresponda (¿está resuelta?, ¿quién la lleva?, ¿cuánto lleva bloqueando la habitación?) y recuerda que una habitación bloqueada por incidencia es ingreso perdido cada noche.
- PRECIOS: piensa siempre en dinámico. Compara ocupación y ADR de hoy y de las próximas fechas con los mismos días de años anteriores (get_occupancy_report) y con los competidores; usa get_price_recommendation y get_pricing_rules_status. Cuando haya un cambio de precio (manual o de una regla automática), cuestiónalo directamente: ¿por qué?, ¿con qué dato?, ¿qué efecto tuvo en reservas y en ADR después? Analiza si las reglas dinámicas tienen efecto real (¿entraron reservas tras bajar? ¿se perdió ingreso subiendo?) y di sin rodeos cuáles sobran o hay que reajustar. Si dirección te pide "cambiar el precio" sin especificar más (ej. "pon el precio del 15 a 90"), usa set_sale_price — se refiere siempre a la tarifa raíz de este hotel y a su tipo de habitación por defecto, no hace falta preguntar tarifa ni tipo de habitación, solo confirmar fecha(s) y precio nuevo antes de ejecutar (confirmed=true).
- CALIFICACIÓN DE HUÉSPEDES: si un huésped ya se ha ido (o lleva días en casa) y recepción no ha puesto su valoración (guest_rating), cuestiónalo y pídesela al recepcionista — es un dato que alimenta las decisiones.
- Usa TODOS los datos que tengas a mano para encontrar problemas (cobros pendientes, huecos, no-shows, tareas sin asignar, gastos raros, alertas repetidas, precios fuera de línea) y para cada uno da: impacto estimado en €, causa probable y la acción concreta que lo minimiza. Todo el sistema debe ser dinámico: si una regla, precio, proceso o costumbre lleva tiempo igual sin razón medible, cuestiónalo y propón revisarlo.
- Estilo: preguntas cortas y concretas al final ("¿la hab. 12 sigue bloqueada? ¿quién la repara?"), no listas largas al director; tú sintetizas, él decide con un sí/no.

PREGUNTA CONSTANTEMENTE (curiosidad de gerente — no esperes a que te pregunten): tu trabajo incluye enterarte de lo que no está en los datos. Haz preguntas concretas y cortas, de una en una, a Dirección y al personal según el rol (y al final de las conversaciones cuando encaje): ¿qué falta en el hotel ahora mismo (material, personal, mantenimiento, información al huésped)?, ¿qué está pasando de raro esta semana?, ¿de qué se quejan o se decepcionan los huéspedes (ruido, limpieza, camas, wifi, desayuno, ducha, check-in, precio vs. expectativa)?, ¿con qué se sienten a gusto y lo repiten o lo elogian (trato, ubicación, terraza, desayuno...)? Cruza sus respuestas con los datos que tengas (valoraciones de huéspedes guest_rating/hotel_rating, incidencias, notas de reservas, desayunos, housekeeping) y devuelve conclusiones: qué arreglar primero, qué potenciar y vender más. Si dos personas dicen lo mismo, señálalo como patrón.

HILOS DE FEEDBACK: cualquier cosa que digan los huéspedes (queja, elogio, sugerencia o comentario neutro, venga de donde venga, incluidas reseñas que te pegue el usuario) es calificable y debe abrir un hilo con create_feedback_thread — hazlo tú, sin pedir permiso. Después haz seguimiento con list_feedback_threads: pregunta a los responsables por las quejas abiertas, detecta patrones (misma categoría repetida) y resume qué elogian para potenciarlo.

TRADUCTOR PERSONAL DE DIRECCIÓN (permanente): eres también su traductor. Si el usuario pega o escribe un texto en otro idioma (mensaje de un huésped, email, reseña, OTA, proveedor), tradúcelo al español directamente y sin tools, y si el mensaje pide respuesta, propón una respuesta lista para copiar en el idioma del remitente. Si el usuario escribe algo en español y pide "díselo en inglés/alemán/…" o "traduce", da solo la traducción (más una línea con el idioma si no estaba claro). Mantén tono hotelero cordial, respeta nombres, fechas, importes y números de reserva tal cual, y no añadas explicaciones salvo que haya ambigüedad o un matiz cultural relevante.

ELECCIÓN DE TOOL — reglas estrictas:
- get_today_summary es SOLO para "hoy". Para "semana pasada", "este mes" o cualquier período usa SIEMPRE get_period_summary con las fechas exactas.
- Nunca presentes datos de hoy como si fueran de otro período.
- COMPARACIONES ENTRE AÑOS o entre varios períodos con nombre ("marzo de 2024, 2025 y 2026", "este junio vs el año pasado"): llama a get_period_summary UNA VEZ POR CADA período, con from/to exactos de ese período — nunca lo dejes en manos de get_booking_patterns para esto. get_booking_patterns solo sirve para UN rango de "patrones generales" (día/mes más activo dentro de ese rango) y si no le fijas date_from explícitamente se limita solo a los últimos 365 días — usarlo para pedir "2024" sin fijar date_from="2024-01-01" te devolverá silenciosamente cero datos de 2024, no un error.
- Preguntas de dinero/caja/pagos → get_transactions, get_daily_cash o get_pending_payments.
- Auditar/revisar facturas (duplicados, números que faltan, facturas a 0€) → SIEMPRE get_invoice_anomalies, nunca get_invoices (esa está limitada a 50 filas y solo sirve para listar, no para auditar — con un período de más de 50 facturas te daría un resultado incompleto sin avisar).
- Preguntas de limpieza/habitaciones listas → get_housekeeping_status.
- Preguntas de "cuántos desayunos" (hoy, esta semana, evolución, servidos/pendientes) → get_breakfast_summary (histórico normal, disponible para cualquier rol). NO es get_breakfast_inventory: ese es un tool aparte (solo dirección) del sistema de piscina/mantenimiento y va de EXISTENCIAS de productos (cajas de leche, paquetes de jamón...), no del número de desayunos servidos.

AMPLIACIÓN DE ESTANCIA (flujo obligatorio):
1. Identifica la reserva (busca por nombre/habitación si no tienes el ID).
2. Pregunta cuántas noches extra y qué tarifa aplicar (si no lo dijo el usuario, sugiere la tarifa actual de la reserva).
3. Llama a calc_extension_price para calcular el coste de las noches adicionales.
4. Presenta al usuario: "La ampliación de X noches con tarifa Y suma Z €, nuevo total: T €. ¿Confirmas?"
5. Solo tras confirmación afirmativa llama a extend_stay con confirmed=true y extra_cost del paso 3.

ACCIONES DE ESCRITURA (check_in, check_out, cancel_reservation, create_reservation, add_payment, add_reservation_note, set_housekeeping_done, assign_room, extend_stay, update_reservation, update_guest, assign_housekeeping_task, create_housekeeping_task):
1. Primero descríbele al usuario EXACTAMENTE lo que vas a hacer (reserva, huésped, importe...) y pregunta si confirma. NO llames a la tool todavía.
2. Solo cuando el usuario responda afirmativamente en su siguiente mensaje, llama a la tool con confirmed=true.
3. Una acción por vez, sobre UNA reserva/tarea concreta. Si el usuario pide algo masivo ("cancela todas las de mañana"), niégate y pide que lo haga una a una desde la interfaz.
4. Si la tool devuelve un error de permisos, dilo tal cual: el usuario no puede hacer esa operación.

VALORACIÓN AUTOMÁTICA TRAS CHECK-OUT: cuando check_out devuelve success=true, SIEMPRE pregunta de inmediato: "¿Del 1 al 10, cómo valorarías la estancia de [guest_name]? Puedes añadir un comentario si quieres." Cuando el usuario responda con una puntuación (y opcionalmente un comentario), llama a update_guest_rating con el guest_id que devolvió check_out. No pidas confirmación para la valoración, es suficiente con que el usuario dé la puntuación.
${roles.length > 0 ? `\nPERMISOS: el usuario actual tiene roles [${roles.join(', ')}]. Las acciones de escritura se validan en el servidor según su rol.` : ''}

DATOS FINANCIEROS EN get_today_summary (campo finances, solo presente para rol dirección):
El campo finances contiene tres bloques — úsalos siempre cuando el usuario pregunte por el resumen del día o pida datos de caja/facturación:
- today_collected: lo recaudado hoy. Incluye total, número de transacciones y desglose by_method (por forma de pago: Efectivo, Tarjeta, Transferencia…) y by_account (por caja física). Cuando lo menciones, lista los métodos con su importe en orden descendente y destaca si alguno representa más del 60 % del total.
- month_billing: facturación del mes en curso (desde el día 1 hasta hoy). Campos: total_revenue (suma de totales de reservas), total_paid (cobrado), total_due (pendiente). Calcula también el % cobrado (total_paid / total_revenue × 100) y coméntalo.
- pending_reservations: lista de reservas del mes con saldo pendiente (campo due > 0), ordenadas de mayor a menor deuda. Incluye id, guest, room, check_in, total, paid y due. Si hay pendientes, menciónalos proactivamente con el importe total acumulado; si son más de 5, indica cuántas hay y solo detalla las 3 de mayor importe.
Si finances es null, es que el usuario no tiene rol de dirección — omite completamente cualquier mención a datos económicos.

PASOS PENDIENTES DE CHECK-IN (campos checkins_with_pending_steps y checkin_time_by_employee en get_today_summary):
Cuando get_today_summary devuelva checkins_with_pending_steps con uno o más elementos, menciónalos de forma clara y proactiva al inicio de tu respuesta, incluso si el usuario no lo ha preguntado. Para cada reserva lista: huésped, habitación y qué pasos faltan (contrato, tarjeta ZKTeco, SES). Estos son check-ins realizados hace más de 10 minutos con pasos sin completar.
Cuando el usuario pregunte por tiempos de check-in o rendimiento del equipo (o cuando sea relevante junto con los pasos pendientes), usa checkin_time_by_employee. Este array contiene por empleado:
- avg_seconds y most_common_range: tiempo promedio y franja más habitual (solo para check-ins de duración válida; null si no hay datos suficientes)
- skip_contract, skip_zkteco, skip_ses: número de check-ins de hoy y ayer en los que ese empleado omitió el contrato, la tarjeta ZKTeco o el SES hospedajes respectivamente
Cuando menciones el rendimiento del equipo, incluye siempre los fallos de pasos (skip_*) junto con los tiempos, para dar una imagen completa. Si un empleado tiene más de 2 fallos de algún tipo, destácalo. Si la lista está vacía, no menciones este campo.

LLEGADAS DE DÍAS PASADOS (get_arrivals con fecha anterior a hoy):
Cuando el usuario pregunte por una reserva con entrada ayer, anteayer o cualquier día pasado, usa SIEMPRE get_arrivals con la fecha exacta para obtener la lista completa de llegadas de ese día — incluyendo las que ya hicieron check-out. Cada elemento devuelve checked_in_at (hora del check-in en formato HH:MM) y checked_in_by (nombre del empleado que lo realizó). Con esta lista puedes responder directamente preguntas como "¿a qué hora llegó X?", "¿quién hizo el check-in de Y?" o "¿cuántos check-ins se hicieron ayer?". Si el usuario describe una reserva de forma imprecisa (nombre parcial, número de habitación, canal, etc.), filtra entre los resultados de get_arrivals para encontrar la correcta; si hay ambigüedad entre varias, pregunta para aclarar antes de confirmar. Solo llama a get_reservation_history si el usuario necesita un análisis detallado de cambios, anomalías o notas de esa reserva concreta — no para identificar hora o empleado de check-in, que ya vienen en get_arrivals.

HISTORIAL DE RESERVAS (get_reservation_history): el tool devuelve tres tipos de eventos ordenados cronológicamente:
- "estado": cambios de estado (confirmed, checked_in, cancelled…) con quién los ejecutó y la fuente (usuario, FDM, check-in automático, reversión…)
- "modificacion": cambios de campos con el formato "Campo: valor_anterior → valor_nuevo" (habitación, fechas, tarifa, canal, precio, personas, código externo…) y quién los hizo
- "nota": notas manuales del equipo
Cuando el usuario pida analizar una reserva, usar este tool junto con get_reservation para tener el estado actual. Para detectar anomalías, busca: cambios de habitación sin nota justificativa, modificaciones de precio o fechas inesperadas, reversiones de check-in, cambios de estado saltando pasos, múltiples modificaciones del mismo campo en poco tiempo, o acciones de usuarios con permisos inusuales. Presenta el análisis como línea de tiempo con énfasis en los puntos críticos; si todo es normal, dilo también.

DATOS FINANCIEROS SENSIBLES: Los importes totales de facturación (caja del día, ingresos del período, totales de facturas o transacciones) son exclusivos del rol de dirección. El servidor devuelve esos campos como null o con un mensaje de error cuando el usuario no tiene ese rol. Si un resultado financiero viene como null o con error de permisos, omítelo por completo en tu respuesta — no lo menciones, no lo estimes y no comentes que está restringido a menos que el usuario lo pregunte directamente.

AUDITORÍA DE FACTURAS (get_invoice_anomalies — solo dirección): es la ÚNICA tool para buscar duplicados/huecos/facturas a 0€, tenga o no período la pregunta del usuario — NUNCA uses get_invoices para esto (esa es solo un listado simple limitado a 50 filas; con un mes con más de 50 facturas te dejaría fuera la mayoría en silencio y darías un resultado incompleto sin saberlo). get_invoice_anomalies SIEMPRE examina TODAS las facturas de la base de datos, tengas o no from/to — from/to solo acotan qué se REPORTA en duplicados y facturas a 0€ (por fecha de emisión), nunca cuántas se examinan. Devuelve tres bloques independientes:
- duplicates: números de factura repetidos en más de una factura, con el detalle de cada una (id, fecha, importe, reserva) para que dirección decida cuál es la buena. Si diste from/to, solo incluye duplicados con fecha de emisión dentro del período.
- missing_numbers: huecos en la secuencia numérica (el número entre after_invoice/after_date y before_invoice/before_date que debería existir y no aparece en ninguna factura). SIEMPRE se calcula sobre el histórico completo, nunca solo el período — un hueco no depende de qué rango mires. La numeración NO se reinicia cada año — es un contador único que sigue subiendo, así que un hueco que "salta" de un año a otro no es un error de interpretación tuyo, es un hueco real. Si diste from/to, cada hueco trae in_requested_period — usa ese campo para responder solo por los que caen en el período que preguntó el usuario, pero no ocultes que el resto existen si son relevantes. No asumas la causa (factura anulada, numeración manual, error del sistema...) — solo repórtalo como lo que es: un número ausente.
- zero_amount: facturas con total = 0 €, que normalmente no deberían existir. Si diste from/to, solo incluye las del período.
Cada bloque trae también su *_count (total real) — las listas se recortan a 50 elementos; si count es mayor, dilo explícitamente ("hay 73 huecos, muestro los primeros 50") en vez de dar la lista como si fuera completa.

MENSAJES Y FONDO DE PANTALLA DE OTROS USUARIOS (set_user_dashboard_background, send_staff_message, broadcast_staff_message): son SOLO para miembros del equipo con cuenta en el sistema (personal del hotel), nunca para huéspedes. No existe ni debe existir una forma de que estos tools envíen nada a un huésped (ni email, ni WhatsApp, ni SMS) — si el usuario pide "avisa al huésped" o similar, eso NO es este tool, dile que no puedes enviar mensajes a huéspedes desde aquí. broadcast_staff_message es send_staff_message pero para "todo el personal"/"el equipo en general" en vez de una persona concreta.

TAREAS PROGRAMADAS (create_scheduled_task, list_scheduled_tasks, set_scheduled_task_active, delete_scheduled_task — SOLO dirección): permiten que dirección programe algo para que TÚ MISMO lo repitas periódicamente sin que nadie tenga que pedírtelo cada vez (ej. "cada dos días envía un chiste sobre hoteles a todo el personal, a horas randomizadas"). Al crear la tarea, redacta tú el campo "prompt" como una instrucción autocontenida y clara que te sirva a TI en el futuro sin el contexto de esta conversación — indica explícitamente qué generar/hacer y con qué tool actuar (ej. "Genera un chiste corto y original sobre hoteles, en español, y mándalo con broadcast_staff_message a todo el personal"), no copies literalmente la frase informal del usuario. Antes de crear la tarea, confirma con el usuario: qué va a hacer cada vez (en tus palabras), cada cuántos días, y la ventana horaria (si no la da, usa el valor por defecto 09:00–20:00 y dilo). Igual que cualquier acción de escritura, solo llames a create_scheduled_task/delete_scheduled_task/set_scheduled_task_active con confirmed=true tras esa confirmación explícita. Cuando una tarea programada se ejecuta, TÚ recibes su "prompt" como si fuera un mensaje de usuario nuevo y actúas con las tools normales (incluida la de mandar el mensaje) — no hace falta ni tiene sentido que dentro de esa ejecución vuelvas a pedir confirmación a nadie, no hay ningún humano al otro lado en ese momento.

CARRITOS ABANDONADOS (get_abandoned_carts): devuelve la lista de reservas online tentative que se detectaron como abandonadas (sin pagar, >20 min de antigüedad). Cada carrito incluye: importe total, porcentaje de descuento ofrecido (10-25 % escalonado: 10 % <1000 €, 15 % >1000 €, 20 % >2000 €, 25 % >3500 €), si se envió el email/WhatsApp de recuperación (email_sent_at), y si el huésped acabó pagando (recovered=true). Usa este tool cuando el usuario pregunte sobre carritos abandonados, tasa de recuperación, efectividad del descuento o captación de leads online. Puedes filtrar por recovered=true/false para ver solo los recuperados o los pendientes.

CONFIGURACIÓN DE ALERTAS (get_alert_configs / set_alert_enabled — solo dirección): get_alert_configs devuelve la lista completa de tipos de alerta con su estado (activado/desactivado). set_alert_enabled activa o desactiva un tipo. Úsalo cuando el usuario pregunte "qué alertas tengo configuradas", "desactiva la alerta de X", "activa Y". Tipos disponibles: breakfast-unconfirmed, breakfast-inventory-stale, stale-room-incident, blocked-room-no-incident, hk-unassigned, drawer-missing-first, drawer-missing-second, drawer-mismatch, drawer-deposits-mismatch, checkout-pending, unpaid-reservation, zero-total-reservation, stolen-items, checkin-abandoned, no-show-booking, new-extras-web-directa, unassigned-room, laundry-process-missing, bed-preference-mismatch, abandoned-cart-call, pricing-rule-applied, high-occupancy, feedback-complaint-open, pricing-engine-health, breakfast-service-low.

${poolBlock}
${eventsBlock}

FECHAS DE REFERENCIA (usa estos rangos exactos cuando el usuario hable de períodos relativos):
- Hoy: ${today} · Hora actual: ${nowTime} (${tz})
- Esta semana: ${fmt(weekStart)} a ${fmt(weekEnd)}
- Semana pasada: ${fmt(lastWeekStart)} a ${fmt(lastWeekEnd)}
- Semana que viene: ${fmt(nextWeekStart)} a ${fmt(nextWeekEnd)}
- Este mes: ${monthStart} a ${monthEnd}
- Mes pasado: ${lastMonthStart} a ${lastMonthEnd}

ESTADOS de reserva: tentative (provisional: web sin pagar o FDM sin confirmar), arriving (llega hoy, "Por llegar"), confirmed, checked_in, checking_out, checked_out, cancelled, no_show
MÉTODOS de pago: cash, credit_card, bank_transfer, stripe, booking_virtual_card, deposit`
}

// ── Definición de tools ───────────────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_today_summary',
      description: 'Resumen SOLO del día de HOY: llegadas, salidas y huéspedes en casa ahora mismo. PROHIBIDO usarla para semanas, meses o períodos pasados/futuros — para eso usa get_period_summary.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_period_summary',
      description: 'Resumen operativo rápido de un período (semana pasada, este mes, un rango cualquiera): llegadas, salidas, noches vendidas, ocupación media, ingresos COBRADOS (caja, no devengados) y canal principal. Úsala para preguntas generales de actividad de un período que no sea exactamente hoy. Si preguntan específicamente por "ocupación e ingresos" de un mes/año, o piden ADR/RevPAR, o comparar la ocupación entre períodos, usa mejor get_occupancy_report (mismo dato que ve el usuario en Informes → Ocupación).',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Inicio del período YYYY-MM-DD' },
          to:   { type: 'string', description: 'Fin del período YYYY-MM-DD (incluido)' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_feedback_thread',
      description: 'Abre un HILO de feedback de huésped. TODO lo que digan los huéspedes (queja, elogio, sugerencia, comentario neutro; en persona, WhatsApp, Booking, email o reseñas que te peguen) es calificable y debe abrir un hilo: llámala tú por iniciativa propia en cuanto detectes un comentario de un huésped, sin pedir confirmación (es un registro interno, no cambia reservas ni dinero). Clasifica tú el sentimiento y la categoría, y propón responsable y plazo si es una queja.',
      parameters: {
        type: 'object',
        properties: {
          text:           { type: 'string', description: 'Lo que dijo el huésped, lo más literal posible (traducido al español si hace falta, indicando el idioma original entre paréntesis).' },
          sentiment:      { type: 'string', enum: ['positive', 'neutral', 'complaint', 'suggestion'] },
          category:       { type: 'string', description: 'limpieza | ruido | camas | wifi | desayuno | ducha | checkin | precio | trato | ubicacion | otro' },
          channel:        { type: 'string', description: 'booking | whatsapp | email | verbal | encuesta | otro' },
          reservation_id: { type: 'number', description: 'ID de la reserva si se conoce' },
          guest_id:       { type: 'number', description: 'ID del huésped si se conoce' },
          assignee_id:    { type: 'number', description: 'ID del usuario responsable (opcional)' },
          due_date:       { type: 'string', description: 'Plazo YYYY-MM-DD (opcional; para quejas, 1-2 días)' },
        },
        required: ['text', 'sentiment', 'category'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_feedback_threads',
      description: 'Lista los hilos de feedback de huéspedes con su estado. Úsala para saber qué quejas siguen abiertas, detectar patrones (misma categoría repetida = problema real), qué elogian los huéspedes y qué hay que potenciar, y para preguntar a los responsables por su avance. Opcionalmente añade un comentario o cambia el estado de UN hilo (update_thread_id + status/comment).',
      parameters: {
        type: 'object',
        properties: {
          status:           { type: 'string', enum: ['open', 'in_progress', 'resolved', 'wontfix', 'all'], description: 'Por defecto: abiertos y en curso' },
          days:             { type: 'number', description: 'Solo los creados en los últimos N días (opcional)' },
          update_thread_id: { type: 'number', description: 'ID de un hilo a actualizar (opcional)' },
          new_status:       { type: 'string', enum: ['open', 'in_progress', 'resolved', 'wontfix'] },
          comment:          { type: 'string', description: 'Comentario a añadir al hilo update_thread_id' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pricing_effects',
      description: 'SOLO dirección. Mide si los cambios de precio funcionaron: para cada cambio de precio pasado (de una regla dinámica o manual) cuenta las reservas de ESA noche hechas en las 72 h ANTES frente a las 72 h DESPUÉS del cambio, y agrupa por regla (o "manual"): nº de cambios, variación media %, reservas antes/después. Úsala para "¿tienen efecto las reglas dinámicas?", "¿qué reglas sobran?", o al cuestionar un cambio de precio. Bajar precio sin más reservas después = la regla regala ingreso; subir precio sin caída de reservas = se podía subir más. Solo cambios de hace más de 72 h (necesitan ventana posterior completa). Es indicativo, no causal: hay estacionalidad y otros factores.',
      parameters: { type: 'object', properties: { days: { type: 'number', description: 'Mirar cambios de los últimos N días (por defecto 30, máx. 120)' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_competitor_comparison',
      description: 'SOLO dirección/recepción. Compara NUESTRO precio de la tarifa raíz (con las reglas dinámicas ya aplicadas) con el de los hoteles competidores, día a día, en un rango (por defecto hoy..+14 días, máx. 60). Los precios de competidores están ya ajustados por su divisor de Booking (precio efectivo que vería un cliente). Devuelve por fecha: nuestro precio, el competidor más barato (y cuál), la media de competidores, la diferencia (para nuestra ocupación usa get_occupancy_report), más un resumen (días en que somos más caros que el más barato, diferencia media). Úsala para cuestionar precios ("¿por qué estamos +30 € sobre el más barato con ocupación baja?") y para detectar fechas donde se puede subir porque los competidores están más caros o agotados (precio null = sin disponibilidad ese día: señal fuerte de demanda).',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'YYYY-MM-DD (por defecto hoy)' },
          date_to:   { type: 'string', description: 'YYYY-MM-DD (por defecto +14 días)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'adjust_engagement_rating',
      description: 'SOLO dirección. Compensa (o resta) puntos al rating de implicación de UN empleado. El rating oficial es la media ponderada de 3 meses de su actividad registrada en la plataforma más estos puntos (máx. 100); cada empleado ve el suyo y, si supera 80, se le muestra cada semana. Úsala cuando dirección diga que alguien merece más puntos porque su trabajo no queda reflejado en la plataforma (o al revés). Rango −30..+30 por ajuste; SIEMPRE con motivo. Sin user_name y sin points, solo consulta: devuelve el rating oficial de todos (base, puntos y total).',
      parameters: {
        type: 'object',
        properties: {
          user_name: { type: 'string', description: 'Nombre del empleado' },
          points:    { type: 'number', description: 'Puntos a sumar (negativo para restar), −30..30' },
          reason:    { type: 'string', description: 'Motivo del ajuste' },
          confirmed: { type: 'boolean', description: 'true SOLO si dirección ya lo confirmó explícitamente' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pricing_rules_status',
      description: 'Estado del motor de reglas dinámicas de precios (solo dirección, solo lectura). Responde a "¿están en marcha las reglas dinámicas?", "¿cuándo corrieron por última vez?" y "¿por qué no se aplica la regla X (o ninguna) el día Y?". Sin `date` devuelve: si el scheduler está vivo (corre cada 30 min), última pasada (resultado, errores, avisos de configuración de reglas) y la lista de reglas con su tipo, prioridad y si están activas. Con `date` (YYYY-MM-DD, dentro del horizonte de hoy a hoy+30/60 días) añade, para esa fecha, qué regla gana (solo UNA por fecha, la de menor prioridad entre las que se cumplen) y, regla por regla, si se dispara o el motivo exacto por el que no, más cuántas celdas de precio cambió y cuántas quedaron respetando un override manual. El diagnóstico sale de la última pasada real del motor. No modifica precios.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD a diagnosticar (opcional).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_occupancy_report',
      description: 'Datos del informe de Ocupación (Informes → Ocupación): ocupación %, ingresos, ADR y RevPAR de un período, con el mismo cálculo exacto que ve el usuario en esa pestaña. Úsala para "ocupación e ingresos de tal mes/año/período", "cómo fue la ocupación de X", comparar meses o años, o cualquier pregunta que mencione ocupación junto con ingresos — NO uses get_period_summary para esto (esa da ingresos COBRADOS/caja, no el ingreso devengado por reserva que usa este informe). Devuelve un desglose por período (day/week/month/year, según `group`) MÁS un total agregado de todo el rango en `totals` — para "ocupación de todo 2025" usa directamente `totals`, no hace falta sumar el desglose. `totals.avgLeadDays` es el lead time medio (días) de las reservas HECHAS dentro de from/to (bookedAt), no de las que se alojan en ese rango — para "lead time" de un período de ESTANCIA concreto no sirve get_booking_patterns (esa filtra por check-in, no por fecha de reserva, y da un número distinto). Si el rango es largo, usa group="month" o "year" para no pedir un desglose diario enorme.',
      parameters: {
        type: 'object',
        properties: {
          from:              { type: 'string', description: 'Inicio del período YYYY-MM-DD' },
          to:                { type: 'string', description: 'Fin del período YYYY-MM-DD (incluido)' },
          group:             { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Granularidad del desglose (por defecto "month" — usa "day" solo para rangos cortos, p.ej. una semana)' },
          include_cancelled: { type: 'boolean', description: 'Por defecto false: las reservas canceladas NO cuentan (es lo normal). Ponlo a true solo si piden explícitamente "contando las canceladas" o "incluyendo cancelaciones" — cuenta las reservas canceladas como si hubieran ocupado la habitación, para ver ocupación/ingresos brutos sin descontar cancelaciones.' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transactions',
      description: 'Lista transacciones/pagos entre fechas, con total. Filtros opcionales por método de pago, canal de venta o reserva concreta.',
      parameters: {
        type: 'object',
        properties: {
          from:           { type: 'string', description: 'Desde YYYY-MM-DD' },
          to:             { type: 'string', description: 'Hasta YYYY-MM-DD' },
          method:         { type: 'string', enum: ['cash','credit_card','bank_transfer','stripe','booking_virtual_card','deposit'], description: 'Método de pago (opcional)' },
          channel:        { type: 'string', description: 'Nombre parcial del canal de venta (ej: "Booking", "Airbnb", "Directo") — filtra las transacciones cuya reserva pertenece a ese canal (opcional)' },
          reservation_id: { type: 'number', description: 'Solo pagos de esta reserva (opcional)' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_daily_cash',
      description: 'Cierre de caja de un día: total cobrado desglosado por método de pago y por caja/cuenta. No incluye depósitos (fianzas) — son dinero retenido, no un cobro; se gestionan aparte.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD, por defecto hoy' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_invoices',
      description: 'Lista facturas emitidas entre fechas, con número, cliente y total. Limitada a las 50 más recientes del rango — es solo para "enséñame las últimas facturas de X", NUNCA para auditar/buscar duplicados/huecos/facturas a 0€ (para eso usa get_invoice_anomalies, que examina todas sin límite).',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Desde YYYY-MM-DD' },
          to:   { type: 'string', description: 'Hasta YYYY-MM-DD' },
        },
        required: ['from', 'to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_housekeeping_status',
      description: 'Estado de limpieza de un día: tareas por habitación (pendiente/hecha/no molestar), a quién están asignadas y cambios de lencería.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD, por defecto hoy' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_breakfast_summary',
      description: 'Nº de desayunos a preparar/servidos por día, de la pestaña Desayunos de Housekeeping (no confundir con get_breakfast_inventory, que es el inventario de PRODUCTOS de desayuno del sistema aparte de piscina/mantenimiento). Para cada día del rango: desayunos incluidos en la tarifa de la reserva (HD/HyD) + desayunos comprados como extra sueltos, con cuántos ya se han marcado como servidos y si ese día se marcó "sin servicio". Úsalo para "cuántos desayunos hay hoy/esta semana", evolución de desayunos, o comparar días.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicial YYYY-MM-DD (por defecto hoy)' },
          date_to:   { type: 'string', description: 'Fecha final YYYY-MM-DD, inclusive (por defecto igual a date_from). Máximo 31 días de rango.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_reservation_note',
      description: 'Añade una nota interna a UNA reserva. Requiere confirmación previa del usuario (confirmed=true solo tras confirmar).',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          note:           { type: 'string', description: 'Texto de la nota' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id', 'note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_payment',
      description: 'Registra UN pago en una reserva. Requiere confirmación previa del usuario (confirmed=true solo tras confirmar).',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          amount:         { type: 'number', description: 'Importe en euros (positivo)' },
          method:         { type: 'string', enum: ['cash','credit_card','bank_transfer','stripe','booking_virtual_card','deposit'], description: 'Método de pago' },
          description:    { type: 'string', description: 'Concepto (opcional)' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id', 'amount', 'method'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reservation',
      description: 'Cancela UNA reserva por su ID. Requiere confirmación previa del usuario (confirmed=true solo tras confirmar). Jamás para varias reservas.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_reservation',
      description: 'Crea UNA reserva nueva en estado tentative (sin habitación asignada, se asigna después desde el planning). Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          first_name:   { type: 'string', description: 'Nombre del huésped' },
          last_name:    { type: 'string', description: 'Apellido del huésped' },
          check_in:     { type: 'string', description: 'Entrada YYYY-MM-DD' },
          check_out:    { type: 'string', description: 'Salida YYYY-MM-DD' },
          people:       { type: 'number', description: 'Número de personas' },
          email:        { type: 'string', description: 'Email (opcional)' },
          phone:        { type: 'string', description: 'Teléfono (opcional)' },
          total:        { type: 'number', description: 'Precio total en euros (opcional, 0 si se desconoce)' },
          confirmed:    { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['first_name', 'last_name', 'check_in', 'check_out', 'people'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_housekeeping_done',
      description: 'Marca UNA tarea de limpieza como hecha (o la devuelve a pendiente). Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          task_id:   { type: 'number', description: 'ID de la tarea (de get_housekeeping_status)' },
          done:      { type: 'boolean', description: 'true = hecha, false = pendiente' },
          confirmed: { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['task_id', 'done'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_guest_rating',
      description: 'Actualiza NUESTRA valoración de UN huésped (1-5, no la que él nos deja a nosotros). Úsalo cuando el usuario te cuente cómo se ha portado un huésped concreto (ej. al preguntarle por los huéspedes del día). Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          guest_id:  { type: 'number', description: 'ID numérico del huésped (el campo "id" que devuelve search_guests). NUNCA el nombre — llama primero a search_guests para conseguirlo.' },
          rating:    { type: 'number', description: 'Valoración de 1 (mala) a 5 (excelente). Si el usuario la da sobre 10 (ej. "8/10"), pásala tal cual sin dividir, el servidor la reescala.' },
          note:      { type: 'string', description: 'Motivo breve de la valoración (opcional, se guarda como nota interna del huésped)' },
          confirmed: { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['guest_id', 'rating'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_staff_ai_activity',
      description: 'SOLO para dirección: de qué han hablado los demás miembros del equipo con este mismo asistente. Devuelve las preguntas y respuestas de otros usuarios en un rango de fechas.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha desde YYYY-MM-DD (por defecto hoy)' },
          date_to:   { type: 'string', description: 'Fecha hasta YYYY-MM-DD (por defecto hoy)' },
          user_name: { type: 'string', description: 'Filtrar por nombre de un miembro concreto del equipo (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_dashboard_background',
      description: 'Pone una foto real de un lugar como fondo de pantalla del panel del usuario actual. Úsalo cuando el usuario te diga dónde le gustaría estar (playa, ciudad, montaña, lo que sea) — no requiere confirmación, es solo estético.',
      parameters: {
        type: 'object',
        properties: {
          place: { type: 'string', description: 'Descripción breve del lugar en inglés o español (ej. "Kyoto in autumn", "tropical beach")' },
        },
        required: ['place'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clear_dashboard_background',
      description: 'Quita el fondo de pantalla del panel del usuario actual y lo deja como estaba por defecto (sin foto). No requiere confirmación.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_user_dashboard_background',
      description: 'SOLO para dirección: pone una foto de fondo en el panel de OTRO usuario del sistema (no el actual). No requiere confirmación (es solo estético) — si quien te habla ya te ha dado el nombre y el lugar en su mensaje, eso ya es la instrucción, llama al tool directamente sin preguntar nada a nadie.',
      parameters: {
        type: 'object',
        properties: {
          user_name: { type: 'string', description: 'Nombre del miembro del equipo al que ponerle el fondo' },
          place:     { type: 'string', description: 'Descripción breve del lugar (ej. "Kyoto in autumn")' },
        },
        required: ['user_name', 'place'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_staff_message',
      description: 'SOLO para dirección: envía un mensaje interno a OTRO usuario del sistema (personal del hotel), que se lo transmitirá el asistente la próxima vez que ese usuario lo abra. NUNCA uses esto para huéspedes — solo para miembros del equipo con cuenta en el sistema. No requiere confirmación previa — envíalo directamente en cuanto dirección lo pida.',
      parameters: {
        type: 'object',
        properties: {
          user_name: { type: 'string', description: 'Nombre del miembro del equipo destinatario' },
          message:   { type: 'string', description: 'Texto del mensaje a transmitir' },
          important: { type: 'boolean', description: 'true SOLO si dirección pide expresamente que sea urgente/importante/bloqueante ("dile ahora mismo", "es importante", "que no lo pueda ignorar"...) — en vez de una burbuja de chat normal, al destinatario le sale un aviso a pantalla completa ("Esto es Importante Ahora") que le bloquea 10 segundos antes de poder confirmar que lo ha leído. Por defecto false (burbuja de chat normal).' },
        },
        required: ['user_name', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'broadcast_staff_message',
      description: 'SOLO para dirección: envía un mensaje interno a TODO el personal del sistema a la vez (equivalente a llamar a send_staff_message con cada usuario activo), que cada uno recibirá la próxima vez que hable con el asistente. NUNCA para huéspedes. Úsalo cuando el usuario pida avisar "a todos", "al personal en general", "al equipo" — no cuando dé un nombre concreto (eso es send_staff_message). No requiere confirmación previa — envíalo directamente en cuanto dirección lo pida.',
      parameters: {
        type: 'object',
        properties: {
          message:   { type: 'string', description: 'Texto del mensaje a transmitir a todo el personal' },
          important: { type: 'boolean', description: 'true SOLO si dirección pide expresamente que sea urgente/importante/bloqueante — cada destinatario ve un aviso a pantalla completa ("Esto es Importante Ahora") que le bloquea 10 segundos antes de poder confirmar que lo ha leído, en vez de una burbuja de chat normal. Por defecto false.' },
        },
        required: ['message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_scheduled_task',
      description: 'SOLO para dirección: programa una tarea recurrente para el propio asistente — en cada ejecución, el asistente recibe `prompt` como si se lo hubiera escrito dirección y actúa con normalidad (puede usar cualquier tool, incluidas broadcast_staff_message/send_staff_message). Úsalo para peticiones tipo "cada X días envía/haz/genera...". La hora exacta de cada ejecución se sortea dentro de la ventana horaria indicada (por defecto 09:00–20:00, hora de Madrid) — así "a horas randomizadas" no cae siempre a la misma hora. `prompt` debe ser una instrucción autocontenida y clara, en el mismo idioma que el usuario, describiendo exactamente qué generar/hacer (ej. "Genera un chiste corto y original sobre hoteles y mándalo con broadcast_staff_message a todo el personal").',
      parameters: {
        type: 'object',
        properties: {
          prompt:            { type: 'string', description: 'Instrucción autocontenida que recibirá el asistente en cada ejecución' },
          interval_days:     { type: 'number', description: 'Cada cuántos días se ejecuta (ej. 2 = un día sí y dos no)' },
          time_window_start: { type: 'string', description: 'Inicio de la ventana horaria HH:MM (hora de Madrid), por defecto "09:00"' },
          time_window_end:   { type: 'string', description: 'Fin de la ventana horaria HH:MM (hora de Madrid), por defecto "20:00"' },
          confirmed:         { type: 'boolean', description: 'true SOLO si dirección ya confirmó explícitamente la tarea (prompt, frecuencia y ventana horaria) en su mensaje anterior' },
        },
        required: ['prompt', 'interval_days'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_scheduled_tasks',
      description: 'SOLO para dirección: lista las tareas programadas del asistente (activas e inactivas), con su frecuencia, ventana horaria, próxima ejecución y el resultado/error de la última vez que corrieron.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_scheduled_task_active',
      description: 'SOLO para dirección: activa o pausa una tarea programada (sin borrarla). Usa list_scheduled_tasks primero para obtener el task_id si el usuario no lo da.',
      parameters: {
        type: 'object',
        properties: {
          task_id:   { type: 'number', description: 'ID de la tarea (de list_scheduled_tasks)' },
          active:    { type: 'boolean', description: 'true para activarla, false para pausarla' },
          confirmed: { type: 'boolean', description: 'true SOLO si dirección ya confirmó explícitamente el cambio' },
        },
        required: ['task_id', 'active'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_scheduled_task',
      description: 'SOLO para dirección: elimina definitivamente una tarea programada. Usa list_scheduled_tasks primero para obtener el task_id si el usuario no lo da.',
      parameters: {
        type: 'object',
        properties: {
          task_id:   { type: 'number', description: 'ID de la tarea (de list_scheduled_tasks)' },
          confirmed: { type: 'boolean', description: 'true SOLO si dirección ya confirmó explícitamente que quiere eliminarla' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_reservations',
      description: 'Busca reservas por cualquier dato del huésped (nombre, email, teléfono, DNI/pasaporte), código de reserva, habitación o grupo. También filtra por estado y rango de fechas de entrada o salida. Cada resultado incluye `guests`: TODOS los ocupantes de la reserva (titular y acompañantes) con su edad y sexo — úsalo para responder preguntas como "qué edades tienen los huéspedes de la 205" sin necesidad de otra llamada.',
      parameters: {
        type: 'object',
        properties: {
          q:               { type: 'string', description: 'Texto libre: nombre, apellido, email, teléfono, DNI, código externo, código de habitación o nombre de grupo' },
          status:          { type: 'string', enum: ['confirmed','arriving','checked_in','checking_out','checked_out','cancelled','no_show','tentative'], description: 'Filtrar por estado (opcional)' },
          checkin_from:    { type: 'string', description: 'Check-in desde YYYY-MM-DD (opcional)' },
          checkin_to:      { type: 'string', description: 'Check-in hasta YYYY-MM-DD (opcional)' },
          checkout_from:   { type: 'string', description: 'Check-out desde YYYY-MM-DD (opcional)' },
          checkout_to:     { type: 'string', description: 'Check-out hasta YYYY-MM-DD (opcional)' },
          stay_date:       { type: 'string', description: 'Fecha YYYY-MM-DD: reservas que incluyen ese día en su estancia (opcional)' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_guests',
      description: 'Busca huéspedes por nombre, apellido, email, teléfono o número de documento. Devuelve sus datos (incluida edad calculada a partir de la fecha de nacimiento, y sexo) y un resumen de sus estancias. Para buscar reservas a partir de una descripción de edad/sexo de sus ocupantes (p.ej. "una pareja mayor de 70 años"), usa mejor search_reservations_by_guest_profile.',
      parameters: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Nombre, apellido, email, teléfono o número de documento' },
        },
        required: ['q'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_reservations_by_guest_profile',
      description: 'Encuentra reservas u habitaciones a partir de una descripción de las PERSONAS que las ocupan (edad y/o sexo), no del titular de la reserva sino de TODOS los huéspedes asociados a la estancia (acompañantes incluidos) — p.ej. "personas mayores de 70 años, hombre y mujer", "una pareja joven", "un niño y dos adultos". Cada elemento de `profiles` es un perfil a buscar (rango de edad y/o sexo); la reserva debe tener, para cada perfil pedido, AL MENOS UN huésped DISTINTO que lo cumpla (dos perfiles "hombre >70" y "mujer >70" exigen un hombre Y una mujer, cada uno mayor de 70, no la misma persona dos veces). La edad se calcula a fecha de hoy a partir de la fecha de nacimiento; los huéspedes sin fecha de nacimiento registrada no pueden cumplir un filtro de edad. Devuelve, por reserva, la lista completa de sus huéspedes con edad y sexo para que puedas verificar la coincidencia.',
      parameters: {
        type: 'object',
        properties: {
          profiles: {
            type: 'array',
            description: 'Perfiles de huésped a buscar, uno por persona distinta requerida en la misma reserva',
            items: {
              type: 'object',
              properties: {
                min_age: { type: 'number', description: 'Edad mínima (opcional)' },
                max_age: { type: 'number', description: 'Edad máxima (opcional)' },
                gender:  { type: 'string', enum: ['male', 'female', 'unspecified'], description: 'Sexo (opcional)' },
              },
            },
          },
          status:        { type: 'string', enum: ['confirmed','arriving','checked_in','checking_out','checked_out','cancelled','no_show','tentative'], description: 'Filtrar por estado (opcional, por defecto todas menos canceladas)' },
          stay_date:     { type: 'string', description: 'Fecha YYYY-MM-DD: reservas que incluyen ese día en su estancia (opcional, útil para "quién está hoy en el hotel")' },
          checkin_from:  { type: 'string', description: 'Check-in desde YYYY-MM-DD (opcional)' },
          checkin_to:    { type: 'string', description: 'Check-in hasta YYYY-MM-DD (opcional)' },
        },
        required: ['profiles'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reservation',
      description: 'Detalle completo de una reserva por su ID: huésped, habitación, fechas, canal, total, pendiente de pago. Incluye `guests`: TODOS los ocupantes de la reserva (titular y acompañantes, marcados con is_primary) con su edad y sexo.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID interno de la reserva' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reservation_history',
      description: 'Historial completo de una reserva: cambios de estado (quién hizo check-in, canceló, etc.), modificaciones de campos (cambios de habitación, fechas, tarifa, canal, precio, personas) con autor y timestamp, y notas manuales del equipo. Usa este tool para reconstruir la línea de tiempo completa, identificar quién hizo cada acción, detectar cambios de habitación, y buscar anomalías o errores (p.ej. cambios de habitación sin justificación, modificaciones de precio inesperadas, reversiones de estado, solapamientos).',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'number', description: 'ID de la reserva' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_arrivals',
      description: 'Lista las llegadas de un día concreto, incluyendo las que ya hicieron check-in y check-out. Devuelve checked_in_at (hora de check-in) y checked_in_by (empleado que lo realizó). Útil para días pasados: incluye todos los estados (confirmed, checked_in, checked_out, etc.).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD, por defecto hoy' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_departures',
      description: 'Lista las salidas (check-outs) de un día concreto',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD, por defecto hoy' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_in_house',
      description: 'Lista todos los huéspedes que están actualmente en el hotel (checked_in o checking_out)',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_in',
      description: 'Realiza el check-in de UNA reserva. Solo estados "confirmed" o "tentative". Requiere confirmación previa del usuario (confirmed=true solo tras confirmar). Falla si al titular o a algún huésped adicional le falta un dato obligatorio para SES (nombre, apellidos, fecha de nacimiento, documento, nº soporte para DNI/NIE…) — en ese caso di al usuario exactamente qué falta y a quién, para que lo rellene antes de reintentar.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_out',
      description: 'Realiza el check-out de UNA reserva. Solo estados "checked_in" o "checking_out". Requiere confirmación previa del usuario (confirmed=true solo tras confirmar).',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_availability',
      description: 'Consulta habitaciones disponibles entre dos fechas',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha entrada YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha salida YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_reservations',
      description: 'Cuenta o lista reservas con filtros combinados: estado, canal, habitación, huésped, rango de check-in o check-out, fecha de estancia. Para estadísticas y listados amplios.',
      parameters: {
        type: 'object',
        properties: {
          status:          { type: 'string', enum: ['confirmed','tentative','checked_in','checking_out','checked_out','cancelled','no_show'] },
          checkin_from:    { type: 'string', description: 'Check-in desde YYYY-MM-DD' },
          checkin_to:      { type: 'string', description: 'Check-in hasta YYYY-MM-DD' },
          checkout_from:   { type: 'string', description: 'Check-out desde YYYY-MM-DD' },
          checkout_to:     { type: 'string', description: 'Check-out hasta YYYY-MM-DD' },
          stay_date:       { type: 'string', description: 'Fecha YYYY-MM-DD: reservas que incluyen ese día en su estancia' },
          channel:         { type: 'string', description: 'Nombre parcial del canal (ej: "Booking", "Airbnb")' },
          room_code:       { type: 'string', description: 'Código de habitación' },
          guest_name:      { type: 'string', description: 'Nombre o apellido del huésped' },
          list:            { type: 'boolean', description: 'Si true devuelve hasta 20 reservas además del conteo' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_revenue',
      description: 'Total de dinero cobrado (transacciones reales) en un período. Desglose por forma de pago.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_revenue_forecast',
      description: 'Ingresos previstos (total de reservas confirmadas/tentativas) en un período.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_occupancy_rate',
      description: 'Tasa de ocupación del hotel en un período (% de noches ocupadas).',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin YYYY-MM-DD' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_channel_stats',
      description: 'Estadísticas de reservas e ingresos desglosadas por canal de venta en un período.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pending_payments',
      description: 'Lista reservas con saldo pendiente de pago. Excluye automáticamente las reservas de los canales configurados como "cobro al check-out" cuyo check-out todavía no ha llegado (antes de esa fecha un saldo pendiente es normal, no una reserva sin cobrar). Las de esos canales que SÍ salen aquí (check-out de hoy o ya pasado) son casos reales a seguir igual que cualquier otro canal.',
      parameters: {
        type: 'object',
        properties: {
          checkout_date: { type: 'string', description: 'Filtrar por fecha de check-out YYYY-MM-DD (opcional)' },
          min_due:       { type: 'number', description: 'Importe mínimo pendiente (por defecto 0.01)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_repeat_guests',
      description: 'Ranking de huéspedes que han reservado más de una vez.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Número de huéspedes (por defecto 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_stay_stats',
      description: 'Estadísticas de estancias: noches medias, precio medio por reserva y por noche.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_rooms',
      description: 'Devuelve todas las habitaciones con sus características físicas (baño, terraza, balcón, cama, tamaño, vista, AC, TV, tipo) y datos de su tipo (capacidad, ensuite, camas extra, descripción). Puede filtrar por una o varias características.',
      parameters: {
        type: 'object',
        properties: {
          bathroom:   { type: 'string', enum: ['shower', 'bathtub', 'both'], description: 'Tipo de baño (opcional)' },
          terrace:    { type: 'string', enum: ['private', 'shared', 'none'], description: 'Tipo de terraza (opcional)' },
          balcony:    { type: 'boolean', description: 'Con balcón (opcional)' },
          bed_size:   { type: 'string', enum: ['single', 'twin', 'double', 'queen', 'king', 'bunk'], description: 'Tamaño de cama (opcional)' },
          view:       { type: 'string', enum: ['sea', 'pool', 'interior', 'lateral', 'street'], description: 'Tipo de vista (opcional)' },
          min_sqm:    { type: 'number', description: 'Tamaño mínimo en m² (opcional)' },
          room_type_id: { type: 'number', description: 'Filtrar por tipo de habitación (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_room_stats',
      description: 'Ranking de habitaciones por número de reservas o noches ocupadas en un período.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin YYYY-MM-DD' },
          limit:     { type: 'number', description: 'Número de habitaciones (por defecto 5)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_unassigned_reservations',
      description: 'Lista reservas confirmadas o tentativas sin habitación asignada.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_price_recommendation',
      description: 'Analiza la ocupación prevista, el precio LISTADO configurado y el ADR REAL (ingresos ÷ noches ocupadas, de reservas ya hechas) de un período — con group="day" da un desglose diario con ADR de la semana ISO de cada día; con group="week" da un rollup semanal (ocupación media, precio listado medio, ADR real) pensado para comparar semana a semana y decidir en qué semanas conviene subir o bajar precio. Para estudiar por qué hubo poca ocupación en días/semanas concretos, cruza esto con get_occupancy_report (mismo ADR, otros agregados), search_local_events (eventos que expliquen picos) y get_booking_patterns (lead time, canales). El ADR real es el mismo dato que usa la regla dinámica "Parada de reservas" como suelo de precio — no recomiendes bajar de ahí sin decirlo explícitamente.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin YYYY-MM-DD' },
          rate_id:   { type: 'number', description: 'ID de la tarifa a consultar (opcional, si no se indica usa todas las tarifas activas)' },
          group:     { type: 'string', enum: ['day', 'week'], description: 'Granularidad del desglose (por defecto "day")' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc_rate_quote',
      description: 'Calcula el precio total de una estancia para una tarifa y tipo de habitación concretos, SIN relacionarlo con ninguna reserva existente — úsalo cuando el usuario pida un precio o presupuesto ("dame un precio para 20 dobles del 3 al 5 con tarifa X"). Acepta el nombre de la tarifa y del tipo de habitación tal cual los diga el usuario (no hace falta el ID) — si hay varias coincidencias o ninguna, el tool devuelve las opciones disponibles para que preguntes o elijas. Devuelve desglose de precio por noche, precio de una habitación y el total para la cantidad de habitaciones pedida. Para el precio de AMPLIAR una reserva YA EXISTENTE usa calc_extension_price, no este.',
      parameters: {
        type: 'object',
        properties: {
          rate_id:        { type: 'number', description: 'ID de la tarifa (alternativa a rate_name si ya se conoce)' },
          rate_name:      { type: 'string', description: 'Nombre o parte del nombre de la tarifa tal como lo dice el usuario (ej. "directa", "no reembolsable")' },
          room_type_id:   { type: 'number', description: 'ID del tipo de habitación (alternativa a room_type_name si ya se conoce)' },
          room_type_name: { type: 'string', description: 'Nombre o parte del nombre del tipo de habitación tal como lo dice el usuario, en singular o plural (ej. "doble", "dobles", "individual")' },
          check_in:       { type: 'string', description: 'Fecha de entrada YYYY-MM-DD' },
          check_out:      { type: 'string', description: 'Fecha de salida YYYY-MM-DD (noche de salida, no se cobra)' },
          quantity:       { type: 'number', description: 'Número de habitaciones de ese tipo (por defecto 1)' },
        },
        required: ['check_in', 'check_out'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_booking_patterns',
      description: 'Patrones de comportamiento de las reservas dentro de UN rango: días de la semana más reservados, meses más activos, lead time medio (días entre reserva y llegada), duraciones de estancia más frecuentes y canales con mayor volumen. Si no fijas date_from, SOLO mira los últimos 365 días — para pedir un año concreto (ej. 2024) fija date_from="2024-01-01" y date_to="2024-12-31" explícitamente, si no devuelve datos vacíos sin avisar. Para comparar varios períodos con nombre entre sí (años, meses concretos), usa get_period_summary una vez por período en su lugar.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD (opcional, por defecto últimos 365 días — fíjala siempre si preguntan por un año o período concreto)' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_channel_comparison',
      description: 'Comparativa detallada de canales: cuota de mercado (% reservas y % ingresos por canal), precio medio por reserva, noches medias y tasa de cancelación por canal.',
      parameters: {
        type: 'object',
        properties: {
          date_from: { type: 'string', description: 'Fecha inicio check-in YYYY-MM-DD' },
          date_to:   { type: 'string', description: 'Fecha fin check-in YYYY-MM-DD' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_room',
      description: 'Asigna una habitación a una reserva (tentative/confirmed/arriving). Verifica disponibilidad antes de asignar. Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          room_code:      { type: 'string', description: 'Código de la habitación (ej: "101", "A2")' },
          reason:         { type: 'string', description: 'Motivo del cambio, mínimo 5 palabras — OBLIGATORIO si la reserva ya está en casa (checked_in) o la habitación destino es de un tipo virtual, sea cual sea el estado. Sin esas condiciones, opcional.' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id', 'room_code'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc_extension_price',
      description: 'Calcula el coste de ampliar una reserva: indica extra_nights o new_checkout y la tarifa. Devuelve desglose de precios por noche y total extra. Úsala ANTES de extend_stay para mostrar el precio al usuario.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          extra_nights:   { type: 'number', description: 'Noches adicionales a añadir (alternativa a new_checkout)' },
          new_checkout:   { type: 'string', description: 'Nueva fecha de check-out YYYY-MM-DD (alternativa a extra_nights)' },
          rate_id:        { type: 'number', description: 'ID de la tarifa a aplicar (si no se indica, usa la tarifa actual de la reserva)' },
        },
        required: ['reservation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'extend_stay',
      description: 'Cambia la fecha de check-out de una reserva y actualiza el total. Verifica disponibilidad. Requiere confirmación previa del usuario — usa calc_extension_price antes para obtener el precio.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          new_checkout:   { type: 'string', description: 'Nueva fecha de check-out YYYY-MM-DD' },
          extra_cost:     { type: 'number', description: 'Coste adicional en euros a sumar al total actual (obtenido de calc_extension_price)' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id', 'new_checkout'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_reservation',
      description: 'Modifica datos de una reserva: fechas de entrada/salida, número de personas o precio total. Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          reservation_id: { type: 'number', description: 'ID de la reserva' },
          check_in:       { type: 'string', description: 'Nueva fecha de check-in YYYY-MM-DD (opcional)' },
          check_out:      { type: 'string', description: 'Nueva fecha de check-out YYYY-MM-DD (opcional)' },
          people:         { type: 'number', description: 'Nuevo número de personas (opcional)' },
          total:          { type: 'number', description: 'Nuevo precio total en euros (opcional)' },
          confirmed:      { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['reservation_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_no_shows',
      description: 'Lista reservas marcadas como no_show o reservas que tenían check-in en una fecha y siguen en estado confirmed/arriving sin actualizarse (posibles no-shows sin marcar).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha de check-in YYYY-MM-DD (por defecto ayer)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_guest_history',
      description: 'Historial completo de estancias de un huésped: todas sus reservas, importes, habitaciones, canal y notas internas. Úsalo cuando el usuario quiera saber todo sobre un huésped concreto.',
      parameters: {
        type: 'object',
        properties: {
          guest_id: { type: 'number', description: 'ID del huésped (usa search_guests para obtenerlo si no lo tienes)' },
        },
        required: ['guest_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_guest',
      description: 'Actualiza los datos de contacto de un huésped: email, teléfono o número de documento. Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          guest_id:      { type: 'number', description: 'ID del huésped (de search_guests)' },
          email:         { type: 'string', description: 'Nuevo email (opcional)' },
          phone:         { type: 'string', description: 'Nuevo teléfono (opcional)' },
          id_doc_number: { type: 'string', description: 'Número de documento DNI/pasaporte (opcional)' },
          confirmed:     { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['guest_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_housekeeping_task',
      description: 'Reasigna una tarea de limpieza existente a otro empleado. Usa get_housekeeping_status para obtener el task_id. Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          task_id:   { type: 'number', description: 'ID de la tarea (de get_housekeeping_status)' },
          user_name: { type: 'string', description: 'Nombre del empleado de limpieza al que asignar la tarea' },
          confirmed: { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['task_id', 'user_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_housekeeping_task',
      description: 'Crea una tarea de limpieza o mantenimiento extra para una habitación concreta. Requiere confirmación previa del usuario.',
      parameters: {
        type: 'object',
        properties: {
          room_code: { type: 'string', description: 'Código de la habitación' },
          task_type: { type: 'string', enum: ['cleaning', 'departure', 'maintenance', 'inspection'], description: 'Tipo de tarea' },
          date:      { type: 'string', description: 'Fecha YYYY-MM-DD (por defecto hoy)' },
          notes:     { type: 'string', description: 'Instrucciones o descripción (opcional)' },
          user_name: { type: 'string', description: 'Nombre del empleado al que asignar (opcional)' },
          confirmed: { type: 'boolean', description: 'true SOLO si el usuario ya confirmó explícitamente' },
        },
        required: ['room_code', 'task_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_invoice',
      description: 'Detalle de una factura concreta por su ID interno o número de factura (ej: "FAC-2024-001").',
      parameters: {
        type: 'object',
        properties: {
          id:             { type: 'number', description: 'ID interno de la factura (opcional)' },
          invoice_number: { type: 'string', description: 'Número de factura (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_invoice_anomalies',
      description: 'Auditoría de facturas (solo dirección): números de factura duplicados, huecos en la numeración y facturas emitidas por 0 €. Úsalo SIEMPRE que el usuario pida revisar/auditar facturas o buscar duplicados/números que faltan/facturas a 0€ — da igual que mencione un período o no, esta es la única tool correcta para eso (get_invoices es solo un listado simple limitado a 50 filas, NUNCA la uses para auditar, con un período de más de 50 facturas te dejaría fuera la mayoría sin avisar). from/to son opcionales y acotan qué se reporta en duplicados y facturas a 0€ (por fecha de emisión) — pero examina TODAS las facturas de la BD para calcular eso, no solo las del período. Los huecos de numeración siempre se calculan sobre el histórico completo (es la única forma correcta, un hueco no depende de qué período mires), cada uno indica in_requested_period si diste from/to para que sepas cuáles caen dentro.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Fecha de emisión desde, YYYY-MM-DD (opcional)' },
          to:   { type: 'string', description: 'Fecha de emisión hasta, YYYY-MM-DD (opcional)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_laundry_status',
      description: 'Estado de la lavandería de un día: entregas de ropa pendientes de procesar y entregas ya procesadas con el desglose de prendas por estado (listas, tendidas, en agua, sucias).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD (por defecto hoy)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_abandoned_carts',
      description: 'Lista de carritos abandonados del motor de reservas online: reservas web tentative sin pagar que se detectaron como abandonadas. Incluye importe, descuento ofrecido, si se envió email/WhatsApp de recuperación, y si ya se convirtieron en reserva pagada. Útil para analizar la estrategia de recuperación, ver cuántos carritos se recuperaron y cuáles siguen pendientes.',
      parameters: {
        type: 'object',
        properties: {
          limit:     { type: 'number', description: 'Máximo de resultados (por defecto 30)' },
          recovered: { type: 'boolean', description: 'true = solo recuperados, false = solo no recuperados, omitir = todos' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_local_events',
      description: 'Busca eventos locales cerca del hotel (conciertos, festivales, ferias, competiciones deportivas, etc.) usando Google Events vía SerpAPI. Los resultados se cachean durante el día para no consumir cuota. Devuelve los eventos con título, fecha, lugar y nivel de impacto estimado (high/medium/low). Úsalo cuando el usuario pregunte por eventos cercanos, picos de demanda esperados, o cuándo sería buena idea subir precio.',
      parameters: {
        type: 'object',
        properties: {
          impact_filter: {
            type:        'string',
            enum:        ['all', 'high', 'medium', 'high_medium'],
            description: 'Filtra por nivel de impacto. "high_medium" devuelve solo los que pueden generar demanda real. Por defecto "all".',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_breakfast_inventory',
      description: 'SOLO para dirección: inventario de productos de desayuno de una fecha (categoría, producto, cantidad y quién lo registró), del sistema de mantenimiento/piscina. Las cantidades vienen en la unidad en que se registran en el formulario (cajas, paquetes, unidades...) — para saber a cuánto peso/volumen real equivale cada una, combínalo con get_breakfast_inventory_catalog. Si el usuario no da una fecha concreta, NO se la pidas: omite el parámetro date y el tool te dará directamente el inventario más reciente disponible (fecha_disponibles[0]). Cada item ya trae diff y gasto respecto al inventario anterior (fecha_anterior) — úsalos directamente para "qué se ha consumido/gastado" en vez de pedir dos fechas y restar tú: diff es cantidad_actual − cantidad_anterior (negativo = bajó), gasto es lo consumido de verdad (positivo solo si bajó; 0 si se mantuvo o subió —repuesto—; null si no hay inventario anterior comparable de ese producto).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Fecha YYYY-MM-DD. Omítelo para usar la fecha con inventario más reciente (comportamiento por defecto, úsalo siempre que el usuario no pida una fecha concreta).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_breakfast_inventory_catalog',
      description: 'SOLO para dirección: catálogo de productos de desayuno por categoría. Cada producto trae: unidad en la que se registra, medida_directa (true si esa unidad ya es "kg" o "L" — la cantidad del inventario YA es el peso/volumen real, no hace falta traducir nada) y referencia (peso/volumen real de una unidad de compra, p.ej. "1 paquete de Chorizo = 200 g", solo para unidades ambiguas como paquetes/cajas/unidades — para esos productos, referencia=null significa que de verdad no se conoce el dato; para los de medida_directa=true, referencia siempre es null porque no aplica, no es que falte). Úsalo junto con get_breakfast_inventory para traducir el recuento a peso/volumen real y calcular necesidades o comparar consumo.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_room_incidents',
      description: 'SOLO para dirección: incidencias de mantenimiento reportadas en habitaciones (averías, desperfectos...), del sistema de mantenimiento/piscina. Incluye prioridad, estado y fecha.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'resolved', 'all'], description: 'pending = solo pendientes (por defecto), resolved = solo resueltas, all = ambas' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pool_supplies_level',
      description: 'SOLO para dirección: nivel estimado y consumo diario de garrafas de gas o cloro de la piscina, del sistema de mantenimiento/piscina. Incluye días restantes estimados hasta agotarse.',
      parameters: {
        type: 'object',
        properties: {
          product: { type: 'string', enum: ['gas', 'cloro'], description: 'Qué garrafa consultar' },
        },
        required: ['product'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pool_water_readings',
      description: 'SOLO para dirección: registros de mediciones de la piscina (cloro/pH) o de agua corriente (AFC = agua fría de consumo, ACS = agua caliente sanitaria, control de legionela), del sistema de mantenimiento/piscina. Devuelve las lecturas más recientes primero.',
      parameters: {
        type: 'object',
        properties: {
          type:  { type: 'string', enum: ['piscina', 'afc', 'acs'], description: 'piscina = cloro/pH de la piscina, afc = agua fría de consumo, acs = agua caliente sanitaria' },
          limit: { type: 'number', description: 'Máximo de lecturas a devolver, las más recientes (por defecto 20)' },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_water_tank_status',
      description: 'SOLO para dirección: nivel y consumo del aljibe/tanque de agua del hotel, del sistema de mantenimiento/piscina. Incluye litros actuales, consumo medio por hora y evolución del nivel en el rango pedido.',
      parameters: {
        type: 'object',
        properties: {
          range: { type: 'string', enum: ['dia', 'semana', 'mes'], description: 'Rango del histórico (por defecto semana)' },
          year:  { type: 'number', description: 'Año, solo si range=mes (por defecto el actual)' },
          month: { type: 'number', description: 'Mes 1-12, solo si range=mes (por defecto el actual)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_alert_configs',
      description: 'Devuelve la lista de tipos de alerta del sistema con su estado activado/desactivado. Solo para dirección.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_alert_enabled',
      description: 'Activa o desactiva un tipo de alerta del sistema. Solo para dirección. Confirmar antes de ejecutar.',
      parameters: {
        type: 'object',
        properties: {
          alert_type: { type: 'string', description: 'Identificador del tipo de alerta (ver get_alert_configs)' },
          enabled:    { type: 'boolean', description: 'true para activar, false para desactivar' },
          confirmed:  { type: 'boolean', description: 'true cuando el usuario ha confirmado la acción' },
        },
        required: ['alert_type', 'enabled', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_new_bookings',
      description: 'Reservas HECHAS (creadas) en un rango de fechas — filtra por fecha de RESERVA (bookedAt), no por fecha de entrada/salida. Úsala para "reservas nuevas de hoy/ayer/esta semana", "cuántas reservas han entrado hoy", "qué se ha reservado hoy" — NO uses get_today_summary ni get_period_summary para esto, esas filtran por check-in/check-out, no por cuándo se hizo la reserva.',
      parameters: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'Fecha de reserva desde (YYYY-MM-DD). Por defecto hoy.' },
          to:   { type: 'string', description: 'Fecha de reserva hasta, incluida (YYYY-MM-DD). Por defecto igual a from.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_online_users',
      description: 'Lista de usuarios del equipo conectados ahora mismo (presencia en tiempo real, últimos 90s de actividad).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_staff_list',
      description: 'Lista de todos los usuarios del sistema (nombre, email, roles, si están activos) — para "quiénes tienen acceso", "qué roles tiene fulano", "lista de empleados". No incluye contraseñas ni sueldo.',
      parameters: {
        type: 'object',
        properties: {
          only_active: { type: 'boolean', description: 'Si true, excluye usuarios desactivados. Por defecto true.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_sale_price',
      description: 'Cambia el precio de venta de la tarifa raíz del hotel para su tipo de habitación por defecto, en una fecha o un rango de fechas. Solo para dirección/admin. Cuando el usuario diga que quiere "cambiar el precio" sin más detalle, se refiere SIEMPRE a esto (tarifa raíz, tipo por defecto) — no preguntes qué tarifa o qué tipo de habitación. Requiere confirmación previa (confirmed=true solo tras confirmar), indicando fecha(s) y precio nuevo antes de ejecutar.',
      parameters: {
        type: 'object',
        properties: {
          date:      { type: 'string', description: 'Fecha única (YYYY-MM-DD). Usa esto o date_from/date_to, no ambos.' },
          date_from: { type: 'string', description: 'Inicio del rango de fechas (YYYY-MM-DD), si se cambia el precio de varios días a la vez' },
          date_to:   { type: 'string', description: 'Fin del rango de fechas (YYYY-MM-DD), incluido' },
          price:     { type: 'number', description: 'Precio de venta nuevo, en euros' },
          confirmed: { type: 'boolean', description: 'true SOLO si dirección ya confirmó explícitamente la fecha/rango y el precio' },
        },
        required: ['price', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_access_door',
      description: 'Abre una de las puertas del control de accesos del hotel (ZKTeco C3-400, vista Accesos), la misma acción que los botones "Puerta 1"-"Puerta 4" de esa pantalla. Solo para dirección/admin. Requiere confirmación previa (confirmed=true solo tras confirmar) — es una acción física real sobre el edificio.',
      parameters: {
        type: 'object',
        properties: {
          door:      { type: 'number', description: 'Número de puerta (1 a 4, ver vista Accesos para saber cuál es cuál)' },
          confirmed: { type: 'boolean', description: 'true SOLO si dirección ya confirmó explícitamente qué puerta abrir' },
        },
        required: ['door', 'confirmed'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'navigate',
      description: 'Navega a una pantalla de la aplicación',
      parameters: {
        type: 'object',
        properties: {
          view: { type: 'string', enum: ['dashboard','planning','arrivals','departures','billing','reservations','guests','rooms'], description: 'Vista a mostrar' },
          id:   { type: 'number', description: 'ID del recurso si aplica' },
        },
        required: ['view'],
      },
    },
  },
]

// Tools de módulos opcionales: solo se ofrecen al modelo (y solo se ejecutan) si
// el tenant tiene el módulo activo (hasFeature).
const TOOL_FEATURE: Record<string, FeatureKey> = {
  get_competitor_comparison: 'competitors',
  get_pricing_effects:       'pricingRules',
  get_pricing_rules_status:  'pricingRules',
  get_price_recommendation:  'pricingRules',
  set_sale_price:            'pricingRules',
  search_local_events:       'events',
  get_breakfast_inventory:         'pool',
  get_breakfast_inventory_catalog: 'pool',
  get_room_incidents:              'pool',
  get_pool_supplies_level:         'pool',
  get_pool_water_readings:         'pool',
  get_water_tank_status:           'pool',
  open_access_door:          'zkteco',
  get_laundry_status:        'laundry',
  get_abandoned_carts:       'bookingEngine',
}

// Tools disponibles para el tenant actual — formato OpenAI (Ollama/RunPod) y
// Claude (name + input_schema, con cache_control en el último tool para que
// todo el prefijo se cachee). Ninguna tool acepta propertyId del modelo.
async function toolsForTenant(): Promise<{ openai: typeof TOOLS; claude: Anthropic.Tool[] }> {
  const prop = await getProperty()
  const openai = TOOLS.filter(t => {
    const f = TOOL_FEATURE[t.function.name]
    return !f || featureOf(prop, f)
  })
  const claude: Anthropic.Tool[] = openai.map((t, i) => ({
    name:         t.function.name,
    description:  t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool['input_schema'],
    ...(i === openai.length - 1 && { cache_control: { type: 'ephemeral' as const } }),
  }))
  return { openai, claude }
}

// ── Ejecutores de tools ───────────────────────────────────────────────────────

// Tools de escritura: roles permitidos (validado en servidor, NO se confía en el modelo).
// Todas operan sobre UNA entidad — el diseño impide operaciones masivas.
const WRITE_TOOL_ROLES: Record<string, string[]> = {
  check_in:                 ['direccion', 'recepcion'],
  check_out:                ['direccion', 'recepcion'],
  cancel_reservation:       ['direccion', 'recepcion'],
  create_reservation:       ['direccion', 'recepcion'],
  add_payment:              ['direccion', 'recepcion'],
  add_reservation_note:     ['direccion', 'recepcion', 'conserje'],
  set_housekeeping_done:    ['direccion', 'recepcion', 'limpieza'],
  update_guest_rating:      ['direccion', 'recepcion'],
  adjust_engagement_rating: ['direccion'],
  send_staff_message:       ['direccion'],
  broadcast_staff_message:  ['direccion'],
  create_scheduled_task:    ['direccion'],
  set_scheduled_task_active: ['direccion'],
  delete_scheduled_task:    ['direccion'],
  assign_room:              ['direccion', 'recepcion'],
  calc_extension_price:     ['direccion', 'recepcion'],
  extend_stay:              ['direccion', 'recepcion'],
  update_reservation:       ['direccion', 'recepcion'],
  update_guest:             ['direccion', 'recepcion'],
  assign_housekeeping_task: ['direccion', 'recepcion'],
  create_housekeeping_task: ['direccion', 'recepcion', 'limpieza'],
  set_alert_enabled:        ['direccion'],
  set_sale_price:           ['direccion'],
  open_access_door:         ['direccion'],
}

// Tools de escritura que NO piden confirmación aunque estén en
// WRITE_TOOL_ROLES — el rol ya es la única puerta que hace falta. Los
// mensajes internos son de bajo riesgo (solo texto a otro miembro del
// equipo, nunca a un huésped) y dirección pidió explícitamente poder
// mandarlos sin el paso previo de "¿confirmas?".
const NO_CONFIRMATION_NEEDED = new Set(['send_staff_message', 'broadcast_staff_message'])

// Importes totales de facturación: solo para dirección/admin
function isRevenueBlocked(ctx: AiUserCtx, _from?: string, _to?: string): boolean {
  return !ctx.roles.includes('direccion')
}
const REVENUE_BLOCKED_MSG = 'Los importes totales de facturación son exclusivos del rol de dirección.'

// Resuelve un nombre de pila/apellido a un usuario del SISTEMA (personal del
// hotel) — nunca busca en `guests`. Usado por los tools de dirección que
// actúan sobre otro miembro del equipo.
async function findStaffUserByName(name: string) {
  // Soporta nombre completo ("Alisa Panfilova"): cada palabra debe aparecer en
  // el nombre o el apellido, no todo el texto junto contra un solo campo.
  const tokens = name.trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return undefined
  return db.query.users.findFirst({
    where: and(eq(users.propertyId, getPropertyId()), and(...tokens.map(t => or(ilike(users.firstName, `%${t}%`), ilike(users.lastName, `%${t}%`))))),
    columns: { id: true, firstName: true, lastName: true },
  })
}

// ── Programación de tareas del asistente (horas randomizadas dentro de ventana) ─

// Edad actual a partir de la fecha de nacimiento — misma convención que
// GET /api/guests/stats (EXTRACT(YEAR FROM AGE(date_of_birth))), calculada
// aquí en JS porque ya tenemos la fila del huésped cargada.
function ageFromDob(dob: string | null | undefined): number | null {
  if (!dob) return null
  const d = new Date(dob)
  if (isNaN(d.getTime())) return null
  const today = new Date()
  let age = today.getFullYear() - d.getFullYear()
  const monthDiff = today.getMonth() - d.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < d.getDate())) age--
  return age
}

function parseHHMM(s: string): number {
  const [h, m] = s.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

function randomMinuteInWindow(start: string, end: string): number {
  const startMin = parseHHMM(start)
  const span     = Math.max(1, parseHHMM(end) - startMin)
  return startMin + Math.floor(Math.random() * (span + 1))
}

// Offset (ms) de una zona horaria IANA en un instante dado.
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value)
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(at.getTime() / 1000) * 1000
}

// Instante UTC que corresponde a `day` (YYYY-MM-DD) + `minuteOfDay` en la zona tz.
function zonedToUtc(day: string, minuteOfDay: number, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  const guess = Date.UTC(y!, m! - 1, d!, Math.floor(minuteOfDay / 60), minuteOfDay % 60)
  let t = guess - tzOffsetMs(new Date(guess), tz)
  t = guess - tzOffsetMs(new Date(t), tz)
  return new Date(t)
}

function addDaysIso(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// Próxima ejecución: intervalDays días desde `anchor` (hoy al crear la tarea,
// o el día de la ejecución que se acaba de completar), a una hora aleatoria
// dentro de start–end, en la zona horaria del hotel (tz). Si el instante
// sorteado para el día de `anchor` ya ha pasado (creando la tarea tarde, o
// justo tras ejecutarla), salta directo a anchor + intervalDays — así nunca se
// dispara "ya caducada" ni se repite el mismo día dos veces.
function scheduleNextRun(anchor: Date, intervalDays: number, start: string, end: string, tz: string): Date {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(anchor)
  let candidate = zonedToUtc(day, randomMinuteInWindow(start, end), tz)
  if (candidate.getTime() <= Date.now()) {
    candidate = zonedToUtc(addDaysIso(day, intervalDays), randomMinuteInWindow(start, end), tz)
  }
  return candidate
}

async function executeTool(name: string, args: Record<string, any>, ctx: AiUserCtx = { roles: [] }): Promise<any> {
  // Fecha "hoy" y zona horaria del tenant (no UTC ni Madrid fijo)
  const tz = (await getProperty()).timezone
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())

  // Módulo opcional apagado para este tenant → la tool no existe para él
  const needFeature = TOOL_FEATURE[name]
  if (needFeature && !(await hasFeature(needFeature))) {
    return { error: `El módulo "${needFeature}" no está activado en este hotel.` }
  }

  // Gate de escritura: rol + confirmación explícita
  const allowedRoles = WRITE_TOOL_ROLES[name]
  if (allowedRoles) {
    if (!ctx.roles.some(r => allowedRoles.includes(r))) {
      return { error: `Permiso denegado: la acción ${name} requiere rol ${allowedRoles.join(' o ')}. El usuario actual no lo tiene.` }
    }
    if (args.confirmed !== true && !NO_CONFIRMATION_NEEDED.has(name)) {
      return {
        needs_confirmation: true,
        message: 'Acción NO ejecutada. Describe al usuario exactamente qué se va a hacer y pide su confirmación. Solo si responde afirmativamente, vuelve a llamar con confirmed=true.',
      }
    }
  }

  switch (name) {

    case 'get_today_summary': {
      const firstOfMonth = today.slice(0, 8) + '01'
      const isDir        = ctx.roles.includes('direccion')

      const [arr, dep, inHouse, checkingOut, pendingStepsRows, todayTxs, monthRes] = await Promise.all([
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), and(eq(reservations.checkInDate, today),
                     or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative'))))),
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), and(eq(reservations.checkOutDate, today),
                     or(eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out'))))),
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'checked_in'))),
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.status, 'checking_out'))),
        // Check-ins de hoy y ayer con pasos pendientes (>10 min desde check-in)
        db.execute(drizzleSql`
          SELECT r.id, g.first_name || ' ' || g.last_name AS guest, ro.code AS room,
                 r.checkin_had_contract, r.checkin_zkteco_enrolled, r.checkin_ses_sent
          FROM reservations r
          LEFT JOIN guests g ON g.id = r.guest_id
          LEFT JOIN rooms ro ON ro.id = r.room_id
          WHERE r.property_id = ${getPropertyId()}
            AND r.check_in_date >= (${today}::date - INTERVAL '1 day')
            AND r.status IN ('checked_in','checking_out','checked_out')
            AND r.checked_in_at IS NOT NULL
            AND r.checked_in_at < NOW() - INTERVAL '10 minutes'
            AND (r.checkin_had_contract = false OR r.checkin_zkteco_enrolled = false OR r.checkin_ses_sent = false)
          ORDER BY r.checked_in_at
        `) as unknown as Promise<{ id: number; guest: string; room: string; checkin_had_contract: boolean | null; checkin_zkteco_enrolled: boolean | null; checkin_ses_sent: boolean | null }[]>,
        // Pagos cobrados hoy (solo para dirección)
        isDir
          ? db.query.financialTransactions.findMany({
              where: and(eq(financialTransactions.propertyId, getPropertyId()), and(
                eq(financialTransactions.transactionDate, today),
                notInArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
                drizzleSql`${financialTransactions.category} IS DISTINCT FROM 'movimiento_caja'`,
              )),
              with: { financialAccount: { columns: { name: true } } },
            })
          : Promise.resolve([]),
        // Reservas del mes corriente (para facturación + pendientes, solo dirección)
        isDir
          ? db.query.reservations.findMany({
              where: and(eq(reservations.propertyId, getPropertyId()), and(
                gte(reservations.checkInDate, firstOfMonth),
                lte(reservations.checkInDate, today),
                notInArray(reservations.status, ['cancelled']),
              )),
              columns: { id: true, total: true, amountPaid: true, checkInDate: true, checkOutDate: true, status: true },
              with: {
                guest: { columns: { firstName: true, lastName: true } },
                room:  { columns: { code: true } },
              },
            })
          : Promise.resolve([]),
      ])

      const checkins_with_pending_steps = (pendingStepsRows as any[]).map(r => ({
        reservation_id: r.id,
        guest:          (r.guest ?? '').trim() || '(sin nombre)',
        room:           r.room ?? '(sin habitación)',
        missing: [
          r.checkin_had_contract    === false && 'contrato sin firmar',
          r.checkin_zkteco_enrolled === false && 'tarjeta ZKTeco no enrollada',
          r.checkin_ses_sent        === false && 'SES hospedajes no enviado',
        ].filter(Boolean),
      }))

      // Estadísticas de tiempo de check-in + pasos omitidos por empleado (últimos 90 días)
      const [checkinStatsRows, checkinSkipRows] = await Promise.all([
        db.execute(drizzleSql`
          SELECT
            u.id AS employee_id,
            u.first_name || ' ' || u.last_name AS employee,
            COUNT(*)::int AS total,
            ROUND(AVG(EXTRACT(EPOCH FROM (r.checked_in_at - r.checkin_started_at))))::int AS avg_seconds,
            MODE() WITHIN GROUP (
              ORDER BY FLOOR(EXTRACT(EPOCH FROM (r.checked_in_at - r.checkin_started_at)) / 60)::int
            )::int AS mode_minute_bucket
          FROM reservations r
          JOIN users u ON u.id = r.checked_in_by
          WHERE r.property_id = ${getPropertyId()}
            AND r.checkin_started_at IS NOT NULL
            AND r.checked_in_at IS NOT NULL
            AND EXTRACT(EPOCH FROM (r.checked_in_at - r.checkin_started_at)) BETWEEN 10 AND 2400
            AND r.checked_in_at >= NOW() - INTERVAL '2 days'
          GROUP BY u.id, u.first_name, u.last_name
          ORDER BY avg_seconds
        `) as unknown as Promise<{ employee_id: number; employee: string; total: number; avg_seconds: number; mode_minute_bucket: number }[]>,
        db.execute(drizzleSql`
          SELECT
            u.id AS employee_id,
            u.first_name || ' ' || u.last_name AS employee,
            COUNT(*)::int AS total_checkins,
            SUM(CASE WHEN r.checkin_had_contract    = false THEN 1 ELSE 0 END)::int AS skip_contract,
            SUM(CASE WHEN r.checkin_zkteco_enrolled = false THEN 1 ELSE 0 END)::int AS skip_zkteco,
            SUM(CASE WHEN r.checkin_ses_sent        = false THEN 1 ELSE 0 END)::int AS skip_ses
          FROM reservations r
          JOIN users u ON u.id = r.checked_in_by
          WHERE r.property_id = ${getPropertyId()}
            AND r.checked_in_at >= NOW() - INTERVAL '2 days'
            AND (r.checkin_had_contract = false OR r.checkin_zkteco_enrolled = false OR r.checkin_ses_sent = false)
          GROUP BY u.id, u.first_name, u.last_name
          HAVING COUNT(*) > 0
          ORDER BY (SUM(CASE WHEN r.checkin_had_contract = false THEN 1 ELSE 0 END) +
                    SUM(CASE WHEN r.checkin_zkteco_enrolled = false THEN 1 ELSE 0 END) +
                    SUM(CASE WHEN r.checkin_ses_sent = false THEN 1 ELSE 0 END)) DESC
        `) as unknown as Promise<{ employee_id: number; employee: string; total_checkins: number; skip_contract: number; skip_zkteco: number; skip_ses: number }[]>,
      ])

      // Merge timing + skip stats por empleado
      const skipByEmpId = new Map((checkinSkipRows as any[]).map(r => [String(r.employee_id), r]))
      const timingEmpIds = new Set((checkinStatsRows as any[]).map(r => String(r.employee_id)))

      const checkin_time_by_employee = [
        ...(checkinStatsRows as any[]).map(r => {
          const s = skipByEmpId.get(String(r.employee_id))
          return {
            employee:          r.employee?.trim(),
            total_checkins:    Number(r.total),
            avg_seconds:       Number(r.avg_seconds),
            most_common_range: `${r.mode_minute_bucket}–${Number(r.mode_minute_bucket) + 1} min`,
            skip_contract:     s ? Number(s.skip_contract) : 0,
            skip_zkteco:       s ? Number(s.skip_zkteco) : 0,
            skip_ses:          s ? Number(s.skip_ses) : 0,
          }
        }),
        // Empleados con fallos pero sin tiempos válidos (todos sus check-ins son outliers)
        ...(checkinSkipRows as any[])
          .filter(r => !timingEmpIds.has(String(r.employee_id)))
          .map(r => ({
            employee:          r.employee?.trim(),
            total_checkins:    Number(r.total_checkins),
            avg_seconds:       null,
            most_common_range: null,
            skip_contract:     Number(r.skip_contract),
            skip_zkteco:       Number(r.skip_zkteco),
            skip_ses:          Number(r.skip_ses),
          })),
      ]

      // ── Datos financieros (solo dirección) ────────────────────────────────────
      let finances: any = null
      if (isDir) {
        // Pagos de hoy por método y caja
        const byMethod:  Record<string, { count: number; total: number }> = {}
        const byAccount: Record<string, { count: number; total: number }> = {}
        let todayTotal = 0
        for (const t of todayTxs as any[]) {
          const amt = parseFloat(t.amount)
          todayTotal += amt
          const m = t.paymentMethod
          byMethod[m] ??= { count: 0, total: 0 }
          byMethod[m].count++; byMethod[m].total += amt
          const a = t.financialAccount?.name ?? 'Sin cuenta'
          byAccount[a] ??= { count: 0, total: 0 }
          byAccount[a].count++; byAccount[a].total += amt
        }

        // Facturación del mes + reservas pendientes de cobro — no cuenta los
        // depósitos retenidos sin cobrar como pago de la estancia (ver
        // src/lib/paymentAggregate.ts).
        let monthRevenue = 0, monthPaid = 0
        const pendingList: any[] = []
        const monthRealPaidById = await realPaidByReservation((monthRes as any[]).map(r => r.id))
        for (const r of monthRes as any[]) {
          const total = parseFloat(r.total ?? '0')
          const paid  = monthRealPaidById.get(r.id) ?? 0
          monthRevenue += total
          monthPaid    += paid
          const due = calcPendingBalance(r.total, paid)
          if (due > 0.01) {
            const g = r.guest as any
            pendingList.push({
              id:       r.id,
              guest:    `${g?.firstName ?? ''} ${g?.lastName ?? ''}`.trim() || '(sin nombre)',
              room:     (r.room as any)?.code ?? '?',
              check_in: r.checkInDate,
              total,
              paid,
              due: +due.toFixed(2),
            })
          }
        }
        pendingList.sort((a, b) => b.due - a.due)

        const METHOD_LABEL: Record<string, string> = {
          cash: 'Efectivo', credit_card: 'Tarjeta', bank_transfer: 'Transferencia',
          stripe: 'Stripe', booking_virtual_card: 'Virtual Booking',
          jumbo_credit: 'Jumbo crédito', other: 'Otro',
        }
        const byMethodLabeled: Record<string, { count: number; total: number }> = {}
        for (const [k, v] of Object.entries(byMethod))
          byMethodLabeled[METHOD_LABEL[k] ?? k] = v

        finances = {
          today_collected: {
            total:             +todayTotal.toFixed(2),
            transaction_count: (todayTxs as any[]).length,
            by_method:         byMethodLabeled,
            by_account:        byAccount,
          },
          month_billing: {
            period:            { from: firstOfMonth, to: today },
            total_revenue:     +monthRevenue.toFixed(2),
            total_paid:        +monthPaid.toFixed(2),
            total_due:         +(monthRevenue - monthPaid).toFixed(2),
            reservation_count: (monthRes as any[]).length,
          },
          pending_reservations: pendingList,
        }
      }

      return {
        date: today,
        arrivals_pending:           Number(arr[0]?.count ?? 0),
        departures_pending:         Number(dep[0]?.count ?? 0),
        in_house:                   Number(inHouse[0]?.count ?? 0),
        checking_out:               Number(checkingOut[0]?.count ?? 0),
        checkins_with_pending_steps,
        checkin_time_by_employee,
        finances,
      }
    }

    case 'search_reservations': {
      const { q, status, checkin_from, checkin_to, checkout_from, checkout_to, stay_date } = args

      const dateConditions: any[] = []
      if (checkin_from)  dateConditions.push(gte(reservations.checkInDate, checkin_from))
      if (checkin_to)    dateConditions.push(lte(reservations.checkInDate, checkin_to))
      if (checkout_from) dateConditions.push(gte(reservations.checkOutDate, checkout_from))
      if (checkout_to)   dateConditions.push(lte(reservations.checkOutDate, checkout_to))
      if (stay_date) {
        dateConditions.push(lte(reservations.checkInDate, stay_date))
        dateConditions.push(gte(reservations.checkOutDate, stay_date))
      }
      const statusCond = status ? eq(reservations.status, status) : undefined

      const seen  = new Set<number>()
      const combined: any[] = []

      const addResults = (rows: any[]) => {
        for (const r of rows) {
          if (!seen.has(r.id)) { seen.add(r.id); combined.push(r) }
        }
      }

      // 1. Por código externo
      addResults(await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(ilike(reservations.externalCode, `%${q}%`), statusCond, ...dateConditions)),
        with: { guest: true, room: true, bookingChannel: true }, limit: 10,
        orderBy: desc(reservations.checkInDate),
      }))

      // 2. Por código de habitación
      const matchRoom = await db.query.rooms.findFirst({ where: and(eq(rooms.propertyId, getPropertyId()), ilike(rooms.code, `%${q}%`)), columns: { id: true } })
      if (matchRoom) {
        addResults(await db.query.reservations.findMany({
          where: and(eq(reservations.propertyId, getPropertyId()), and(eq(reservations.roomId, matchRoom.id), statusCond, ...dateConditions)),
          with: { guest: true, room: true, bookingChannel: true }, limit: 10,
          orderBy: desc(reservations.checkInDate),
        }))
      }

      // 3. Por grupo
      addResults(await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(ilike(reservations.groupName, `%${q}%`), statusCond, ...dateConditions)),
        with: { guest: true, room: true, bookingChannel: true }, limit: 10,
        orderBy: desc(reservations.checkInDate),
      }))

      // 4. Por datos del huésped (nombre, apellido, email, teléfono, DNI)
      const matchGuests = await db.query.guests.findMany({
        where: and(eq(guests.propertyId, getPropertyId()), or(
          ilike(guests.firstName,   `%${q}%`),
          ilike(guests.lastName,    `%${q}%`),
          ilike(guests.email,       `%${q}%`),
          ilike(guests.phone,       `%${q}%`),
          ilike(guests.idDocNumber, `%${q}%`),
        )),
        columns: { id: true },
        limit: 30,
      })
      if (matchGuests.length) {
        addResults(await db.query.reservations.findMany({
          where: and(eq(reservations.propertyId, getPropertyId()), and(
            or(...matchGuests.map(g => eq(reservations.guestId, g.id))),
            statusCond,
            ...dateConditions,
          )),
          with: { guest: true, room: true, bookingChannel: true }, limit: 10,
          orderBy: desc(reservations.checkInDate),
        }))
      }

      if (!combined.length) return { message: 'No se encontraron reservas con esos criterios' }

      const topResults = combined.slice(0, 15)

      // TODOS los huéspedes (titular + acompañantes) de cada reserva, con
      // edad y sexo — no solo el titular. Vía reservation_nights, igual
      // criterio que get_reservation.
      const nightRows = topResults.length ? await db.select({
        reservationId: reservationNights.reservationId,
        guestId:       guests.id,
        firstName:     guests.firstName,
        lastName:      guests.lastName,
        gender:        guests.gender,
        dateOfBirth:   guests.dateOfBirth,
      })
        .from(reservationNights)
        .innerJoin(guests, eq(reservationNights.guestId, guests.id))
        .where(and(inArray(reservationNights.reservationId, topResults.map(r => r.id)), eq(reservationNights.cancelled, false)))
        : []
      const guestsByReservation = new Map<number, { name: string; age: number | null; gender: string }[]>()
      const seenKeys = new Set<string>()
      for (const row of nightRows) {
        const key = `${row.reservationId}:${row.guestId}`
        if (seenKeys.has(key)) continue
        seenKeys.add(key)
        const list = guestsByReservation.get(row.reservationId) ?? []
        list.push({ name: `${row.firstName} ${row.lastName}`, age: ageFromDob(row.dateOfBirth), gender: row.gender ?? 'unspecified' })
        guestsByReservation.set(row.reservationId, list)
      }

      // Saldo pendiente real: no cuenta los depósitos retenidos sin cobrar
      // como pago de la estancia (ver src/lib/paymentAggregate.ts).
      const realPaidById = await realPaidByReservation(topResults.map(r => r.id))

      return topResults.map(r => ({
        id: r.id,
        external_code: r.externalCode ?? null,
        guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        guest_phone: r.guest?.phone ?? null,
        // Todos los ocupantes con edad y sexo (titular incluido) — para
        // preguntas del tipo "qué edades tienen los huéspedes de la 205".
        guests: guestsByReservation.get(r.id) ?? [],
        room: r.room?.code ?? '(sin asignar)',
        channel: r.bookingChannel?.name ?? null,
        check_in:  r.checkInDate,
        check_out: r.checkOutDate,
        nights: r.nights,
        status: r.status,
        total: r.total,
        due: calcPendingBalance(r.total, realPaidById.get(r.id) ?? 0).toFixed(2),
      }))
    }

    case 'search_guests': {
      const { q } = args
      const matchGuests = await db.query.guests.findMany({
        where: and(eq(guests.propertyId, getPropertyId()), or(
          ilike(guests.firstName,   `%${q}%`),
          ilike(guests.lastName,    `%${q}%`),
          ilike(guests.email,       `%${q}%`),
          ilike(guests.phone,       `%${q}%`),
          ilike(guests.idDocNumber, `%${q}%`),
          ilike(drizzleSql`${guests.firstName} || ' ' || ${guests.lastName}`, `%${q}%`),
          ilike(drizzleSql`${guests.lastName} || ' ' || ${guests.firstName}`, `%${q}%`),
        )),
        limit: 10,
      })
      if (!matchGuests.length) return { message: 'No se encontraron huéspedes' }

      const results = []
      for (const g of matchGuests) {
        const [total, last] = await Promise.all([
          db.select({ count: count() }).from(reservations)
            .where(and(eq(reservations.propertyId, getPropertyId()), and(eq(reservations.guestId, g.id), or(
              eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'),
              eq(reservations.status, 'checked_out'), eq(reservations.status, 'checking_out'),
            )))),
          db.query.reservations.findFirst({
            where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.guestId, g.id)),
            orderBy: desc(reservations.checkInDate),
            columns: { checkInDate: true, checkOutDate: true, status: true, id: true },
          }),
        ])
        results.push({
          id: g.id,
          name: `${g.firstName} ${g.lastName}`,
          email: g.email ?? null,
          phone: g.phone ?? null,
          id_doc: g.idDocNumber ?? null,
          age: ageFromDob(g.dateOfBirth),
          gender: g.gender ?? 'unspecified',
          guest_rating: g.guestRating ?? null,
          total_stays: Number(total[0]?.count ?? 0),
          last_reservation: last ? { id: last.id, check_in: last.checkInDate, check_out: last.checkOutDate, status: last.status } : null,
        })
      }
      return results
    }

    case 'search_reservations_by_guest_profile': {
      const { profiles, status, stay_date, checkin_from, checkin_to } = args as {
        profiles: { min_age?: number; max_age?: number; gender?: string }[]
        status?: string; stay_date?: string; checkin_from?: string; checkin_to?: string
      }
      if (!Array.isArray(profiles) || profiles.length === 0) return { error: 'Indica al menos un perfil (edad y/o sexo)' }

      // 1. Candidatas por estado/fechas (igual criterio que search_reservations)
      const dateConditions: any[] = []
      if (checkin_from) dateConditions.push(gte(reservations.checkInDate, checkin_from))
      if (checkin_to)   dateConditions.push(lte(reservations.checkInDate, checkin_to))
      if (stay_date) {
        dateConditions.push(lte(reservations.checkInDate, stay_date))
        dateConditions.push(gte(reservations.checkOutDate, stay_date))
      }
      const candidates = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          status ? eq(reservations.status, status as any) : ne(reservations.status, 'cancelled'),
          ...dateConditions,
        )),
        columns: { id: true, externalCode: true, checkInDate: true, checkOutDate: true, status: true, roomId: true },
        with: { room: { columns: { code: true } } },
        limit: 300,
        orderBy: desc(reservations.checkInDate),
      })
      if (!candidates.length) return { message: 'No hay reservas que cumplan el filtro de estado/fechas' }
      const candidateIds = candidates.map(r => r.id)

      // 2. TODOS los huéspedes (titular + acompañantes) de esas reservas, vía
      // reservation_nights — "una fila por persona por noche" (ver schema),
      // así que se agrupa por guest_id para no repetir a la misma persona
      // una vez por cada noche de su estancia.
      const nightRows = await db.select({
        reservationId: reservationNights.reservationId,
        guestId:       guests.id,
        firstName:     guests.firstName,
        lastName:      guests.lastName,
        gender:        guests.gender,
        dateOfBirth:   guests.dateOfBirth,
      })
        .from(reservationNights)
        .innerJoin(guests, eq(reservationNights.guestId, guests.id))
        .where(and(inArray(reservationNights.reservationId, candidateIds), eq(reservationNights.cancelled, false)))

      const guestsByReservation = new Map<number, { guestId: number; name: string; age: number | null; gender: string }[]>()
      const seenPerReservation = new Set<string>()
      for (const row of nightRows) {
        const key = `${row.reservationId}:${row.guestId}`
        if (seenPerReservation.has(key)) continue
        seenPerReservation.add(key)
        const list = guestsByReservation.get(row.reservationId) ?? []
        list.push({ guestId: row.guestId, name: `${row.firstName} ${row.lastName}`, age: ageFromDob(row.dateOfBirth), gender: row.gender ?? 'unspecified' })
        guestsByReservation.set(row.reservationId, list)
      }

      const matchesProfile = (g: { age: number | null; gender: string }, p: { min_age?: number; max_age?: number; gender?: string }) => {
        if (p.min_age != null && (g.age == null || g.age < p.min_age)) return false
        if (p.max_age != null && (g.age == null || g.age > p.max_age)) return false
        if (p.gender && g.gender !== p.gender) return false
        return true
      }

      // 3. Para cada reserva, comprobar que exista una asignación 1-a-1 entre
      // perfiles pedidos y huéspedes distintos. Backtracking (no greedy): un
      // perfil poco específico resuelto primero podría "quedarse" con el
      // único huésped que encajaba en un perfil posterior más concreto (ej.
      // perfiles ["hombre", "hombre >70"] con huéspedes [hombre 75, hombre
      // 40] — en orden greedy el primer perfil consume al de 75 y el
      // segundo ya no encuentra a nadie, aunque sí hay asignación válida).
      // Con pocos perfiles/huéspedes por habitación, la vuelta atrás es barata.
      const assignProfiles = (profileIdx: number, used: Set<number>, roomGuests: { guestId: number; age: number | null; gender: string }[]): boolean => {
        if (profileIdx >= profiles.length) return true
        const profile = profiles[profileIdx]!
        for (const g of roomGuests) {
          if (used.has(g.guestId) || !matchesProfile(g, profile)) continue
          used.add(g.guestId)
          if (assignProfiles(profileIdx + 1, used, roomGuests)) return true
          used.delete(g.guestId)
        }
        return false
      }

      const results: any[] = []
      for (const r of candidates) {
        const roomGuests = guestsByReservation.get(r.id) ?? []
        const allMatched = assignProfiles(0, new Set<number>(), roomGuests)
        if (allMatched) {
          results.push({
            id: r.id,
            external_code: r.externalCode ?? null,
            room: (r as any).room?.code ?? '(sin asignar)',
            check_in: r.checkInDate,
            check_out: r.checkOutDate,
            status: r.status,
            guests: roomGuests,
          })
        }
      }

      if (!results.length) return { message: 'No se encontraron reservas cuyos huéspedes cumplan esos perfiles' }
      return results.slice(0, 20)
    }

    case 'get_reservation': {
      const r = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.id)),
        with: { guest: true, room: { with: { roomType: true } }, bookingChannel: true, rate: true, notes: { limit: 3, orderBy: desc(drizzleSql`created_at`) } },
      })
      if (!r) return { error: 'Reserva no encontrada' }
      // No cuenta los depósitos retenidos sin cobrar como pago de la
      // estancia (ver src/lib/paymentAggregate.ts).
      const realPaid = (await realPaidByReservation([r.id])).get(r.id) ?? 0
      const due = calcPendingBalance(r.total, realPaid)

      // TODOS los huéspedes de la reserva (titular + acompañantes), con edad
      // y sexo — no solo el titular (r.guest). Vía reservation_nights, que
      // tiene una fila por persona por noche (ver AddGuestModal/POST
      // /reservations/:id/guests), así que se agrupa por guest_id.
      const nightRows = await db.select({
        guestId:     guests.id,
        firstName:   guests.firstName,
        lastName:    guests.lastName,
        gender:      guests.gender,
        dateOfBirth: guests.dateOfBirth,
      })
        .from(reservationNights)
        .innerJoin(guests, eq(reservationNights.guestId, guests.id))
        .where(and(eq(reservationNights.reservationId, r.id), eq(reservationNights.cancelled, false)))
      const seenGuestIds = new Set<number>()
      const allGuests = []
      for (const g of nightRows) {
        if (seenGuestIds.has(g.guestId)) continue
        seenGuestIds.add(g.guestId)
        allGuests.push({ id: g.guestId, name: `${g.firstName} ${g.lastName}`, age: ageFromDob(g.dateOfBirth), gender: g.gender ?? 'unspecified', is_primary: g.guestId === r.guestId })
      }
      // El titular puede no tener fila en reservation_nights si aún no se le
      // asignaron noches (reserva recién creada) — se añade a mano si falta.
      if (r.guest && !seenGuestIds.has(r.guestId)) {
        allGuests.unshift({ id: r.guestId, name: `${r.guest.firstName} ${r.guest.lastName}`, age: ageFromDob(r.guest.dateOfBirth), gender: r.guest.gender ?? 'unspecified', is_primary: true })
      }

      return {
        id: r.id,
        external_code: r.externalCode ?? null,
        status: r.status,
        guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        guest_id: r.guestId,
        guest_phone: r.guest?.phone ?? null,
        guest_email: r.guest?.email ?? null,
        // Todos los ocupantes de la reserva con edad y sexo (titular incluido,
        // marcado con is_primary) — para preguntas del tipo "qué edades tienen
        // los huéspedes de la 205".
        guests: allGuests,
        room: r.room?.code ?? '(sin asignar)',
        room_type: r.room?.roomType?.name ?? null,
        check_in:  r.checkInDate,
        check_out: r.checkOutDate,
        nights: r.nights,
        people: r.people,
        channel: r.bookingChannel?.name ?? null,
        rate: (r.rate as any)?.title ?? null,
        total: r.total,
        paid: realPaid.toFixed(2),
        due: due.toFixed(2),
        group: r.groupName ?? null,
        recent_notes: (r.notes as any[]).map((n: any) => n.note).join(' | ') || null,
      }
    }

    case 'get_reservation_history': {
      const [statusLogs, changeNotes] = await Promise.all([
        db.execute(drizzleSql`
          SELECT rsl.from_status, rsl.to_status, rsl.source, rsl.changed_at,
                 u.first_name, u.last_name
          FROM reservation_status_logs rsl
          LEFT JOIN users u ON u.id = rsl.user_id
          WHERE rsl.reservation_id = ${args.id}
            AND EXISTS (SELECT 1 FROM reservations rr WHERE rr.id = rsl.reservation_id AND rr.property_id = ${getPropertyId()})
          ORDER BY rsl.changed_at ASC
        `).catch(() => []) as Promise<{ from_status: string | null; to_status: string; source: string; changed_at: string; first_name: string | null; last_name: string | null }[]>,
        db.execute(drizzleSql`
          SELECT rn.note, rn.type, rn.created_at,
                 u.first_name, u.last_name
          FROM reservation_notes rn
          LEFT JOIN users u ON u.id = rn.author_id
          WHERE rn.reservation_id = ${args.id}
            AND EXISTS (SELECT 1 FROM reservations rr WHERE rr.id = rn.reservation_id AND rr.property_id = ${getPropertyId()})
          ORDER BY rn.created_at ASC
        `).catch(() => []) as Promise<{ note: string; type: string; created_at: string; first_name: string | null; last_name: string | null }[]>,
      ])

      if (!statusLogs.length && !changeNotes.length) {
        return { message: 'Sin historial registrado para esta reserva' }
      }

      const SOURCE_ES: Record<string, string> = {
        user: 'Usuario', fdm: 'FDM sync', import: 'Importación FDM',
        checkin: 'Check-in', checkout: 'Check-out', cancel: 'Cancelación',
        revert: 'Reversión', auto: 'Sistema automático',
      }
      const STATUS_ES: Record<string, string> = {
        confirmed: 'Confirmada', tentative: 'Tentativa', checked_in: 'En casa',
        checking_out: 'Pendiente de salida', checked_out: 'Ha salido',
        cancelled: 'Cancelada', no_show: 'No show',
      }

      type HistoryEvent = { ts: string; type: string; summary: string; detail?: string; by: string | null }
      const events: HistoryEvent[] = []

      for (const l of statusLogs as any[]) {
        const from = l.from_status ? (STATUS_ES[l.from_status] ?? l.from_status) : null
        const to   = STATUS_ES[l.to_status] ?? l.to_status
        events.push({
          ts:      l.changed_at,
          type:    'estado',
          summary: from ? `${from} → ${to}` : `Creada (${to})`,
          detail:  SOURCE_ES[l.source] ?? l.source,
          by:      l.first_name ? `${l.first_name} ${l.last_name ?? ''}`.trim() : null,
        })
      }

      for (const n of changeNotes as any[]) {
        const by = n.first_name ? `${n.first_name} ${n.last_name ?? ''}`.trim() : null
        if (n.type === 'change') {
          const fields = (n.note as string).split('\n').filter(Boolean)
          for (const field of fields) {
            events.push({ ts: n.created_at, type: 'modificacion', summary: field, by })
          }
        } else {
          events.push({ ts: n.created_at, type: 'nota', summary: n.note, by })
        }
      }

      events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
      return events
    }

    case 'get_arrivals': {
      const date = args.date ?? today
      const list = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          eq(reservations.checkInDate, date),
          or(
            eq(reservations.status, 'confirmed'),
            eq(reservations.status, 'arriving'),
            eq(reservations.status, 'tentative'),
            eq(reservations.status, 'checked_in'),
            eq(reservations.status, 'checking_out'),
            eq(reservations.status, 'checked_out'),
          ),
        )),
        with: { guest: true, room: true, checkedInByUser: true },
        orderBy: reservations.checkedInAt,
        limit: 50,
      })
      if (!list.length) return { message: `No hay llegadas para el ${date}` }
      // No cuenta los depósitos retenidos sin cobrar como pago de la
      // estancia (ver src/lib/paymentAggregate.ts).
      const arrivalsPaidById = await realPaidByReservation(list.map(r => r.id))
      return list.map(r => {
        const employee = (r as any).checkedInByUser
          ? `${(r as any).checkedInByUser.firstName ?? ''} ${(r as any).checkedInByUser.lastName ?? ''}`.trim()
          : null
        const checkedInAt = (r as any).checkedInAt
          ? new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date((r as any).checkedInAt))
          : null
        return {
          id:           r.id,
          guest:        `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
          room:         r.room?.code ?? '(sin asignar)',
          nights:       r.nights,
          check_out:    r.checkOutDate,
          status:       r.status,
          checked_in_at: checkedInAt,
          checked_in_by: employee,
          due:          calcPendingBalance(r.total, arrivalsPaidById.get(r.id) ?? 0).toFixed(2),
        }
      })
    }

    case 'get_departures': {
      const date = args.date ?? today
      const list = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          eq(reservations.checkOutDate, date),
          or(eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out'), eq(reservations.status, 'checked_out')),
        )),
        with: { guest: true, room: true },
        orderBy: reservations.checkOutDate,
        limit: 30,
      })
      if (!list.length) return { message: `No hay salidas para el ${date}` }
      const departuresPaidById = await realPaidByReservation(list.map(r => r.id))
      return list.map(r => ({
        id: r.id,
        guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        room: r.room?.code ?? '—',
        status: r.status,
        due: calcPendingBalance(r.total, departuresPaidById.get(r.id) ?? 0).toFixed(2),
      }))
    }

    case 'get_in_house': {
      const list = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), or(eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out'))),
        with: { guest: true, room: true },
        orderBy: reservations.checkOutDate,
        limit: 50,
      })
      if (!list.length) return { message: 'No hay huéspedes en el hotel ahora mismo' }
      const inHousePaidById = await realPaidByReservation(list.map(r => r.id))
      return list.map(r => ({
        id: r.id,
        guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        room: r.room?.code ?? '—',
        check_out: r.checkOutDate,
        status: r.status,
        due: calcPendingBalance(r.total, inHousePaidById.get(r.id) ?? 0).toFixed(2),
      }))
    }

    case 'check_in': {
      const r = await db.query.reservations.findFirst({ where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)) })
      if (!r) return { error: 'Reserva no encontrada' }
      if (!['confirmed', 'arriving', 'tentative'].includes(r.status)) return { error: `No se puede hacer check-in, estado actual: ${r.status}` }
      // Mismos datos obligatorios que exige el check-in desde la web (titular
      // Y huéspedes adicionales: segundo apellido, documento, nº soporte…) —
      // sin esto el agente podía saltarse por completo la comprobación.
      const sesCheck = await collectAndValidateSes(args.reservation_id)
      if ('error' in sesCheck) return { error: sesCheck.error }
      if (sesCheck.validationErrors.length > 0) {
        return { error: 'Faltan datos obligatorios de huéspedes antes del check-in', missing_fields: sesCheck.validationErrors }
      }
      await db.update(reservations).set({
        status: 'checked_in', previousStatus: r.status,
        checkedInAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)))
      await logStatusChange(args.reservation_id, r.status, 'checked_in', 'checkin')
      return { success: true, message: 'Check-in realizado', reservation_id: args.reservation_id }
    }

    case 'check_out': {
      const r = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        with: { guest: { columns: { id: true, firstName: true, lastName: true } } },
      })
      if (!r) return { error: 'Reserva no encontrada' }
      if (r.status !== 'checked_in' && r.status !== 'checking_out') return { error: `No se puede hacer check-out, estado actual: ${r.status}` }
      await db.update(reservations).set({
        status: 'checked_out', previousStatus: r.status,
        checkedOutAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)))
      await logStatusChange(args.reservation_id, r.status, 'checked_out', 'checkout')
      const g = r.guest as any
      return {
        success: true, message: 'Check-out realizado', reservation_id: args.reservation_id,
        guest_id: g?.id ?? null,
        guest_name: g ? `${g.firstName} ${g.lastName}`.trim() : null,
        prompt_guest_rating: true,
      }
    }

    case 'get_availability': {
      const { date_from, date_to } = args
      const occupied = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          lte(reservations.checkInDate, date_to),
          gte(reservations.checkOutDate, date_from),
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative'),
             eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out')),
        )),
        columns: { roomId: true },
      })
      const occupiedIds = new Set(occupied.map(r => r.roomId).filter(Boolean))
      const allRooms = await db.query.rooms.findMany({
        where: and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true)),
        with: { roomType: true },
      })
      const available = allRooms.filter(r => !r.roomType?.isVirtual && !occupiedIds.has(r.id))
      return {
        date_from, date_to,
        total_available: available.length,
        rooms: available.map(r => ({ code: r.code, type: r.roomType?.name })),
      }
    }

    case 'query_reservations': {
      const { status, checkin_from, checkin_to, checkout_from, checkout_to, stay_date, channel, room_code, guest_name, list } = args
      const conditions: any[] = []

      if (status)        conditions.push(eq(reservations.status, status))
      if (checkin_from)  conditions.push(gte(reservations.checkInDate, checkin_from))
      if (checkin_to)    conditions.push(lte(reservations.checkInDate, checkin_to))
      if (checkout_from) conditions.push(gte(reservations.checkOutDate, checkout_from))
      if (checkout_to)   conditions.push(lte(reservations.checkOutDate, checkout_to))
      if (stay_date) {
        conditions.push(lte(reservations.checkInDate, stay_date))
        conditions.push(gte(reservations.checkOutDate, stay_date))
      }

      if (channel) {
        const chs = await db.query.bookingChannels.findMany({
          where: and(eq(bookingChannels.propertyId, getPropertyId()), ilike(bookingChannels.name, `%${channel}%`)), columns: { id: true },
        })
        if (chs.length) conditions.push(or(...chs.map(ch => eq(reservations.bookingChannelId, ch.id))))
        else return { count: 0, message: `Canal "${channel}" no encontrado` }
      }
      if (room_code) {
        const room = await db.query.rooms.findFirst({ where: and(eq(rooms.propertyId, getPropertyId()), ilike(rooms.code, `%${room_code}%`)), columns: { id: true } })
        if (room) conditions.push(eq(reservations.roomId, room.id))
        else return { count: 0, message: `Habitación "${room_code}" no encontrada` }
      }
      if (guest_name) {
        const gs = await db.query.guests.findMany({
          where: and(eq(guests.propertyId, getPropertyId()), or(ilike(guests.firstName, `%${guest_name}%`), ilike(guests.lastName, `%${guest_name}%`))),
          columns: { id: true }, limit: 30,
        })
        if (gs.length) conditions.push(or(...gs.map(g => eq(reservations.guestId, g.id))))
        else return { count: 0, message: `No se encontró ningún huésped con ese nombre` }
      }

      const where = conditions.length ? and(...conditions) : undefined
      const [total] = await db.select({ count: count() }).from(reservations).where(and(eq(reservations.propertyId, getPropertyId()), where))

      if (!list) return { count: Number(total?.count ?? 0) }

      const rows = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), where), with: { guest: true, room: true },
        orderBy: desc(reservations.checkInDate), limit: 20,
      })
      return {
        count: Number(total?.count ?? 0),
        reservations: rows.map(r => ({
          id: r.id,
          guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
          room: r.room?.code ?? '(sin asignar)',
          check_in: r.checkInDate, check_out: r.checkOutDate,
          status: r.status, total: r.total,
        })),
      }
    }

    case 'create_feedback_thread': {
      if (!ctx.roles.some(r => ['direccion', 'recepcion', 'conserje', 'limpieza'].includes(r))) return { error: 'Sin permisos para abrir hilos de feedback' }
      // Los ids que vienen del modelo deben pertenecer al tenant actual.
      const fbRes = Number.isInteger(args.reservation_id)
        ? await db.query.reservations.findFirst({ where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)), columns: { id: true } }) : null
      const fbGuest = Number.isInteger(args.guest_id)
        ? await db.query.guests.findFirst({ where: and(eq(guests.propertyId, getPropertyId()), eq(guests.id, args.guest_id)), columns: { id: true } }) : null
      const fbAssignee = Number.isInteger(args.assignee_id)
        ? await db.query.users.findFirst({ where: and(eq(users.propertyId, getPropertyId()), eq(users.id, args.assignee_id)), columns: { id: true } }) : null
      const [row] = await db.insert(feedbackThreads).values({
        propertyId: getPropertyId(), text: String(args.text ?? '').slice(0, 2000),
        sentiment: ['positive', 'neutral', 'complaint', 'suggestion'].includes(args.sentiment) ? args.sentiment : 'neutral',
        category: String(args.category ?? 'otro').slice(0, 40), channel: String(args.channel ?? 'verbal').slice(0, 40),
        reservationId: fbRes?.id ?? null,
        guestId: fbGuest?.id ?? null,
        assigneeId: fbAssignee?.id ?? null,
        dueDate: /^\d{4}-\d{2}-\d{2}$/.test(args.due_date ?? '') ? args.due_date : null,
        source: 'ai', createdBy: ctx.userId ?? null,
      }).returning({ id: feedbackThreads.id })
      return { ok: true, thread_id: row!.id, message: `Hilo #${row!.id} abierto` }
    }

    case 'list_feedback_threads': {
      if (!ctx.roles.some(r => ['direccion', 'recepcion', 'conserje'].includes(r))) return { error: 'Sin permisos' }
      const ownThread = Number.isInteger(args.update_thread_id)
        ? await db.query.feedbackThreads.findFirst({ where: and(eq(feedbackThreads.propertyId, getPropertyId()), eq(feedbackThreads.id, args.update_thread_id)), columns: { id: true } })
        : null
      if (ownThread) {
        if (args.new_status) {
          await db.update(feedbackThreads).set({
            status: args.new_status, resolvedAt: ['resolved', 'wontfix'].includes(args.new_status) ? new Date() : null,
          }).where(and(eq(feedbackThreads.propertyId, getPropertyId()), eq(feedbackThreads.id, args.update_thread_id)))
        }
        if (args.comment) await db.insert(feedbackComments).values({ threadId: args.update_thread_id, authorId: ctx.userId ?? null, text: String(args.comment).slice(0, 2000) })
      }
      const st = args.status ?? 'open_or_progress'
      const conds = [
        st === 'all' ? undefined : st === 'open_or_progress' ? inArray(feedbackThreads.status, ['open', 'in_progress']) : eq(feedbackThreads.status, st),
        Number(args.days) > 0 ? gte(feedbackThreads.createdAt, new Date(Date.now() - Number(args.days) * 86400000)) : undefined,
      ].filter(Boolean) as any[]
      const rows = await db.select().from(feedbackThreads).where(and(eq(feedbackThreads.propertyId, getPropertyId()), conds.length ? and(...conds) : undefined)).orderBy(desc(feedbackThreads.createdAt)).limit(100)
      const byCat: Record<string, { positive: number; complaint: number; other: number }> = {}
      for (const r of rows) {
        const b = (byCat[r.category] ??= { positive: 0, complaint: 0, other: 0 })
        if (r.sentiment === 'positive') b.positive++; else if (r.sentiment === 'complaint') b.complaint++; else b.other++
      }
      return { count: rows.length, by_category: byCat, threads: rows.map(r => ({ id: r.id, created: r.createdAt, sentiment: r.sentiment, category: r.category, status: r.status, due: r.dueDate, assignee_id: r.assigneeId, reservation_id: r.reservationId, text: r.text })) }
    }

    case 'get_pricing_effects': {
      if (isRevenueBlocked(ctx)) return { error: REVENUE_BLOCKED_MSG }
      const days = Math.min(120, Math.max(3, Math.round(Number(args.days) || 30)))
      const by = await computePricingEffects(days)
      return { days, note: 'Indicativo, no causal. bookingsBefore/After = reservas de esa noche hechas en las 72 h antes/después de cada cambio. verdict: funciona | sin_efecto | perjudica | pocos_datos. Misma pestaña "Efecto reglas" de Informes.', by_rule: by }
    }

    case 'adjust_engagement_rating': {
      if (!ctx.roles.includes('direccion')) return { error: 'Solo dirección' }
      if (!args.user_name && args.points == null) {
        return { ratings: (await computeOfficialRatings()).map(o => ({ name: o.name, role: o.role, base_3m: o.base, bonus: o.bonus, total: o.rating })) }
      }
      const pts = Math.round(Number(args.points))
      if (!Number.isFinite(pts) || pts < -30 || pts > 30 || pts === 0) return { error: 'points debe ser un entero entre −30 y 30 (distinto de 0)' }
      const target = await findStaffUserByName(String(args.user_name))
      if (!target) return { error: `No se encontró a ningún miembro del equipo llamado "${args.user_name}"` }
      await addEngagementAdjustment(target.id, pts, args.reason ? String(args.reason).slice(0, 300) : null, ctx.userId ?? null)
      return { ok: true, message: `${pts > 0 ? '+' : ''}${pts} puntos de implicación para ${target.firstName} ${target.lastName}` }
    }

    case 'get_pricing_rules_status': {
      if (isRevenueBlocked(ctx)) return { error: REVENUE_BLOCKED_MSG }
      const rules = await db.select().from(pricingRules).where(eq(pricingRules.propertyId, getPropertyId()))
      const engine = getPricingEngineStatus()
      const out: Record<string, unknown> = {
        engine,
        rules: rules
          .sort((a, b) => a.priority - b.priority || a.id - b.id)
          .map(r => ({ id: r.id, name: r.name, type: r.ruleType, active: r.active, priority: r.priority, thresholdPct: r.thresholdPct, adjustType: r.adjustType, adjustValue: r.adjustValue })),
        note: 'Solo aplica UNA regla por fecha (menor priority gana). Si `engine.looksStalled` es true o lastPass es null, el motor no está corriendo (¿servidor reiniciado hace poco, o scheduler no arrancado?). El diagnóstico por fecha vive en memoria: viene de la última pasada. IMPORTANTE al explicar horas al usuario: los campos startedAt/finishedAt/schedulerStartedAt/nextExpectedStart están en UTC (sufijo "Z") — usa siempre los campos *Madrid (nowMadrid, lastPassStartedAtMadrid, lastPassFinishedAtMadrid, schedulerStartedAtMadrid, nextExpectedStartMadrid) para decir la hora, nunca los UTC directamente, o parecerá un desfase de 1-2h que no existe.',
      }
      if (args.date) {
        const d = getPricingDateDiagnosis(String(args.date))
        out.dateDiagnosis = d ?? 'Sin diagnóstico para esa fecha: fuera del horizonte, aún no hubo pasada completa desde el último arranque, o ninguna celda de precio de la tarifa raíz con base configurada la cubre.'
      }
      return out
    }

    case 'get_revenue': {
      if (isRevenueBlocked(ctx, args.date_from, args.date_to)) return { error: REVENUE_BLOCKED_MSG }
      const DEPOSIT_METHODS = ['deposit', 'deposit_cc'] as const
      const rows = await db
        .select({ method: financialTransactions.paymentMethod, total: sum(financialTransactions.amount) })
        .from(financialTransactions)
        .where(and(eq(financialTransactions.propertyId, getPropertyId()), and(
          gte(financialTransactions.transactionDate, args.date_from),
          lte(financialTransactions.transactionDate, args.date_to),
          notInArray(financialTransactions.paymentMethod, [...DEPOSIT_METHODS]),
        )))
        .groupBy(financialTransactions.paymentMethod)

      const METHOD_ES: Record<string, string> = {
        cash: 'Efectivo', credit_card: 'Tarjeta', bank_transfer: 'Transferencia',
        stripe: 'Stripe', booking_virtual_card: 'Virtual Booking', jumbo_credit: 'Jumbo crédito', other: 'Otro',
      }
      const breakdown = rows.map(r => ({ method: METHOD_ES[r.method] ?? r.method, total: parseFloat(r.total ?? '0').toFixed(2) }))
      const grand_total = breakdown.reduce((s, r) => s + parseFloat(r.total), 0).toFixed(2)
      return { date_from: args.date_from, date_to: args.date_to, grand_total, breakdown }
    }

    case 'get_revenue_forecast': {
      if (isRevenueBlocked(ctx, args.date_from, args.date_to)) return { error: REVENUE_BLOCKED_MSG }
      const [res] = await db
        .select({ total: sum(reservations.total), count: count() })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          gte(reservations.checkInDate, args.date_from),
          lte(reservations.checkInDate, args.date_to),
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative')),
        )))
      return {
        date_from: args.date_from, date_to: args.date_to,
        reservations: Number(res?.count ?? 0),
        forecast_total: parseFloat(res?.total ?? '0').toFixed(2),
        note: 'Importe total de reservas confirmadas/tentativas, no cobros realizados',
      }
    }

    case 'get_occupancy_rate': {
      const allRooms = await db.query.rooms.findMany({
        where: and(eq(rooms.propertyId, getPropertyId()), and(eq(rooms.active, true), ne(rooms.code, 'VIRTUAL'))),
        columns: { id: true },
      })
      const totalRooms = allRooms.length
      if (!totalRooms) return { error: 'No hay habitaciones activas' }

      const from = new Date(args.date_from + 'T12:00:00Z')
      const to   = new Date(args.date_to   + 'T12:00:00Z')
      const totalNights = Math.round((to.getTime() - from.getTime()) / 86400000)
      if (totalNights <= 0) return { error: 'Rango de fechas inválido' }

      const occupied = await db
        .select({ nights: sum(reservations.nights) })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          gte(reservations.checkInDate, args.date_from),
          lte(reservations.checkInDate, args.date_to),
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'), eq(reservations.status, 'checked_out')),
        )))

      const occupiedNights = parseFloat(occupied[0]?.nights ?? '0')
      const possibleNights = totalRooms * totalNights
      return {
        date_from: args.date_from, date_to: args.date_to,
        total_rooms: totalRooms,
        total_nights_possible: possibleNights,
        nights_occupied: Math.round(occupiedNights),
        occupancy_rate: ((occupiedNights / possibleNights) * 100).toFixed(1) + '%',
      }
    }

    case 'get_channel_stats': {
      if (isRevenueBlocked(ctx, args.date_from, args.date_to)) return { error: REVENUE_BLOCKED_MSG }
      const rows = await db
        .select({
          channelId: reservations.bookingChannelId,
          total_reservations: count(),
          total_revenue: sum(reservations.total),
          total_nights: sum(reservations.nights),
        })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          args.date_from ? gte(reservations.checkInDate, args.date_from) : undefined,
          args.date_to   ? lte(reservations.checkInDate, args.date_to)   : undefined,
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'), eq(reservations.status, 'checked_out')),
        )))
        .groupBy(reservations.bookingChannelId)

      const allChannels = await db.query.bookingChannels.findMany({ where: eq(bookingChannels.propertyId, getPropertyId()), columns: { id: true, name: true } })
      const chMap = new Map(allChannels.map(c => [c.id, c.name]))

      return rows
        .sort((a, b) => Number(b.total_reservations) - Number(a.total_reservations))
        .map(r => ({
          channel: r.channelId ? (chMap.get(r.channelId) ?? `Canal #${r.channelId}`) : 'Directo',
          reservations: Number(r.total_reservations),
          revenue: parseFloat(r.total_revenue ?? '0').toFixed(2),
          nights: Number(r.total_nights ?? 0),
        }))
    }

    case 'get_pending_payments': {
      const minDue = args.min_due ?? 0.01
      // Saldo real: no cuenta los depósitos retenidos sin cobrar como pago
      // de la estancia (ver src/lib/paymentAggregate.ts) — si no, una
      // reserva con solo un depósito pagado no aparecería como pendiente.
      const realPaidSubquery = drizzleSql`(
        SELECT COALESCE(SUM(amount) FILTER (WHERE payment_method NOT IN ('deposit','deposit_cc')), 0)
             + COALESCE(SUM(amount) FILTER (WHERE category = 'deposit_cobrado'), 0)
        FROM financial_transactions ft WHERE ft.reservation_id = ${reservations.id}
      )`
      const rowsRaw = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          args.checkout_date ? eq(reservations.checkOutDate, args.checkout_date) : undefined,
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'), eq(reservations.status, 'arriving'),
             eq(reservations.status, 'tentative'), eq(reservations.status, 'checking_out')),
          drizzleSql`(${reservations.total}::numeric - ${realPaidSubquery}) >= ${minDue}`,
        )),
        with: { guest: true, room: true, bookingChannel: { columns: { name: true } } },
        orderBy: desc(drizzleSql`(${reservations.total}::numeric - ${realPaidSubquery})`),
        limit: 40,
      })
      // Algunos canales solo habilitan el cobro el día del check-out (ids en
      // settings channels.exemptFromUnpaidAlert) — antes de esa fecha un saldo
      // pendiente es normal, no morosidad. Se excluyen aquí las reservas de esos
      // canales cuyo check-out todavía no ha llegado; a partir de esa fecha si
      // siguen sin cobrar sí aparecen con normalidad.
      const exemptChannelIds = new Set<number>(((await getSetting<number[]>('channels.exemptFromUnpaidAlert')) ?? []).map(Number))
      const rows = rowsRaw
        .filter(r => {
          if (!r.bookingChannelId || !exemptChannelIds.has(r.bookingChannelId)) return true
          return r.checkOutDate <= today
        })
        .slice(0, 20)
      if (!rows.length) return { message: 'No hay reservas con saldo pendiente' }
      const pendingPaidById = await realPaidByReservation(rows.map(r => r.id))
      return rows.map(r => {
        const paid = pendingPaidById.get(r.id) ?? 0
        return {
          id: r.id,
          guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
          room: r.room?.code ?? '—',
          check_out: r.checkOutDate,
          total: r.total,
          paid: paid.toFixed(2),
          due: calcPendingBalance(r.total, paid).toFixed(2),
          status: r.status,
          channel: r.bookingChannel?.name ?? null,
        }
      })
    }

    case 'get_repeat_guests': {
      const limit = args.limit ?? 10
      // Agrupa por nombre normalizado para fusionar registros duplicados del mismo huésped
      const rows = await db.execute(drizzleSql`
        SELECT
          LOWER(TRIM(g.first_name)) || ' ' || LOWER(TRIM(g.last_name)) AS name_key,
          MIN(g.first_name || ' ' || g.last_name) AS guest_name,
          MIN(g.email) AS email,
          COUNT(r.id)::int AS stays,
          SUM(r.total::numeric)::numeric AS total_spent
        FROM reservations r
        JOIN guests g ON g.id = r.guest_id
        WHERE r.property_id = ${getPropertyId()}
          AND r.status IN ('confirmed', 'checked_in', 'checked_out', 'checking_out')
        GROUP BY name_key
        HAVING COUNT(r.id) > 1
        ORDER BY stays DESC
        LIMIT ${limit}
      `) as unknown as { name_key: string; guest_name: string; email: string | null; stays: number; total_spent: string }[]

      if (!rows.length) return { message: 'No hay huéspedes repetidores' }
      return rows.map(r => ({
        guest: r.guest_name,
        email: r.email ?? null,
        stays: Number(r.stays),
        total_spent: parseFloat(r.total_spent ?? '0').toFixed(2),
      }))
    }

    case 'get_stay_stats': {
      const revenueBlocked = isRevenueBlocked(ctx, args.date_from, args.date_to)
      const [res] = await db
        .select({
          total_reservations: count(),
          avg_nights: avg(reservations.nights),
          avg_total:  avg(reservations.total),
          sum_nights: sum(reservations.nights),
          sum_total:  sum(reservations.total),
        })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          args.date_from ? gte(reservations.checkInDate, args.date_from) : undefined,
          args.date_to   ? lte(reservations.checkInDate, args.date_to)   : undefined,
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'), eq(reservations.status, 'checked_out')),
        )))

      const avgNights   = parseFloat(res?.avg_nights ?? '0')
      const avgTotal    = parseFloat(res?.avg_total  ?? '0')
      return {
        total_reservations: Number(res?.total_reservations ?? 0),
        avg_nights:   avgNights.toFixed(1),
        avg_per_stay: revenueBlocked ? null : avgTotal.toFixed(2),
        avg_per_night: revenueBlocked ? null : (avgNights > 0 ? avgTotal / avgNights : 0).toFixed(2),
        total_nights:  Number(res?.sum_nights ?? 0),
        total_revenue: revenueBlocked ? null : parseFloat(res?.sum_total ?? '0').toFixed(2),
        revenue_note: revenueBlocked ? REVENUE_BLOCKED_MSG : undefined,
      }
    }

    case 'search_rooms': {
      const conds: any[] = [eq(rooms.active, true)]
      if (args.bathroom)     conds.push(eq(rooms.bathroom, args.bathroom))
      if (args.terrace)      conds.push(eq(rooms.terrace, args.terrace))
      if (args.balcony != null) conds.push(eq(rooms.balcony, args.balcony))
      if (args.bed_size)     conds.push(eq(rooms.bedSize, args.bed_size))
      if (args.view)         conds.push(eq(rooms.view, args.view))
      if (args.min_sqm)      conds.push(gte(rooms.roomSizeSqm, String(args.min_sqm)))
      if (args.room_type_id) conds.push(eq(rooms.roomTypeId, args.room_type_id))

      const list = await db.query.rooms.findMany({
        where: and(eq(rooms.propertyId, getPropertyId()), and(...conds)),
        with: { roomType: { columns: { name: true, maxOccupancy: true, ensuite: true, allowExtraBeds: true, extraBedPrice: true, description: true } } },
        orderBy: rooms.orderIndex,
      })
      if (!list.length) return { message: 'No hay habitaciones con esas características.' }
      return list.map(r => ({
        id:           r.id,
        code:         r.code,
        type:         (r.roomType as any)?.name ?? '(sin tipo)',
        max_occupancy: (r.roomType as any)?.maxOccupancy,
        ensuite:      (r.roomType as any)?.ensuite,
        extra_beds:   (r.roomType as any)?.allowExtraBeds > 0 ? `hasta ${(r.roomType as any).allowExtraBeds} camas extra a ${(r.roomType as any).extraBedPrice} €/ud` : null,
        description:  (r.roomType as any)?.description ?? null,
        bathroom:     r.bathroom,
        terrace:      r.terrace,
        balcony:      r.balcony || null,
        bed_size:     r.bedSize,
        size_sqm:     r.roomSizeSqm ? Number(r.roomSizeSqm) : null,
        view:         r.view,
        ac:           r.acBrand ?? null,
        tv:           r.tvBrand ?? null,
      }))
    }

    case 'get_room_stats': {
      const limit = args.limit ?? 5
      const rows = await db
        .select({
          roomId: reservations.roomId,
          reservations_count: count(),
          total_nights: sum(reservations.nights),
          total_revenue: sum(reservations.total),
        })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          args.date_from ? gte(reservations.checkInDate, args.date_from) : undefined,
          args.date_to   ? lte(reservations.checkInDate, args.date_to)   : undefined,
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'checked_in'), eq(reservations.status, 'checked_out')),
        )))
        .groupBy(reservations.roomId)
        .orderBy(desc(count()))
        .limit(limit)

      const roomIds = rows.map(r => r.roomId).filter(Boolean) as number[]
      const roomList = roomIds.length
        ? await db.query.rooms.findMany({ where: and(eq(rooms.propertyId, getPropertyId()), or(...roomIds.map(id => eq(rooms.id, id)))), columns: { id: true, code: true } })
        : []
      const rMap = new Map(roomList.map(r => [r.id, r]))
      return rows.map(r => ({
        room: r.roomId ? (rMap.get(r.roomId)?.code ?? `#${r.roomId}`) : '(sin asignar)',
        reservations: Number(r.reservations_count),
        nights: Number(r.total_nights ?? 0),
        revenue: parseFloat(r.total_revenue ?? '0').toFixed(2),
      }))
    }

    case 'get_unassigned_reservations': {
      const rows = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          isNull(reservations.roomId),
          args.date_from ? gte(reservations.checkInDate, args.date_from) : undefined,
          args.date_to   ? lte(reservations.checkInDate, args.date_to)   : undefined,
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative')),
        )),
        with: { guest: true },
        orderBy: reservations.checkInDate,
        limit: 20,
      })
      if (!rows.length) return { message: 'Todas las reservas tienen habitación asignada' }
      return {
        count: rows.length,
        reservations: rows.map(r => ({
          id: r.id,
          guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
          check_in: r.checkInDate, check_out: r.checkOutDate,
          status: r.status, external_code: r.externalCode,
        })),
      }
    }

    case 'get_price_recommendation': {
      const { date_from, date_to, rate_id } = args
      const group = args.group === 'week' ? 'week' : 'day'
      const revenueBlocked = isRevenueBlocked(ctx)

      // Habitaciones activas (no virtuales)
      const activeRooms = await db.query.rooms.findMany({
        where: and(eq(rooms.propertyId, getPropertyId()), and(eq(rooms.active, true))),
        with: { roomType: true },
        columns: { id: true },
      })
      const nonVirtualRooms = activeRooms.filter(r => !(r.roomType as any)?.isVirtual)
      const totalRooms = nonVirtualRooms.length
      if (!totalRooms) return { error: 'No hay habitaciones activas' }

      // Ocupación por día en el rango
      const occupiedByDay = await db.execute(drizzleSql`
        SELECT d::date AS date,
               COUNT(DISTINCT r.room_id)::int AS occupied
        FROM generate_series(${date_from}::date, ${date_to}::date, '1 day'::interval) d
        LEFT JOIN reservations r
          ON r.check_in_date <= d::date
         AND r.check_out_date > d::date
         AND r.room_id IS NOT NULL
         AND r.property_id = ${getPropertyId()}
         AND r.status NOT IN ('cancelled', 'no_show')
        GROUP BY d
        ORDER BY d
      `) as unknown as { date: string; occupied: number }[]

      // Precios configurados en el rango (todas las tarifas o la indicada)
      const priceRows = await db.select({
        date:     rateDailyPrices.date,
        price:    rateDailyPrices.price,
        rateId:   rateDailyPrices.rateId,
      }).from(rateDailyPrices)
        .where(and(eq(rateDailyPrices.propertyId, getPropertyId()), and(
          gte(rateDailyPrices.date, date_from),
          lte(rateDailyPrices.date, date_to),
          rate_id ? eq(rateDailyPrices.rateId, rate_id) : undefined,
        )))

      const priceMap = new Map<string, number[]>()
      for (const p of priceRows) {
        const list = priceMap.get(p.date) ?? []
        list.push(parseFloat(p.price ?? '0'))
        priceMap.set(p.date, list)
      }

      // ADR real (ingresos ÷ noches ocupadas) de LA SEMANA de cada fecha —
      // mismo dato compartido que usa el calendario de precios y el suelo de
      // la regla dinámica "Parada de reservas" (weeklyAdrByDate). null si esa
      // semana no tiene ninguna noche ocupada todavía (nada real que comparar).
      const adrByDate = await weeklyAdrByDate(date_from, date_to)

      // Construir análisis por día
      const HIGH_OCC = 0.75, LOW_OCC = 0.40
      const days = occupiedByDay.map(d => {
        const occ = Number(d.occupied) / totalRooms
        const prices = priceMap.get(d.date) ?? []
        const avgPrice = prices.length ? prices.reduce((s, p) => s + p, 0) / prices.length : null
        const weekAdr  = adrByDate[d.date] ?? null
        let recommendation: string
        if (occ >= HIGH_OCC)      recommendation = 'SUBIR precio (alta ocupación)'
        else if (occ <= LOW_OCC)  recommendation = 'BAJAR precio (baja ocupación)'
        else                       recommendation = 'MANTENER precio'
        return {
          date: d.date,
          occupied: Number(d.occupied),
          total_rooms: totalRooms,
          occupancy_pct: (occ * 100).toFixed(0) + '%',
          avg_price_configured: avgPrice != null ? avgPrice.toFixed(2) + ' €' : 'sin precio',
          weekly_adr: revenueBlocked ? null : (weekAdr != null ? weekAdr.toFixed(2) + ' €' : 'sin ADR real todavía'),
          recommendation,
        }
      })

      const avgOcc = days.reduce((s, d) => s + parseFloat(d.occupancy_pct), 0) / (days.length || 1)
      const daysHigh = days.filter(d => d.recommendation.startsWith('SUBIR')).length
      const daysLow  = days.filter(d => d.recommendation.startsWith('BAJAR')).length

      const dailyResult = {
        date_from, date_to,
        total_rooms: totalRooms,
        avg_occupancy: avgOcc.toFixed(0) + '%',
        days_suggest_increase: daysHigh,
        days_suggest_decrease: daysLow,
        summary: daysHigh > daysLow
          ? `Período con alta ocupación (${daysHigh} días por encima del 75%). Recomendable subir precios.`
          : daysLow > daysHigh
          ? `Período con baja ocupación (${daysLow} días por debajo del 40%). Considera bajar precios o promociones.`
          : 'Ocupación equilibrada. Mantener precios actuales.',
        revenue_note: revenueBlocked ? REVENUE_BLOCKED_MSG : undefined,
        days,
      }
      if (group === 'day') return dailyResult

      // Rollup semanal: media de ocupación/precio listado de los días de esa
      // semana dentro del rango pedido (puede ser una semana parcial en los
      // bordes) + el ADR real de esa semana (ya es un único valor por semana).
      type WeekAgg = { week: string; occSum: number; occCount: number; priceSum: number; priceCount: number; adr: number | null }
      const byWeek = new Map<string, WeekAgg>()
      for (const d of days) {
        const wk = isoWeek(d.date)
        let agg = byWeek.get(wk)
        if (!agg) { agg = { week: wk, occSum: 0, occCount: 0, priceSum: 0, priceCount: 0, adr: adrByDate[d.date] ?? null }; byWeek.set(wk, agg) }
        agg.occSum += parseFloat(d.occupancy_pct); agg.occCount++
        if (d.avg_price_configured !== 'sin precio') { agg.priceSum += parseFloat(d.avg_price_configured); agg.priceCount++ }
      }
      const weeks = [...byWeek.values()].sort((a, b) => a.week.localeCompare(b.week)).map(w => {
        const avgOccW   = w.occCount > 0 ? w.occSum / w.occCount : 0
        const avgPriceW = w.priceCount > 0 ? w.priceSum / w.priceCount : null
        const gapPct    = (!revenueBlocked && w.adr != null && avgPriceW != null && w.adr > 0)
          ? Math.round((avgPriceW - w.adr) / w.adr * 100) : null
        return {
          week: w.week,
          avg_occupancy: avgOccW.toFixed(0) + '%',
          avg_price_configured: avgPriceW != null ? avgPriceW.toFixed(2) + ' €' : 'sin precio',
          weekly_adr: revenueBlocked ? null : (w.adr != null ? w.adr.toFixed(2) + ' €' : 'sin ADR real todavía'),
          // % de diferencia del precio listado sobre el ADR real — positivo:
          // se está pidiendo más de lo que de verdad se cobra esa semana.
          price_vs_adr_gap_pct: gapPct,
        }
      })

      return {
        date_from, date_to, group: 'week',
        total_rooms: totalRooms,
        weeks,
        revenue_note: revenueBlocked ? REVENUE_BLOCKED_MSG : undefined,
      }
    }

    case 'get_booking_patterns': {
      const date_from = args.date_from ?? addDaysIso(today, -365)
      const date_to   = args.date_to   ?? today

      // Día de la semana más reservado (0=lun … 6=dom)
      const dowRows = await db.execute(drizzleSql`
        SELECT EXTRACT(ISODOW FROM check_in_date::date)::int - 1 AS dow,
               COUNT(*)::int AS reservations
        FROM reservations
        WHERE property_id = ${getPropertyId()}
          AND check_in_date BETWEEN ${date_from} AND ${date_to}
          AND status NOT IN ('cancelled', 'no_show')
        GROUP BY dow ORDER BY dow
      `) as unknown as { dow: number; reservations: number }[]

      const DOW_ES = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo']
      const byDow = dowRows.map(r => ({ day: DOW_ES[r.dow] ?? `Día ${r.dow}`, reservations: r.reservations }))

      // Mes más activo
      const monthRows = await db.execute(drizzleSql`
        SELECT TO_CHAR(check_in_date::date, 'YYYY-MM') AS month,
               COUNT(*)::int AS reservations,
               SUM(total::numeric)::numeric AS revenue
        FROM reservations
        WHERE property_id = ${getPropertyId()}
          AND check_in_date BETWEEN ${date_from} AND ${date_to}
          AND status NOT IN ('cancelled', 'no_show')
        GROUP BY month ORDER BY month
      `) as unknown as { month: string; reservations: number; revenue: string }[]

      // Lead time (días entre creación y check-in)
      const leadRows = await db.execute(drizzleSql`
        SELECT ROUND(AVG(check_in_date::date - created_at::date))::int AS avg_lead_days,
               MIN(check_in_date::date - created_at::date)::int AS min_lead,
               MAX(check_in_date::date - created_at::date)::int AS max_lead
        FROM reservations
        WHERE property_id = ${getPropertyId()}
          AND check_in_date BETWEEN ${date_from} AND ${date_to}
          AND status NOT IN ('cancelled', 'no_show')
          AND check_in_date::date >= created_at::date
      `) as unknown as { avg_lead_days: number; min_lead: number; max_lead: number }[]

      // Duraciones más frecuentes
      const nightRows = await db.execute(drizzleSql`
        SELECT nights, COUNT(*)::int AS cnt
        FROM reservations
        WHERE property_id = ${getPropertyId()}
          AND check_in_date BETWEEN ${date_from} AND ${date_to}
          AND status NOT IN ('cancelled', 'no_show')
          AND nights IS NOT NULL
        GROUP BY nights ORDER BY cnt DESC LIMIT 5
      `) as unknown as { nights: number; cnt: number }[]

      const busiest = [...byDow].sort((a, b) => b.reservations - a.reservations)[0]
      const busiestMonth = [...monthRows].sort((a, b) => b.reservations - a.reservations)[0]

      return {
        period: { date_from, date_to },
        by_day_of_week: byDow,
        busiest_day: busiest?.day ?? null,
        by_month: monthRows.map(m => ({ month: m.month, reservations: m.reservations, revenue: parseFloat(m.revenue ?? '0').toFixed(2) + ' €' })),
        busiest_month: busiestMonth?.month ?? null,
        lead_time: leadRows[0] ? {
          avg_days: leadRows[0].avg_lead_days,
          min_days: leadRows[0].min_lead,
          max_days: leadRows[0].max_lead,
        } : null,
        most_common_stay_lengths: nightRows.map(r => ({ nights: r.nights, reservations: r.cnt })),
      }
    }

    case 'get_channel_comparison': {
      if (isRevenueBlocked(ctx, args.date_from, args.date_to)) return { error: REVENUE_BLOCKED_MSG }
      const date_from = args.date_from
      const date_to   = args.date_to

      // Totales por canal (activas + canceladas por separado)
      const allRows = await db.execute(drizzleSql`
        SELECT
          bc.name                                     AS channel,
          COUNT(*)                                    AS total,
          COUNT(*) FILTER (WHERE r.status NOT IN ('cancelled','no_show')) AS active,
          COUNT(*) FILTER (WHERE r.status IN ('cancelled','no_show'))     AS cancelled,
          SUM(r.total::numeric) FILTER (WHERE r.status NOT IN ('cancelled','no_show')) AS revenue,
          AVG(r.total::numeric) FILTER (WHERE r.status NOT IN ('cancelled','no_show')) AS avg_price,
          AVG(r.nights)         FILTER (WHERE r.status NOT IN ('cancelled','no_show')) AS avg_nights
        FROM reservations r
        LEFT JOIN booking_channels bc ON bc.id = r.booking_channel_id
        WHERE r.property_id = ${getPropertyId()}
          ${date_from ? drizzleSql`AND r.check_in_date >= ${date_from}` : drizzleSql``}
          ${date_to   ? drizzleSql`AND r.check_in_date <= ${date_to}`   : drizzleSql``}
        GROUP BY bc.name
        ORDER BY active DESC
      `) as unknown as {
        channel: string | null; total: string; active: string; cancelled: string
        revenue: string | null; avg_price: string | null; avg_nights: string | null
      }[]

      const totalActive = allRows.reduce((s, r) => s + Number(r.active), 0)
      const totalRevenue = allRows.reduce((s, r) => s + parseFloat(r.revenue ?? '0'), 0)

      return allRows.map(r => {
        const active   = Number(r.active)
        const rev      = parseFloat(r.revenue ?? '0')
        const cancelRate = Number(r.total) > 0
          ? ((Number(r.cancelled) / Number(r.total)) * 100).toFixed(0) + '%'
          : '—'
        return {
          channel:        r.channel ?? 'Directo',
          reservations:   active,
          pct_reservations: totalActive > 0 ? ((active / totalActive) * 100).toFixed(0) + '%' : '—',
          revenue:        rev.toFixed(2) + ' €',
          pct_revenue:    totalRevenue > 0 ? ((rev / totalRevenue) * 100).toFixed(0) + '%' : '—',
          avg_price:      r.avg_price ? parseFloat(r.avg_price).toFixed(2) + ' €' : '—',
          avg_nights:     r.avg_nights ? parseFloat(r.avg_nights).toFixed(1) : '—',
          cancellation_rate: cancelRate,
        }
      })
    }

    case 'get_breakfast_inventory': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      try {
        const data = await poolControl.getBreakfastInventory(args.date)
        return { fecha: data.fecha, fecha_anterior: data.fecha_anterior, fechas_disponibles: data.fechas_disponibles, items: data.items }
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_breakfast_inventory_catalog': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      try {
        const data = await poolControl.getInventoryCatalog()
        return { categorias: data.categorias }
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_room_incidents': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      const status = args.status ?? 'pending'
      try {
        if (status === 'pending')  return { items: (await poolControl.getPendingIncidents()).items }
        if (status === 'resolved') return { items: (await poolControl.getResolvedIncidents()).items }
        const [pending, resolved] = await Promise.all([poolControl.getPendingIncidents(), poolControl.getResolvedIncidents()])
        return { items: [...pending.items, ...resolved.items] }
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_pool_supplies_level': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      if (!['gas', 'cloro'].includes(args.product)) return { error: 'product debe ser "gas" o "cloro"' }
      try {
        const data = args.product === 'gas' ? await poolControl.getGasLevel() : await poolControl.getChlorineLevel()
        return {
          producto:          args.product,
          ultimo_registro:   data.ultimo_registro,
          nivel_estimado:    data.nivel_estimado,
          consumo_dia:       data.consumo_dia,
          dias_restantes:    data.dias_restantes,
          historico_reciente: (data.historico ?? []).slice(-15),
        }
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_pool_water_readings': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      if (!['piscina', 'afc', 'acs'].includes(args.type)) return { error: 'type debe ser "piscina", "afc" o "acs"' }
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      try {
        const data = args.type === 'piscina' ? await poolControl.getPoolReadings()
          : args.type === 'afc' ? await poolControl.getColdWaterReadings()
          : await poolControl.getHotWaterReadings()
        const items: any[] = data.items ?? []
        return { type: args.type, total_registros: items.length, items: items.slice(0, limit) }
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_water_tank_status': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (!(await poolControl.isConfigured())) return { error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }
      const range = ['dia', 'semana', 'mes'].includes(args.range) ? args.range : 'semana'
      try {
        return await poolControl.getWaterTankStatus(range, args.year, args.month)
      } catch (e: any) { return { error: e.message } }
    }

    case 'get_alert_configs': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      const configs = await db.select().from(alertConfigs).where(eq(alertConfigs.propertyId, getPropertyId())).orderBy(alertConfigs.alertType)
      return { configs: configs.map(c => ({ alert_type: c.alertType, label: c.label, enabled: c.enabled })) }
    }

    case 'set_alert_enabled': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo para dirección.' }
      if (args.confirmed !== true) return { needs_confirmation: true, message: `¿Confirmas ${args.enabled ? 'activar' : 'desactivar'} la alerta "${args.alert_type}"?` }
      const existing = await db.query.alertConfigs.findFirst({ where: and(eq(alertConfigs.propertyId, getPropertyId()), eq(alertConfigs.alertType, args.alert_type)) })
      if (!existing) return { error: `Tipo de alerta desconocido: ${args.alert_type}` }
      await db.update(alertConfigs)
        .set({ enabled: args.enabled, updatedAt: new Date() })
        .where(and(eq(alertConfigs.propertyId, getPropertyId()), eq(alertConfigs.alertType, args.alert_type)))
      return { ok: true, alert_type: args.alert_type, enabled: args.enabled }
    }

    case 'set_sale_price': {
      const price = Number(args.price)
      if (!(price > 0)) return { error: 'El precio debe ser un número mayor que 0' }

      const dateFrom = args.date_from ?? args.date
      const dateTo   = args.date_to   ?? args.date
      if (!dateFrom || !dateTo) return { error: 'Falta la fecha: pasa date, o date_from/date_to' }
      if (dateTo < dateFrom) return { error: 'date_to no puede ser anterior a date_from' }

      const rootRateId = await getRootRateId()
      if (!rootRateId) return { error: 'No se encuentra la tarifa raíz configurada para este hotel (setting pricing.rootRateId).' }
      const rate = await db.query.rates.findFirst({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.id, rootRateId)) })
      if (!rate) return { error: 'No se encuentra la tarifa raíz de este hotel.' }
      if (rate.locked) return { error: `La tarifa "${rate.title}" está bloqueada — no se puede cambiar el precio.` }

      // Tipo de habitación por defecto: setting pricing.defaultRoomTypeId o, si el
      // hotel solo tiene un tipo no virtual, ese.
      const defRtId = await getSetting<number>('pricing.defaultRoomTypeId')
      const rtCandidates = await db.query.roomTypes.findMany({
        where: and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.active, true)),
      })
      const realTypes = rtCandidates.filter(t => !(t as any).isVirtual)
      const roomType = defRtId ? realTypes.find(t => t.id === Number(defRtId)) : (realTypes.length === 1 ? realTypes[0] : undefined)
      if (!roomType) return { error: 'No hay un tipo de habitación por defecto para cambiar precios (setting pricing.defaultRoomTypeId). Dile a dirección que lo configure.' }

      const dates: string[] = []
      for (const d = new Date(dateFrom + 'T12:00:00Z'); d.toISOString().slice(0, 10) <= dateTo; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10))
      }
      if (dates.length === 0) return { error: 'Rango de fechas vacío' }
      if (dates.length > 92) return { error: 'Rango demasiado amplio de una vez (máx. 92 días)' }

      if (!rate.baseRateId) {
        for (const d of dates) {
          const minPrice = await seasonMinPriceForDate(d)
          if (minPrice !== null && price < minPrice) {
            return { error: `${d}: precio (${price.toFixed(2)} €) inferior al mínimo de temporada (${minPrice.toFixed(2)} €)` }
          }
        }
      }

      const batchId = crypto.randomUUID()
      await Promise.all(dates.map(d =>
        upsertDailyPrice(rootRateId, d, price, undefined, roomType.id, { userId: ctx.userId, batchId }, rate.code)
      ))

      return {
        success: true, rate: rate.title, room_type: roomType.name,
        date_from: dates[0], date_to: dates.at(-1), days: dates.length, price_eur: price,
      }
    }

    case 'open_access_door': {
      const door = Number(args.door)
      if (!Number.isInteger(door) || door < 1 || door > 4) return { error: 'Número de puerta inválido — debe ser 1, 2, 3 o 4' }
      if (!(await isZktecoConfigured())) return { error: 'El control de accesos (ZKTeco) no está configurado en este servidor.' }
      try {
        await openDoor(door)
        return { success: true, message: `Puerta ${door} abierta` }
      } catch (e: any) {
        return { error: `No se pudo abrir la puerta ${door}: ${e.message}` }
      }
    }

    case 'navigate':
      return { view: args.view, id: args.id }

    case 'get_period_summary': {
      const { from, to } = args
      const revenueBlocked = isRevenueBlocked(ctx, from, to)
      const [arr, dep, nights, revenue, byChannel, totalRooms] = await Promise.all([
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), and(gte(reservations.checkInDate, from), lte(reservations.checkInDate, to), ne(reservations.status, 'cancelled')))),
        db.select({ count: count() }).from(reservations)
          .where(and(eq(reservations.propertyId, getPropertyId()), and(gte(reservations.checkOutDate, from), lte(reservations.checkOutDate, to), ne(reservations.status, 'cancelled')))),
        db.execute(drizzleSql`
          SELECT COALESCE(SUM(LEAST(check_out_date, (${to}::date + 1)) - GREATEST(check_in_date, ${from}::date)), 0)::int AS n
          FROM reservations
          WHERE property_id = ${getPropertyId()} AND status NOT IN ('cancelled','no_show') AND room_id IS NOT NULL
            AND check_in_date <= ${to}::date AND check_out_date > ${from}::date
        `) as unknown as Promise<{ n: number }[]>,
        // Igual que financial.ts (reports/summary, reports/payments) y el resumen de
        // hoy más abajo: los "movimientos de caja" (fondo de caja, ajustes, no son
        // ingresos reales) y los depósitos/preautorizaciones (deposit, deposit_cc,
        // aún no cobrados de verdad) se excluyen del ingreso "cobrado" del período.
        // Sin este filtro, un solo movimiento de caja grande con fecha en un mes de
        // baja actividad (ej. marzo) puede inflar el ingreso reportado hasta hacerlo
        // absurdo comparado con las pocas reservas reales de ese mes.
        db.select({ total: sum(financialTransactions.amount) }).from(financialTransactions)
          .where(and(eq(financialTransactions.propertyId, getPropertyId()), and(
            gte(financialTransactions.transactionDate, from),
            lte(financialTransactions.transactionDate, to),
            notInArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
            drizzleSql`${financialTransactions.category} IS DISTINCT FROM 'movimiento_caja'`,
          ))),
        db.execute(drizzleSql`
          SELECT COALESCE(bc.name, 'Sin canal') AS channel, COUNT(*)::int AS n
          FROM reservations r LEFT JOIN booking_channels bc ON bc.id = r.booking_channel_id
          WHERE r.property_id = ${getPropertyId()} AND r.check_in_date >= ${from}::date AND r.check_in_date <= ${to}::date AND r.status != 'cancelled'
          GROUP BY 1 ORDER BY 2 DESC LIMIT 3
        `) as unknown as Promise<{ channel: string; n: number }[]>,
        db.select({ count: count() }).from(rooms).where(and(eq(rooms.propertyId, getPropertyId()), eq(rooms.active, true))),
      ])
      const nDays     = Math.max(1, (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000 + 1)
      const soldNights = Number((nights as any)[0]?.n ?? 0)
      const roomCount  = Number(totalRooms[0]?.count ?? 1)
      return {
        period: { from, to },
        arrivals:        Number(arr[0]?.count ?? 0),
        departures:      Number(dep[0]?.count ?? 0),
        room_nights_sold: soldNights,
        occupancy_pct:   Math.round((soldNights / (roomCount * nDays)) * 100),
        revenue_collected_eur: revenueBlocked ? null : parseFloat(String(revenue[0]?.total ?? '0')),
        revenue_note: revenueBlocked ? REVENUE_BLOCKED_MSG : undefined,
        top_channels:    byChannel,
      }
    }

    case 'get_occupancy_report': {
      const { from, to } = args
      const group = args.group ?? 'month'
      const includeCancelled = !!args.include_cancelled
      const revenueBlocked = isRevenueBlocked(ctx)
      const { data, totals, meta } = await computeOccupancyReport({ from, to, group, includeCancelled })

      // Los importes son "facturación total" (dirección) — igual que en el resto
      // de tools financieros, se ocultan para el resto de roles pero la ocupación
      // (no monetaria) se mantiene visible.
      const stripRevenue = <T extends { revenue: number; adr: number; revpar: number }>(row: T) =>
        revenueBlocked ? { ...row, revenue: null, adr: null, revpar: null } : row

      const MAX_ROWS = 60
      const truncated = data.length > MAX_ROWS
      return {
        group,
        include_cancelled: includeCancelled,
        totals: stripRevenue(totals),
        breakdown: (truncated ? data.slice(0, MAX_ROWS) : data).map(stripRevenue),
        breakdown_note: truncated
          ? `Desglose truncado a ${MAX_ROWS} de ${data.length} períodos — usa un group más amplio (month/year) o pide un rango más corto si necesitas el detalle completo. \`totals\` sí cubre todo el rango pedido.`
          : undefined,
        total_rooms: meta.totalRooms,
        revenue_note: revenueBlocked ? REVENUE_BLOCKED_MSG : undefined,
      }
    }

    case 'get_transactions': {
      if (isRevenueBlocked(ctx)) return { error: REVENUE_BLOCKED_MSG }
      const { from, to, method, reservation_id, channel } = args
      const conds: any[] = [gte(financialTransactions.transactionDate, from), lte(financialTransactions.transactionDate, to)]
      if (method)         conds.push(eq(financialTransactions.paymentMethod, method))
      if (reservation_id) conds.push(eq(financialTransactions.reservationId, reservation_id))
      if (channel) {
        conds.push(drizzleSql`${financialTransactions.reservationId} IN (
          SELECT r.id FROM reservations r
          JOIN booking_channels bc ON bc.id = r.booking_channel_id
          WHERE bc.name ILIKE ${`%${channel}%`}
        )`)
      }
      const [txs, totalRow] = await Promise.all([
        db.query.financialTransactions.findMany({
          where: and(eq(financialTransactions.propertyId, getPropertyId()), and(...conds)), limit: 50, orderBy: desc(financialTransactions.transactionDate),
          with: { reservation: { columns: { id: true }, with: {
            guest: { columns: { firstName: true, lastName: true } },
            bookingChannel: { columns: { name: true } },
          } } },
        }),
        db.select({ total: sum(financialTransactions.amount), n: count() }).from(financialTransactions).where(and(eq(financialTransactions.propertyId, getPropertyId()), and(...conds))),
      ])
      return {
        count: Number(totalRow[0]?.n ?? 0),
        total_eur: parseFloat(String(totalRow[0]?.total ?? '0')),
        transactions: txs.map(t => ({
          id: t.id, date: t.transactionDate, amount: t.amount, method: t.paymentMethod,
          description: t.description,
          guest: (t as any).reservation?.guest ? `${(t as any).reservation.guest.firstName} ${(t as any).reservation.guest.lastName}` : null,
          channel: (t as any).reservation?.bookingChannel?.name ?? null,
          reservation_id: t.reservationId,
        })),
        note: txs.length === 50 ? 'Lista truncada a 50 — el total sí incluye todo el período' : undefined,
      }
    }

    case 'get_daily_cash': {
      const date = args.date ?? today
      const blocked = isRevenueBlocked(ctx)
      if (blocked) return { date, total_eur: null, breakdown: [], revenue_note: REVENUE_BLOCKED_MSG }
      // Excluye depósitos ('deposit'/'deposit_cc') — no son un cobro de la
      // estancia, son dinero retenido que puede devolverse; se gestionan y
      // reportan aparte (pestaña Depósitos), igual que en el resto de la app.
      // Excluye también 'split_transfer' — traspaso interno entre una
      // reserva partida y su continuación (ver POST /reservations/:id/split),
      // no es dinero nuevo cobrado ese día (neta cero: una entrada negativa
      // y otra positiva del mismo importe, mismo día).
      const rows = await db.execute(drizzleSql`
        SELECT ft.payment_method AS method, COALESCE(fa.name, 'Sin caja') AS account,
               SUM(ft.amount)::numeric(10,2) AS total, COUNT(*)::int AS n
        FROM financial_transactions ft
        LEFT JOIN financial_accounts fa ON fa.id = ft.financial_account_id
        WHERE ft.property_id = ${getPropertyId()}
          AND ft.transaction_date = ${date}::date
          AND ft.payment_method NOT IN ('deposit', 'deposit_cc', 'split_transfer')
        GROUP BY 1, 2 ORDER BY 3 DESC
      `) as unknown as { method: string; account: string; total: string; n: number }[]
      const total = rows.reduce((s, r) => s + parseFloat(r.total), 0)
      return { date, total_eur: Math.round(total * 100) / 100, breakdown: rows }
    }

    case 'get_invoices': {
      if (isRevenueBlocked(ctx)) return { error: REVENUE_BLOCKED_MSG }
      const { from, to } = args
      const rows = await db.query.invoices.findMany({
        where: and(eq(invoices.propertyId, getPropertyId()), and(gte(invoices.issuedAt, from), lte(invoices.issuedAt, to))),
        limit: 50, orderBy: desc(invoices.issuedAt),
      })
      return {
        count: rows.length,
        invoices: rows.map((i: any) => ({
          number: i.invoiceNumber, date: i.issuedAt, total: i.total,
          billing_name: i.billingName ?? null, reservation_id: i.reservationId,
        })),
      }
    }

    case 'get_invoice_anomalies': {
      if (isRevenueBlocked(ctx)) return { error: REVENUE_BLOCKED_MSG }

      const from = typeof args.from === 'string' ? args.from : undefined
      const to   = typeof args.to   === 'string' ? args.to   : undefined

      const cfg  = await getInvoiceConfig()
      // SIEMPRE se leen TODAS las facturas (sin limit) — from/to solo acotan
      // qué se reporta en duplicados y facturas a 0€, nunca cuántas filas se
      // examinan. Los huecos de numeración necesitan la secuencia completa
      // para ser correctos, así que esos se calculan siempre sobre el total.
      const rows = await db.select({
        id:            invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        issuedAt:      invoices.issuedAt,
        total:         invoices.total,
        reservationId: invoices.reservationId,
        billingName:   invoices.billingName,
      }).from(invoices).where(eq(invoices.propertyId, getPropertyId())).orderBy(invoices.issuedAt)

      const inPeriod = (d: string) => (!from || d >= from) && (!to || d <= to)
      const scopedRows = (from || to) ? rows.filter(r => inPeriod(r.issuedAt)) : rows

      // ── Duplicados: mismo número de factura en más de una fila (acotado a from/to si se dio) ──
      const byNumber = new Map<string, typeof rows>()
      for (const row of scopedRows) {
        const list = byNumber.get(row.invoiceNumber)
        if (list) list.push(row); else byNumber.set(row.invoiceNumber, [row])
      }
      const allDuplicates = [...byNumber.entries()]
        .filter(([, list]) => list.length > 1)
        .map(([number, list]) => ({
          invoice_number: number,
          count:          list.length,
          entries:        list.map(r => ({ id: r.id, date: r.issuedAt, total: r.total, reservation_id: r.reservationId, billing_name: r.billingName ?? null })),
        }))

      // ── Huecos: números que faltan en la secuencia (SIEMPRE sobre el histórico completo) ──
      const parsed = rows
        .map(r => ({ ...r, n: extractNumber(cfg.numberFormat, r.invoiceNumber) }))
        .filter(r => r.n > 0)
        .sort((a, b) => a.n - b.n)
      const allMissing: { n: number; after_invoice: string; after_date: string; before_invoice: string; before_date: string; in_requested_period?: boolean }[] = []
      for (let i = 1; i < parsed.length; i++) {
        const prev = parsed[i - 1]!, cur = parsed[i]!
        for (let n = prev.n + 1; n < cur.n; n++) {
          allMissing.push({
            n, after_invoice: prev.invoiceNumber, after_date: prev.issuedAt,
            before_invoice: cur.invoiceNumber, before_date: cur.issuedAt,
            ...((from || to) ? { in_requested_period: prev.issuedAt <= (to ?? '9999-12-31') && cur.issuedAt >= (from ?? '0000-01-01') } : {}),
          })
        }
      }

      // ── Facturas a 0 € (acotado a from/to si se dio) ─────────────────────────
      const allZero = scopedRows
        .filter(r => parseFloat(r.total) === 0)
        .map(r => ({ id: r.id, invoice_number: r.invoiceNumber, date: r.issuedAt, reservation_id: r.reservationId, billing_name: r.billingName ?? null }))

      const CAP = 50
      return {
        period:                 (from || to) ? { from: from ?? null, to: to ?? null } : null,
        total_invoices:         rows.length,
        total_invoices_in_period: (from || to) ? scopedRows.length : undefined,
        duplicates_count:       allDuplicates.length,
        duplicates:             allDuplicates.slice(0, CAP),
        missing_numbers_count:  allMissing.length,
        missing_numbers:        allMissing.slice(0, CAP),
        zero_amount_count:      allZero.length,
        zero_amount:            allZero.slice(0, CAP),
        note: allDuplicates.length > CAP || allMissing.length > CAP || allZero.length > CAP
          ? `Alguna lista supera ${CAP} resultados y se ha recortado — usa los *_count para el total real.`
          : undefined,
      }
    }

    case 'get_housekeeping_status': {
      const date = args.date ?? today
      const tasks = await db.execute(drizzleSql`
        SELECT ht.id, r.code AS room, ht.task_type, ht.status, ht.dnd, ht.linen_changes,
               ht.notes, COALESCE(u.first_name || ' ' || u.last_name, 'Sin asignar') AS assigned_to
        FROM housekeeping_tasks ht
        JOIN rooms r ON r.id = ht.room_id
        JOIN room_types rt ON rt.id = r.room_type_id
        LEFT JOIN users u ON u.id = ht.assigned_to
        WHERE ht.property_id = ${getPropertyId()}
          AND ht.date = ${date}
          AND rt.is_virtual = false
        ORDER BY r.code
      `) as unknown as any[]
      const pending = tasks.filter(t => t.status === 'pending').length
      const done    = tasks.filter(t => t.status === 'done').length
      return { date, total: tasks.length, pending, done, tasks }
    }

    case 'get_breakfast_summary': {
      const dateFrom = args.date_from ?? today
      const dateTo   = args.date_to   ?? dateFrom
      const days: string[] = []
      for (let d = new Date(dateFrom); d <= new Date(dateTo); d.setDate(d.getDate() + 1)) {
        days.push(d.toISOString().slice(0, 10))
      }
      if (days.length === 0) return { error: 'Rango de fechas inválido (date_to anterior a date_from)' }
      if (days.length > 31) return { error: 'Rango máximo: 31 días. Pide un rango más corto.' }

      const perDay: any[] = []
      for (const date of days) {
        const rateRows = await db.execute(drizzleSql`
          SELECT r.people AS people, EXISTS (
            SELECT 1 FROM breakfast_logs bl
            WHERE bl.reservation_id = r.id AND bl.date = ${date}::date AND bl.extra_id IS NULL
          ) AS served
          FROM reservations r
          JOIN rates rt ON rt.id = r.rate_id
          WHERE r.property_id = ${getPropertyId()}
            AND r.status NOT IN ('cancelled', 'no_show')
            AND r.check_in_date  < ${date}::date
            AND r.check_out_date >= ${date}::date
            AND (rt.title ILIKE '%HD%' OR rt.title ILIKE '%HyD%' OR rt.title ILIKE '%desayuno%')
        `) as unknown as { people: number; served: boolean }[]

        const extraRows = await db.execute(drizzleSql`
          SELECT rsi.quantity, r.people AS people,
            (SELECT COUNT(*) FROM breakfast_logs bl WHERE bl.extra_id = rsi.id) AS times_served,
            EXISTS (
              SELECT 1 FROM breakfast_logs bl
              WHERE bl.reservation_id = rsi.reservation_id AND bl.date = ${date}::date AND bl.extra_id = rsi.id
            ) AS served
          FROM reservation_sale_items rsi
          JOIN reservations r ON r.id = rsi.reservation_id
          JOIN sale_items si ON si.id = rsi.sale_item_id
          WHERE r.property_id = ${getPropertyId()}
            AND r.status NOT IN ('cancelled', 'no_show')
            AND r.check_in_date  <= ${date}::date
            AND r.check_out_date >= ${date}::date
            AND si.title ILIKE '%desayuno%'
        `) as unknown as { quantity: number; people: number; times_served: number; served: boolean }[]

        const extrasActive = extraRows
          .map(e => ({ ...e, remaining: Math.max(0, e.quantity - Number(e.times_served) * Math.max(1, Number(e.people))) }))
          .filter(e => e.remaining > 0 || e.served)

        const rateTotal  = rateRows.reduce((s, r) => s + (r.people ?? 1), 0)
        const extraTotal = extrasActive.reduce((s, e) => s + e.remaining, 0)
        const noServiceRow = await db.query.breakfastNoService.findFirst({ where: and(eq(breakfastNoService.propertyId, getPropertyId()), eq(breakfastNoService.date, date)) })

        perDay.push({
          date,
          total_breakfasts:      rateTotal + extraTotal,
          from_rate:             rateTotal,
          from_extras:           extraTotal,
          served:                rateRows.filter(r => r.served).length + extrasActive.filter(e => e.served).length,
          pending:               rateRows.filter(r => !r.served).length + extrasActive.filter(e => !e.served).length,
          no_service_marked:     !!noServiceRow,
        })
      }

      const totalBreakfasts = perDay.reduce((s, d) => s + d.total_breakfasts, 0)
      return {
        date_from: dateFrom, date_to: dateTo,
        days: perDay,
        totals: {
          total_breakfasts: totalBreakfasts,
          avg_per_day:       Math.round((totalBreakfasts / perDay.length) * 10) / 10,
          days_no_service:   perDay.filter(d => d.no_service_marked).length,
        },
      }
    }

    case 'get_staff_ai_activity': {
      if (!ctx.roles.includes('direccion')) {
        return { error: 'Permiso denegado: solo dirección puede ver la actividad del asistente de otros usuarios.' }
      }
      const dateFrom = zonedToUtc(String(args.date_from ?? today), 0, tz)
      const dateTo   = zonedToUtc(addDaysIso(String(args.date_to ?? today), 1), 0, tz) // inclusivo hasta el final del día

      const rows = await db.select({
        userId:    aiChatMessages.userId,
        role:      aiChatMessages.role,
        content:   aiChatMessages.content,
        createdAt: aiChatMessages.createdAt,
        firstName: users.firstName,
        lastName:  users.lastName,
      })
        .from(aiChatMessages)
        .innerJoin(users, eq(aiChatMessages.userId, users.id))
        .where(and(
          eq(users.propertyId, getPropertyId()),
          gte(aiChatMessages.createdAt, dateFrom), lte(aiChatMessages.createdAt, dateTo),
          eq(aiChatMessages.source, 'chat'), // fuera conversaciones de prueba en AI Debug
        ))
        .orderBy(aiChatMessages.userId, aiChatMessages.createdAt)
        .limit(300)

      const filtered = args.user_name
        ? rows.filter(r => `${r.firstName} ${r.lastName}`.toLowerCase().includes(String(args.user_name).toLowerCase()))
        : rows

      if (!filtered.length) return { message: 'No hay conversaciones registradas en ese rango de fechas.' }

      return filtered.map(r => ({
        user: `${r.firstName} ${r.lastName}`,
        role: r.role,
        content: r.content,
        at: r.createdAt,
      }))
    }

    case 'set_dashboard_background': {
      if (!ctx.userId) return { error: 'No se pudo identificar al usuario actual' }
      if (!(await isPexelsConfigured())) return { error: 'La búsqueda de fotos no está configurada (falta PEXELS_API_KEY)' }
      const photo = await searchPlacePhoto(String(args.place))
      if (!photo) return { error: `No se encontró ninguna foto para "${args.place}"` }
      await db.insert(userPreferences)
        .values({ userId: ctx.userId, dashboardBgUrl: photo.url, dashboardBgCredit: photo.credit, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { dashboardBgUrl: photo.url, dashboardBgCredit: photo.credit, updatedAt: new Date() },
        })
      return { ok: true, message: `Fondo actualizado con una foto de "${args.place}" (${photo.credit})` }
    }

    case 'clear_dashboard_background': {
      if (!ctx.userId) return { error: 'No se pudo identificar al usuario actual' }
      await db.update(userPreferences)
        .set({ dashboardBgUrl: null, dashboardBgCredit: null, updatedAt: new Date() })
        .where(eq(userPreferences.userId, ctx.userId))
      return { ok: true, message: 'Fondo eliminado, vuelve a ser el de por defecto' }
    }

    case 'set_user_dashboard_background': {
      if (!ctx.roles.includes('direccion')) {
        return { error: 'Permiso denegado: solo dirección puede cambiar el fondo de otro usuario.' }
      }
      const target = await findStaffUserByName(String(args.user_name))
      if (!target) return { error: `No se encontró a ningún miembro del equipo llamado "${args.user_name}"` }
      if (!(await isPexelsConfigured())) return { error: 'La búsqueda de fotos no está configurada (falta PEXELS_API_KEY)' }
      const photo = await searchPlacePhoto(String(args.place))
      if (!photo) return { error: `No se encontró ninguna foto para "${args.place}"` }
      await db.insert(userPreferences)
        .values({ userId: target.id, dashboardBgUrl: photo.url, dashboardBgCredit: photo.credit, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: userPreferences.userId,
          set: { dashboardBgUrl: photo.url, dashboardBgCredit: photo.credit, updatedAt: new Date() },
        })
      return { ok: true, message: `Fondo de ${target.firstName} ${target.lastName} actualizado con una foto de "${args.place}" (${photo.credit})` }
    }

    case 'send_staff_message': {
      if (!ctx.userId) return { error: 'No se pudo identificar al usuario actual' }
      const target = await findStaffUserByName(String(args.user_name))
      if (!target) return { error: `No se encontró a ningún miembro del equipo llamado "${args.user_name}"` }
      if (target.id === ctx.userId) return { error: 'No puedes enviarte un mensaje a ti mismo' }
      const important = !!args.important
      await db.insert(staffMessages).values({
        fromUserId: ctx.userId, toUserId: target.id, message: String(args.message), important,
      })
      return { ok: true, message: important
        ? `Mensaje URGENTE guardado para ${target.firstName} ${target.lastName} — le saldrá un aviso a pantalla completa que tiene que confirmar antes de poder seguir usando el sistema`
        : `Mensaje guardado para ${target.firstName} ${target.lastName} — se lo transmitiré la próxima vez que hable conmigo` }
    }

    case 'broadcast_staff_message': {
      if (!ctx.userId) return { error: 'No se pudo identificar al usuario actual' }
      const staff = await db.query.users.findMany({
        where: and(eq(users.propertyId, getPropertyId()), and(eq(users.active, true), ne(users.id, ctx.userId))),
        columns: { id: true },
      })
      if (staff.length === 0) return { error: 'No hay otros miembros del equipo activos a los que avisar' }
      const important = !!args.important
      await db.insert(staffMessages).values(
        staff.map(u => ({ fromUserId: ctx.userId!, toUserId: u.id, message: String(args.message), important })),
      )
      return { ok: true, message: important
        ? `Mensaje URGENTE guardado para ${staff.length} miembro(s) del equipo — a cada uno le saldrá un aviso a pantalla completa que tiene que confirmar`
        : `Mensaje guardado para ${staff.length} miembro(s) del equipo — se lo transmitiré a cada uno la próxima vez que hable conmigo` }
    }

    case 'create_scheduled_task': {
      if (!ctx.userId) return { error: 'No se pudo identificar al usuario actual' }
      const intervalDays = Math.round(Number(args.interval_days))
      if (!Number.isFinite(intervalDays) || intervalDays < 1) return { error: 'interval_days debe ser un número entero ≥ 1' }
      const start = String(args.time_window_start ?? '09:00')
      const end   = String(args.time_window_end   ?? '20:00')
      const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/
      if (!HHMM.test(start) || !HHMM.test(end)) return { error: 'time_window_start / time_window_end deben tener formato HH:MM' }
      if (start >= end) return { error: 'time_window_start debe ser anterior a time_window_end' }
      if (!String(args.prompt ?? '').trim()) return { error: 'Falta prompt' }

      const nextRunAt = scheduleNextRun(new Date(), intervalDays, start, end, tz)
      const [task] = await db.insert(aiScheduledTasks).values({
        createdBy: ctx.userId, prompt: String(args.prompt).trim(),
        intervalDays, timeWindowStart: start, timeWindowEnd: end,
        nextRunAt,
      }).returning()
      return {
        ok: true, task_id: task!.id,
        message: `Tarea programada creada (cada ${intervalDays} día(s), entre ${start} y ${end}). Próxima ejecución: `
          + nextRunAt.toLocaleString('es-ES', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }),
      }
    }

    case 'list_scheduled_tasks': {
      if (!ctx.roles.includes('direccion')) return { error: 'Permiso denegado: solo dirección puede ver las tareas programadas.' }
      const list = await db.select().from(aiScheduledTasks).where(inArray(aiScheduledTasks.createdBy, tenantUserIds())).orderBy(desc(aiScheduledTasks.createdAt))
      return {
        tasks: list.map(t => ({
          id: t.id, prompt: t.prompt, interval_days: t.intervalDays,
          time_window: `${t.timeWindowStart}-${t.timeWindowEnd}`, active: t.active,
          next_run_at: t.nextRunAt, last_run_at: t.lastRunAt,
          last_result: t.lastResult, last_error: t.lastError,
        })),
      }
    }

    case 'set_scheduled_task_active': {
      const task = await db.query.aiScheduledTasks.findFirst({ where: and(eq(aiScheduledTasks.id, args.task_id), inArray(aiScheduledTasks.createdBy, tenantUserIds())) })
      if (!task) return { error: `No existe ninguna tarea programada con id ${args.task_id}` }
      await db.update(aiScheduledTasks).set({ active: Boolean(args.active) }).where(eq(aiScheduledTasks.id, task.id))
      return { ok: true, message: `Tarea ${task.id} ${args.active ? 'activada' : 'pausada'}` }
    }

    case 'delete_scheduled_task': {
      const task = await db.query.aiScheduledTasks.findFirst({ where: and(eq(aiScheduledTasks.id, args.task_id), inArray(aiScheduledTasks.createdBy, tenantUserIds())) })
      if (!task) return { error: `No existe ninguna tarea programada con id ${args.task_id}` }
      await db.delete(aiScheduledTasks).where(eq(aiScheduledTasks.id, task.id))
      return { ok: true, message: `Tarea ${task.id} eliminada` }
    }

    case 'update_guest_rating': {
      const raw = Number(args.rating)
      if (!Number.isFinite(raw)) return { error: 'La valoración debe ser un número' }
      // Tolerante con escalas equivocadas (ej. el usuario dice "8/10"): se reescala a 1-5 en vez de rechazarla.
      const rating = Math.max(1, Math.min(5, Math.round(raw > 5 ? raw / 2 : raw)))
      const guestId = Number(args.guest_id)
      if (!Number.isInteger(guestId)) {
        return { error: 'guest_id debe ser el ID numérico del huésped devuelto por search_guests, no su nombre. Llama primero a search_guests para obtenerlo.' }
      }
      const g = await db.query.guests.findFirst({ where: and(eq(guests.propertyId, getPropertyId()), eq(guests.id, guestId)), columns: { id: true, firstName: true, lastName: true } })
      if (!g) return { error: `Huésped ${guestId} no encontrado` }
      await db.update(guests).set({ guestRating: rating, updatedAt: new Date() } as any).where(and(eq(guests.propertyId, getPropertyId()), eq(guests.id, g.id)))
      return {
        ok: true,
        message: `Valoración de ${g.firstName} ${g.lastName} actualizada a ${rating}/5${args.note ? ` — motivo: ${args.note}` : ''}`,
      }
    }

    case 'add_reservation_note': {
      const res = await db.query.reservations.findFirst({ where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)), columns: { id: true } })
      if (!res) return { error: `Reserva ${args.reservation_id} no encontrada` }
      await db.insert(reservationNotes).values({
        reservationId: args.reservation_id,
        authorId:      ctx.userId ?? null,
        note:          `[IA] ${args.note}`,
        type:          'note',
      })
      return { ok: true, message: `Nota añadida a la reserva ${args.reservation_id}` }
    }

    case 'add_payment': {
      if (!(args.amount > 0) || args.amount > 10000) return { error: 'Importe inválido (debe ser entre 0 y 10.000 €)' }
      const res = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        columns: { id: true, propertyId: true, currencyId: true, amountPaid: true },
      })
      if (!res) return { error: `Reserva ${args.reservation_id} no encontrada` }
      const account = await db.query.financialAccounts.findFirst({
        where: eq(financialAccounts.propertyId, getPropertyId()),
      })
      await db.insert(financialTransactions).values({
        propertyId:         getPropertyId(),
        reservationId:      res.id,
        financialAccountId: account?.id ?? null,
        amount:             args.amount.toFixed(2),
        currencyId:         res.currencyId,
        paymentMethod:      args.method,
        description:        args.description ?? `Pago registrado por IA`,
        transactionDate:    today,
        createdBy:          ctx.userId ?? null,
      } as any)
      const newPaid = (parseFloat(String(res.amountPaid)) + args.amount).toFixed(2)
      await db.update(reservations).set({ amountPaid: newPaid, updatedAt: new Date() } as any).where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, res.id)))
      await syncAutoInvoice(res.id, ctx.userId)
      return { ok: true, message: `Pago de ${args.amount.toFixed(2)} € (${args.method}) registrado en la reserva ${res.id}. Total pagado: ${newPaid} €` }
    }

    case 'cancel_reservation': {
      const res = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        with: { guest: { columns: { firstName: true, lastName: true } } },
      })
      if (!res) return { error: `Reserva ${args.reservation_id} no encontrada` }
      if (res.status === 'cancelled') return { error: 'La reserva ya está cancelada' }
      if (res.status === 'checked_out') return { error: 'No se puede cancelar una reserva con check-out hecho' }
      await db.update(reservations)
        .set({ previousStatus: res.status, status: 'cancelled', updatedAt: new Date() } as any)
        .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, res.id)))
      await logStatusChange(res.id, res.status, 'cancelled', 'ai_agent', ctx.userId ?? null).catch(() => {})
      return { ok: true, message: `Reserva ${res.id} de ${(res.guest as any)?.firstName} ${(res.guest as any)?.lastName} cancelada` }
    }

    case 'create_reservation': {
      const { first_name, last_name, check_in, check_out, people, email, phone, total } = args
      if (check_in >= check_out) return { error: 'La fecha de salida debe ser posterior a la de entrada' }
      const nights = Math.round((new Date(check_out).getTime() - new Date(check_in).getTime()) / 86_400_000)

      let guest = email
        ? await db.query.guests.findFirst({ where: and(eq(guests.propertyId, getPropertyId()), eq(guests.email, email)) })
        : null
      if (!guest) {
        const [g] = await db.insert(guests).values({
          propertyId: getPropertyId(), firstName: first_name, lastName: last_name,
          email: email ?? null, phone: phone ?? null,
        } as any).returning()
        guest = g
      }
      const [created] = await db.insert(reservations).values({
        propertyId: getPropertyId(), guestId: guest!.id, status: 'tentative',
        checkInDate: check_in, checkOutDate: check_out,
        nights: nights as any, people: people as any,
        currencyId: 1, total: (total ?? 0).toFixed(2), amountPaid: '0',
        source: 'ai_agent', createdBy: ctx.userId ?? null,
      } as any).returning({ id: reservations.id })
      return {
        ok: true,
        message: `Reserva ${created!.id} creada en estado tentative para ${first_name} ${last_name}, ${check_in} → ${check_out} (${people} pers.). Falta asignar habitación desde el planning.`,
        reservation_id: created!.id,
      }
    }

    case 'set_housekeeping_done': {
      const task = await db.query.housekeepingTasks.findFirst({ where: and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.id, args.task_id)) })
      if (!task) return { error: `Tarea ${args.task_id} no encontrada` }
      await db.update(housekeepingTasks)
        .set(args.done
          ? { status: 'done', completedAt: new Date(), completedBy: ctx.userId ?? null, updatedAt: new Date() }
          : { status: 'pending', completedAt: null, completedBy: null, updatedAt: new Date() })
        .where(and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.id, args.task_id)))
      return { ok: true, message: `Tarea ${args.task_id} marcada como ${args.done ? 'hecha' : 'pendiente'}` }
    }

    case 'assign_room': {
      const room = await db.query.rooms.findFirst({
        where: and(eq(rooms.propertyId, getPropertyId()), and(ilike(rooms.code, args.room_code), eq(rooms.active, true))),
        with: { roomType: true },
      })
      if (!room) return { error: `Habitación "${args.room_code}" no encontrada o no activa` }
      const r = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        with: { guest: { columns: { firstName: true, lastName: true } }, room: { with: { roomType: true } } },
      })
      if (!r) return { error: 'Reserva no encontrada' }
      if (!['tentative', 'confirmed', 'arriving', 'checked_in'].includes(r.status)) {
        return { error: `No se puede asignar habitación en estado ${r.status}` }
      }
      const conflict = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), and(
          eq(reservations.roomId, room.id),
          lte(reservations.checkInDate, r.checkOutDate),
          gte(reservations.checkOutDate, r.checkInDate),
          or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative'),
             eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out')),
          ne(reservations.id, r.id),
        )),
        columns: { id: true, checkInDate: true },
      })
      if (conflict) return { error: `La habitación ${room.code} ya está ocupada en esas fechas (reserva ${conflict.id}, desde ${conflict.checkInDate})` }
      // Mismo requisito que el cambio de habitación desde la web (ver PATCH
      // /reservations/:id): huésped ya en casa, o tipo destino virtual →
      // motivo de al menos 5 palabras reales, que queda en el historial.
      const targetIsVirtual = !!(room as any).roomType?.isVirtual
      const needsReason = r.status === 'checked_in' || targetIsVirtual
      if (needsReason && !hasMinWords(args.reason, 5)) {
        const why = r.status === 'checked_in' && targetIsVirtual ? 'el huésped ya está en casa y el tipo destino es virtual'
          : r.status === 'checked_in' ? 'el huésped ya está en casa' : 'el tipo destino es virtual'
        return { error: `Este cambio necesita reason con al menos 5 palabras (${why})` }
      }
      const oldRoom = r.room as any
      await db.update(reservations).set({ roomId: room.id, updatedAt: new Date() } as any).where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, r.id)))
      const changeLines = [`Habitación: ${oldRoom?.code ?? '—'} → ${room.code}`]
      if (oldRoom?.roomTypeId !== room.roomTypeId) {
        changeLines.push(`Tipo: ${oldRoom?.roomType?.name ?? '—'} → ${(room as any).roomType?.name ?? '—'}`)
      }
      if (args.reason && hasMinWords(args.reason, 1)) changeLines.push(`Motivo del cambio de habitación: ${args.reason}`)
      await db.insert(reservationNotes).values({ reservationId: r.id, authorId: ctx.userId ?? null, note: changeLines.join('\n'), type: 'change' })
      const g = r.guest as any
      return { success: true, message: `Habitación ${room.code} asignada a la reserva ${r.id} (${g?.firstName ?? ''} ${g?.lastName ?? ''})`.trim() }
    }

    case 'calc_rate_quote': {
      if (args.check_out <= args.check_in) return { error: 'La fecha de salida debe ser posterior a la de entrada' }

      // Resolver tarifa: por id o por nombre (parcial, insensible a mayúsculas)
      let rate: typeof rates.$inferSelect | undefined
      if (args.rate_id) {
        rate = await db.query.rates.findFirst({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.id, args.rate_id)) })
        if (!rate) return { error: `No existe ninguna tarifa con id ${args.rate_id}` }
      } else if (args.rate_name) {
        const matches = await db.query.rates.findMany({ where: and(eq(rates.propertyId, getPropertyId()), ilike(rates.title, `%${args.rate_name}%`)) })
        if (matches.length === 0) {
          const all = await db.query.rates.findMany({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.active, true)), columns: { id: true, title: true } })
          return { error: `Ninguna tarifa coincide con "${args.rate_name}"`, available_rates: all }
        }
        if (matches.length > 1) {
          return { error: `Varias tarifas coinciden con "${args.rate_name}" — indica cuál con rate_id`, matches: matches.map(m => ({ id: m.id, title: m.title })) }
        }
        rate = matches[0]!
      } else {
        return { error: 'Falta rate_id o rate_name' }
      }

      // Resolver tipo de habitación: por id o por nombre (admite singular/plural)
      let roomType: typeof roomTypes.$inferSelect | undefined
      if (args.room_type_id) {
        roomType = await db.query.roomTypes.findFirst({ where: and(eq(roomTypes.propertyId, getPropertyId()), eq(roomTypes.id, args.room_type_id)) })
        if (!roomType) return { error: `No existe ningún tipo de habitación con id ${args.room_type_id}` }
      } else if (args.room_type_name) {
        const term = String(args.room_type_name).trim().replace(/s$/i, '')   // "dobles" → "doble"
        const matches = await db.query.roomTypes.findMany({ where: and(eq(roomTypes.propertyId, getPropertyId()), ilike(roomTypes.name, `%${term}%`)) })
        if (matches.length === 0) {
          const all = await db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, getPropertyId()), columns: { id: true, name: true } })
          return { error: `Ningún tipo de habitación coincide con "${args.room_type_name}"`, available_room_types: all }
        }
        if (matches.length > 1) {
          return { error: `Varios tipos de habitación coinciden con "${args.room_type_name}" — indica cuál con room_type_id`, matches: matches.map(m => ({ id: m.id, name: m.name })) }
        }
        roomType = matches[0]!
      } else {
        return { error: 'Falta room_type_id o room_type_name' }
      }

      const quantity = Math.max(1, Math.round(Number(args.quantity ?? 1)))

      const [allRates, allRoomTypes] = await Promise.all([db.query.rates.findMany({ where: eq(rates.propertyId, getPropertyId()) }), db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, getPropertyId()) })])
      const ratesById     = new Map(allRates.map(rt => [rt.id, rt]))
      const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
      const rateIds     = rateChainIds(rate, ratesById)
      const roomTypeIds = roomTypeChainIds(roomType, roomTypesById)

      const nights: string[] = []
      const cur = new Date(args.check_in)
      const end = new Date(args.check_out)
      while (cur < end) { nights.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }

      const priceRows = await db.select({
        date: rateDailyPrices.date, price: rateDailyPrices.price,
        rateId: rateDailyPrices.rateId, roomTypeId: rateDailyPrices.roomTypeId,
      }).from(rateDailyPrices).where(and(eq(rateDailyPrices.propertyId, getPropertyId()), and(
        inArray(rateDailyPrices.rateId, rateIds),
        gte(rateDailyPrices.date, args.check_in),
        lte(rateDailyPrices.date, nights.at(-1)!),
        or(inArray(rateDailyPrices.roomTypeId, roomTypeIds), isNull(rateDailyPrices.roomTypeId)),
      )))

      const occupancy = roomType.maxOccupancy ?? 2
      const breakdown = nights.map(d => {
        const price = resolvePrice(ratesById, roomTypesById, priceRows as any, rate!.id, roomType!.id, d, occupancy)
        return { date: d, price_eur: price ?? null }
      })
      const missingPrices = breakdown.filter(b => b.price_eur === null).length
      const pricePerRoom  = breakdown.reduce((s, b) => s + (b.price_eur ?? 0), 0)

      return {
        rate:            { id: rate.id, title: rate.title },
        room_type:       { id: roomType.id, name: roomType.name },
        check_in:        args.check_in,
        check_out:       args.check_out,
        nights:          nights.length,
        quantity,
        breakdown,
        price_per_room_eur: Math.round(pricePerRoom * 100) / 100,
        total_eur:          Math.round(pricePerRoom * quantity * 100) / 100,
        missing_prices:  missingPrices > 0 ? `${missingPrices} noche(s) sin precio en tarifa — el total podría ser incompleto` : null,
      }
    }

    case 'calc_extension_price': {
      const r = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        with: { guest: { columns: { firstName: true, lastName: true } }, room: { columns: { id: true, code: true, roomTypeId: true } } },
      })
      if (!r) return { error: 'Reserva no encontrada' }
      if (['cancelled', 'no_show'].includes(r.status)) return { error: `Reserva en estado ${r.status}` }

      const extCheckout = args.new_checkout
        ?? (() => { const d = new Date(r.checkOutDate); d.setDate(d.getDate() + Number(args.extra_nights ?? 1)); return d.toISOString().slice(0, 10) })()
      if (extCheckout <= r.checkOutDate) return { error: 'La nueva fecha de salida debe ser posterior a la actual' }

      const rateId = args.rate_id ?? r.rateId
      if (!rateId) return { error: 'No hay tarifa asignada — indica rate_id' }

      const room = r.room as any
      if (!room?.roomTypeId) return { error: 'La habitación no tiene tipo de habitación configurado' }

      const [rate, allRates, allRoomTypes] = await Promise.all([
        db.query.rates.findFirst({ where: and(eq(rates.propertyId, getPropertyId()), eq(rates.id, rateId)) }),
        db.query.rates.findMany({ where: eq(rates.propertyId, getPropertyId()) }),
        db.query.roomTypes.findMany({ where: eq(roomTypes.propertyId, getPropertyId()) }),
      ])
      if (!rate) return { error: 'Tarifa no encontrada' }

      const ratesById     = new Map(allRates.map(rt => [rt.id, rt]))
      const roomTypesById = new Map(allRoomTypes.map(rt => [rt.id, rt]))
      const roomType      = roomTypesById.get(room.roomTypeId)
      if (!roomType) return { error: 'Tipo de habitación no encontrado' }

      const rateIds     = rateChainIds(rate, ratesById)
      const roomTypeIds = roomTypeChainIds(roomType, roomTypesById)

      // Noches de extensión: desde checkout actual hasta nuevo checkout
      const nights: string[] = []
      const cur = new Date(r.checkOutDate)
      const end = new Date(extCheckout)
      while (cur < end) { nights.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }

      const priceRows = await db.select({
        date: rateDailyPrices.date, price: rateDailyPrices.price,
        rateId: rateDailyPrices.rateId, roomTypeId: rateDailyPrices.roomTypeId,
      }).from(rateDailyPrices).where(and(eq(rateDailyPrices.propertyId, getPropertyId()), and(
        inArray(rateDailyPrices.rateId, rateIds),
        gte(rateDailyPrices.date, r.checkOutDate),
        lte(rateDailyPrices.date, nights.at(-1)!),
        or(inArray(rateDailyPrices.roomTypeId, roomTypeIds), isNull(rateDailyPrices.roomTypeId)),
      )))

      const breakdown = nights.map(d => {
        const price = resolvePrice(ratesById, roomTypesById, priceRows as any, rateId, room.roomTypeId, d)
        return { date: d, price_eur: price ?? null }
      })
      const knownTotal = breakdown.filter(b => b.price_eur !== null).reduce((s, b) => s + (b.price_eur ?? 0), 0)
      const missingPrices = breakdown.filter(b => b.price_eur === null).length
      const g = r.guest as any

      return {
        reservation_id:  r.id,
        guest:           `${g?.firstName ?? ''} ${g?.lastName ?? ''}`.trim(),
        room:            room.code,
        rate_name:       rate.title,
        current_checkout: r.checkOutDate,
        new_checkout:    extCheckout,
        extra_nights:    nights.length,
        breakdown,
        extra_cost_eur:  Math.round(knownTotal * 100) / 100,
        missing_prices:  missingPrices > 0 ? `${missingPrices} noche(s) sin precio en tarifa — el total podría ser incompleto` : null,
      }
    }

    case 'extend_stay': {
      const r = await db.query.reservations.findFirst({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)),
        with: { guest: { columns: { firstName: true, lastName: true } } },
      })
      if (!r) return { error: 'Reserva no encontrada' }
      if (['cancelled', 'no_show', 'checked_out'].includes(r.status)) {
        return { error: `No se puede modificar una reserva en estado ${r.status}` }
      }
      if (args.new_checkout <= r.checkInDate) return { error: 'La nueva fecha de salida debe ser posterior a la de entrada' }
      const newNights = Math.round((new Date(args.new_checkout).getTime() - new Date(r.checkInDate).getTime()) / 86_400_000)
      if (r.roomId) {
        const conflict = await db.query.reservations.findFirst({
          where: and(eq(reservations.propertyId, getPropertyId()), and(
            eq(reservations.roomId, r.roomId),
            lte(reservations.checkInDate, args.new_checkout),
            gte(reservations.checkOutDate, r.checkOutDate),
            or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative'),
               eq(reservations.status, 'checked_in'), eq(reservations.status, 'checking_out')),
            ne(reservations.id, r.id),
          )),
          columns: { id: true, checkInDate: true },
        })
        if (conflict) return { error: `Hay una reserva (${conflict.id}) en la misma habitación desde el ${conflict.checkInDate} — no es posible extender` }
      }
      const newTotal = args.extra_cost != null
        ? Math.round((parseFloat(r.total ?? '0') + Number(args.extra_cost)) * 100) / 100
        : undefined
      await db.update(reservations)
        .set({
          checkOutDate: args.new_checkout,
          nights:       newNights as any,
          ...(newTotal != null ? { total: String(newTotal) } : {}),
          updatedAt:    new Date(),
        } as any)
        .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, r.id)))
      const g = r.guest as any
      return { success: true, message: `Estancia de ${g?.firstName ?? ''} ${g?.lastName ?? ''} extendida hasta ${args.new_checkout} (${newNights} noches)${newTotal != null ? `. Nuevo total: ${newTotal} €` : ''}` }
    }

    case 'update_reservation': {
      const r = await db.query.reservations.findFirst({ where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, args.reservation_id)) })
      if (!r) return { error: 'Reserva no encontrada' }
      if (['cancelled', 'no_show', 'checked_out'].includes(r.status)) {
        return { error: `No se puede modificar una reserva en estado ${r.status}` }
      }
      const newCheckIn  = args.check_in  ?? r.checkInDate
      const newCheckOut = args.check_out ?? r.checkOutDate
      if (newCheckIn >= newCheckOut) return { error: 'La fecha de salida debe ser posterior a la de entrada' }
      const newNights = Math.round((new Date(newCheckOut).getTime() - new Date(newCheckIn).getTime()) / 86_400_000)
      const updates: Record<string, any> = { updatedAt: new Date() }
      if (args.check_in)  updates.checkInDate  = newCheckIn
      if (args.check_out) updates.checkOutDate = newCheckOut
      if (args.check_in || args.check_out) updates.nights = newNights
      if (args.people !== undefined) updates.people = args.people
      if (args.total  !== undefined) updates.total  = args.total.toFixed(2)
      if (Object.keys(updates).length === 1) return { error: 'No se indicó ningún campo a actualizar' }
      await db.update(reservations).set(updates as any).where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.id, r.id)))
      return { success: true, message: `Reserva ${r.id} actualizada`, updated: Object.keys(updates).filter(k => k !== 'updatedAt') }
    }

    case 'get_no_shows': {
      const date = args.date ?? addDaysIso(today, -1)
      const [actualNoShows, possiblyMissing] = await Promise.all([
        db.query.reservations.findMany({
          where: and(eq(reservations.propertyId, getPropertyId()), and(eq(reservations.status, 'no_show'), eq(reservations.checkInDate, date))),
          with: { guest: true, room: true },
        }),
        db.query.reservations.findMany({
          where: and(eq(reservations.propertyId, getPropertyId()), and(
            eq(reservations.checkInDate, date),
            or(eq(reservations.status, 'confirmed'), eq(reservations.status, 'arriving'), eq(reservations.status, 'tentative')),
          )),
          with: { guest: true, room: true },
        }),
      ])
      if (!actualNoShows.length && !possiblyMissing.length) {
        return { message: `No hay no-shows ni reservas pendientes para el ${date}` }
      }
      const fmt = (rs: any[]) => rs.map(r => ({
        id: r.id,
        guest: `${r.guest?.firstName ?? ''} ${r.guest?.lastName ?? ''}`.trim(),
        room: r.room?.code ?? '(sin asignar)',
        check_in: r.checkInDate, check_out: r.checkOutDate,
        total: r.total, status: r.status,
      }))
      return {
        date,
        no_shows: fmt(actualNoShows),
        possibly_missing: fmt(possiblyMissing),
        note: possiblyMissing.length ? `${possiblyMissing.length} reserva(s) tenían check-in el ${date} y no se han actualizado — pueden ser no-shows sin marcar` : undefined,
      }
    }

    case 'get_guest_history': {
      const g = await db.query.guests.findFirst({ where: and(eq(guests.propertyId, getPropertyId()), eq(guests.id, args.guest_id)) })
      if (!g) return { error: `Huésped ${args.guest_id} no encontrado` }
      const stayList = await db.query.reservations.findMany({
        where: and(eq(reservations.propertyId, getPropertyId()), eq(reservations.guestId, args.guest_id)),
        with: { room: { columns: { code: true } }, bookingChannel: { columns: { name: true } } },
        orderBy: desc(reservations.checkInDate),
        limit: 30,
      })
      const notes = stayList.length > 0
        ? await db.query.reservationNotes.findMany({
            where: or(...stayList.map(r => eq(reservationNotes.reservationId, r.id))),
            columns: { reservationId: true, note: true },
            limit: 30,
          })
        : []
      const notesByRes = notes.reduce((acc, n) => { (acc[n.reservationId] ??= []).push(n.note); return acc }, {} as Record<number, string[]>)
      const completed  = stayList.filter(r => !['cancelled', 'no_show'].includes(r.status))
      const totalSpent = completed.reduce((s, r) => s + parseFloat(r.total ?? '0'), 0)
      return {
        guest: { id: g.id, name: `${g.firstName} ${g.lastName}`, email: g.email ?? null, phone: g.phone ?? null, id_doc: (g as any).idDocNumber ?? null, rating: (g as any).guestRating ?? null },
        total_stays: completed.length,
        total_spent_eur: totalSpent.toFixed(2),
        stays: stayList.map(r => ({
          id: r.id, check_in: r.checkInDate, check_out: r.checkOutDate, nights: r.nights,
          room: (r.room as any)?.code ?? '(sin asignar)',
          channel: (r.bookingChannel as any)?.name ?? null,
          total: r.total, status: r.status,
          notes: notesByRes[r.id] ?? [],
        })),
      }
    }

    case 'update_guest': {
      const g = await db.query.guests.findFirst({ where: and(eq(guests.propertyId, getPropertyId()), eq(guests.id, args.guest_id)) })
      if (!g) return { error: `Huésped ${args.guest_id} no encontrado` }
      const updates: Record<string, any> = { updatedAt: new Date() }
      if (args.email         !== undefined) updates.email       = args.email
      if (args.phone         !== undefined) updates.phone       = args.phone
      if (args.id_doc_number !== undefined) updates.idDocNumber = args.id_doc_number
      if (Object.keys(updates).length === 1) return { error: 'No se indicó ningún campo a actualizar (email, phone o id_doc_number)' }
      await db.update(guests).set(updates as any).where(and(eq(guests.propertyId, getPropertyId()), eq(guests.id, g.id)))
      return { success: true, message: `Datos de ${g.firstName} ${g.lastName} actualizados` }
    }

    case 'assign_housekeeping_task': {
      const task = await db.query.housekeepingTasks.findFirst({
        where: and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.id, args.task_id)),
        with: { room: { columns: { code: true } } },
      })
      if (!task) return { error: `Tarea ${args.task_id} no encontrada` }
      const staff = await findStaffUserByName(String(args.user_name))
      if (!staff) return { error: `No se encontró a ningún empleado llamado "${args.user_name}"` }
      await db.update(housekeepingTasks)
        .set({ assignedTo: staff.id, updatedAt: new Date() } as any)
        .where(and(eq(housekeepingTasks.propertyId, getPropertyId()), eq(housekeepingTasks.id, args.task_id)))
      return { success: true, message: `Tarea ${args.task_id} (hab. ${(task.room as any)?.code ?? '?'}) asignada a ${staff.firstName} ${staff.lastName}` }
    }

    case 'create_housekeeping_task': {
      const room = await db.query.rooms.findFirst({
        where: and(eq(rooms.propertyId, getPropertyId()), and(ilike(rooms.code, args.room_code), eq(rooms.active, true))),
        columns: { id: true, code: true },
      })
      if (!room) return { error: `Habitación "${args.room_code}" no encontrada` }
      const date = args.date ?? today
      let assignedTo: number | null = null
      if (args.user_name) {
        const staff = await findStaffUserByName(String(args.user_name))
        if (!staff) return { error: `Empleado "${args.user_name}" no encontrado` }
        assignedTo = staff.id
      }
      const [task] = await db.insert(housekeepingTasks).values({
        propertyId: getPropertyId(), roomId: room.id, date,
        taskType: args.task_type, status: 'pending',
        notes: args.notes ?? null, assignedTo,
      } as any).returning({ id: housekeepingTasks.id })
      return { success: true, task_id: task!.id, message: `Tarea de ${args.task_type} creada para hab. ${room.code} el ${date}${assignedTo ? ' y asignada' : ''}` }
    }

    case 'get_invoice': {
      if (!args.id && !args.invoice_number) return { error: 'Proporciona id o invoice_number' }
      const invoice = await db.query.invoices.findFirst({
        where: and(eq(invoices.propertyId, getPropertyId()), args.id ? eq(invoices.id, args.id) : eq(invoices.invoiceNumber, args.invoice_number)),
      })
      if (!invoice) return { error: 'Factura no encontrada' }
      return {
        id: invoice.id,
        number: invoice.invoiceNumber,
        date: invoice.issuedAt,
        billing_name: (invoice as any).billingName ?? null,
        billing_nif:  (invoice as any).billingNif  ?? null,
        total: invoice.total,
        reservation_id: invoice.reservationId,
        lines: (invoice as any).lines ?? [],
      }
    }

    case 'get_laundry_status': {
      const date = args.date ?? today
      const rows = await db.execute(drizzleSql`
        SELECT ld.id, ld.location,
               ld.shower_towels, ld.hand_towels, ld.sheet_sets, ld.foot_towels,
               ld.processed_by_id IS NOT NULL AS processed,
               ld.notes,
               u1.first_name || ' ' || u1.last_name AS delivered_by,
               u2.first_name || ' ' || u2.last_name AS delivered_to
        FROM laundry_deliveries ld
        LEFT JOIN users u1 ON u1.id = ld.delivered_by_id
        LEFT JOIN users u2 ON u2.id = ld.delivered_to_id
        WHERE ld.property_id = ${getPropertyId()} AND ld.date = ${date}
        ORDER BY ld.delivered_at DESC
      `) as unknown as any[]
      const pending   = rows.filter((r: any) => !r.processed)
      const processed = rows.filter((r: any) => r.processed)
      const totals = (list: any[]) => list.reduce((acc, r) => ({
        shower_towels: acc.shower_towels + Number(r.shower_towels),
        hand_towels:   acc.hand_towels   + Number(r.hand_towels),
        sheet_sets:    acc.sheet_sets    + Number(r.sheet_sets),
        foot_towels:   acc.foot_towels   + Number(r.foot_towels),
      }), { shower_towels: 0, hand_towels: 0, sheet_sets: 0, foot_towels: 0 })
      return {
        date,
        pending_count: pending.length,
        processed_count: processed.length,
        pending_totals: totals(pending),
        deliveries: rows.map((r: any) => ({
          id: r.id, location: r.location,
          delivered_by: r.delivered_by?.trim() || '—',
          delivered_to: r.delivered_to?.trim() || '—',
          shower_towels: Number(r.shower_towels),
          hand_towels: Number(r.hand_towels),
          sheet_sets: Number(r.sheet_sets),
          foot_towels: Number(r.foot_towels),
          processed: Boolean(r.processed),
          notes: r.notes ?? null,
        })),
      }
    }

    case 'get_abandoned_carts': {
      const limit = Math.min(Number(args.limit ?? 30), 100)
      const rows = await db.execute(drizzleSql`
        SELECT
          ac.id, ac.reservation_id, ac.guest_name, ac.email,
          ac.amount, ac.discount_pct, ac.check_in, ac.check_out,
          ac.email_sent_at, ac.created_at, ac.expires_at,
          r.status AS reservation_status,
          r.amount_paid
        FROM abandoned_carts ac
        JOIN reservations r ON r.id = ac.reservation_id
        WHERE r.property_id = ${getPropertyId()}
        ORDER BY ac.created_at DESC
        LIMIT ${limit}
      `) as unknown as any[]
      const filtered = typeof args.recovered === 'boolean'
        ? rows.filter((r: any) => {
            const paid = parseFloat(r.amount_paid ?? '0') > 0
            return args.recovered ? paid : !paid
          })
        : rows
      return {
        total: filtered.length,
        recovered_count: filtered.filter((r: any) => parseFloat(r.amount_paid ?? '0') > 0).length,
        carts: filtered.map((r: any) => ({
          id:                 r.id,
          reservation_id:     r.reservation_id,
          guest_name:         r.guest_name ?? '—',
          email:              r.email ?? null,
          amount:             r.amount,
          discount_pct:       r.discount_pct,
          check_in:           r.check_in,
          check_out:          r.check_out,
          email_sent_at:      r.email_sent_at ? String(r.email_sent_at).slice(0, 16) : null,
          created_at:         r.created_at   ? String(r.created_at).slice(0, 16)   : null,
          expires_at:         r.expires_at   ? String(r.expires_at).slice(0, 16)   : null,
          recovered:          parseFloat(r.amount_paid ?? '0') > 0,
          reservation_status: r.reservation_status ?? null,
        })),
      }
    }

    case 'search_local_events': {
      if (!(await isSerpApiConfigured())) return { error: 'Búsqueda de eventos no configurada (falta la clave de SerpAPI)' }
      // Consultas por tenant: settings events.queries o, por defecto, la ciudad del hotel.
      const evCity = (await getBranding()).city
      const evQueries = (await getSetting<string[]>('events.queries'))
        ?? (evCity ? [`eventos ${evCity}`, `conciertos ${evCity}`, `festivales ${evCity}`] : undefined)
      const events = await fetchLocalEvents(evQueries)
      const filter = String(args.impact_filter ?? 'all')
      const filtered = filter === 'all' ? events
        : filter === 'high'        ? events.filter(e => e.impactLevel === 'high')
        : filter === 'medium'      ? events.filter(e => e.impactLevel === 'medium')
        : events.filter(e => e.impactLevel === 'high' || e.impactLevel === 'medium')
      return {
        fetched_today: true,
        total: filtered.length,
        high_impact:   filtered.filter(e => e.impactLevel === 'high').length,
        medium_impact: filtered.filter(e => e.impactLevel === 'medium').length,
        events: filtered.map(e => ({
          title:        e.title,
          date:         e.date,
          venue:        e.venue,
          address:      e.address ?? null,
          impact_level: e.impactLevel,
          link:         e.link ?? null,
        })),
      }
    }

    case 'get_new_bookings': {
      const from = typeof args.from === 'string' && args.from ? args.from : today
      const to   = typeof args.to === 'string' && args.to ? args.to : from
      const rows = await db.select({
        id:           reservations.id,
        guestFirst:   guests.firstName,
        guestLast:    guests.lastName,
        channel:      bookingChannels.name,
        checkInDate:  reservations.checkInDate,
        checkOutDate: reservations.checkOutDate,
        total:        reservations.total,
      }).from(reservations)
        .leftJoin(guests, eq(reservations.guestId, guests.id))
        .leftJoin(bookingChannels, eq(reservations.bookingChannelId, bookingChannels.id))
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          drizzleSql`(${reservations.bookedAt} AT TIME ZONE ${tz})::date >= ${from}::date`,
          drizzleSql`(${reservations.bookedAt} AT TIME ZONE ${tz})::date <= ${to}::date`,
          ne(reservations.status, 'cancelled'),
        )))
        .orderBy(reservations.id)
      return {
        from, to, count: rows.length,
        bookings: rows.map(r => ({
          reservation_id: r.id,
          guest:      [r.guestFirst, r.guestLast].filter(Boolean).join(' ') || null,
          channel:    r.channel ?? 'Directo',
          check_in:   r.checkInDate,
          check_out:  r.checkOutDate,
          total:      r.total,
        })),
      }
    }

    case 'get_online_users':
      return { online: getActivePresence() }

    case 'get_staff_list': {
      const onlyActive = args.only_active !== false
      const list = await db.query.users.findMany({
        where: and(eq(users.propertyId, getPropertyId()), onlyActive ? eq(users.active, true) : undefined),
        with: { roles: true },
        orderBy: users.firstName,
      })
      return {
        count: list.length,
        users: list.map(u => ({
          id:         u.id,
          name:       `${u.firstName} ${u.lastName}`,
          email:      u.email,
          roles:      (u.roles as any[]).map(r => r.role),
          is_primary: u.isPrimary,
          active:     u.active,
        })),
      }
    }

    default:
      return { error: `Tool desconocida: ${name}` }
  }
}

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
// ── Bucle de tool-calling compartido entre /chat y /proactive ─────────────────

// usage solo lo rellena el backend Claude (es el único con precio por token
// documentado aquí) — Ollama/RunPod lo dejan sin definir.
type AgentLoopResult = {
  text: string
  actions: { tool: string; result: any }[]
  usage?: { input: number; output: number; cacheWrite: number; cacheRead: number; costUsd: number }
}

async function runAgentLoopOllama(
  userMessages: { role: 'user' | 'assistant'; content: string }[],
  userCtx: AiUserCtx,
  systemExtra = '',
): Promise<AgentLoopResult> {
  const snapshot = await hotelSnapshot().catch(() => '')
  const tools = await toolsForTenant()

  const ollamaMessages: any[] = [
    { role: 'system', content: (await systemPrompt(userCtx.roles)) + systemExtra + (snapshot ? `\n\n${snapshot}` : '') },
    ...userMessages,
  ]

  let finalText = ''
  const actions: { tool: string; result: any }[] = []

  for (let i = 0; i < 6; i++) {
    const backend = RUNPOD_BASE ? `RunPod (${MODEL})` : `Ollama (${MODEL})`
    log('AI', `Iteración ${i + 1} — enviando a ${backend}`, { messages: ollamaMessages.length })

    let data: any
    try {
      data = await callLLM(ollamaMessages, tools.openai)
    } catch (e: any) {
      logErr('AI', 'Error llamando al modelo', { error: e.message })
      finalText = AI_UNAVAILABLE_TEXT
      break
    }

    const msg = data.message
    log('AI', `Respuesta en ${backend}`, {
      tool_calls: msg.tool_calls?.length ?? 0,
      content_preview: msg.content?.slice(0, 200) ?? null,
    })

    if (!msg.tool_calls?.length) {
      finalText = msg.content ?? ''
      break
    }

    ollamaMessages.push(msg)

    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name
      let toolArgs: any

      try {
        toolArgs = typeof tc.function.arguments === 'string'
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments
      } catch (e: any) {
        logErr('AI', `Args inválidos para ${toolName}`, { raw: tc.function.arguments })
        ollamaMessages.push({ role: 'tool', content: JSON.stringify({ error: 'Argumentos inválidos, reformula la llamada' }) })
        continue
      }

      log('AI', `Tool call: ${toolName}`, toolArgs)
      let result: any
      try {
        result = await executeTool(toolName, toolArgs, userCtx)
      } catch (e: any) {
        result = { error: e.message }
        logErr('AI', `Tool error: ${toolName}`, { error: e.message })
      }
      actions.push({ tool: toolName, result })
      ollamaMessages.push({ role: 'tool', content: JSON.stringify(result) })
    }
  }

  return { text: finalText, actions }
}

async function runAgentLoopClaude(
  userMessages: { role: 'user' | 'assistant'; content: string }[],
  userCtx: AiUserCtx,
  systemExtra = '',
  // El resumen diario encadena ~6 tools + informe largo: con 6 vueltas/4096
  // tokens (lo normal para el chat) a veces se quedaba sin vueltas o cortaba
  // el HTML a media frase, y el email salía incompleto.
  limits: { maxIterations?: number; maxTokens?: number } = {},
): Promise<AgentLoopResult> {
  const maxIterations = limits.maxIterations ?? 6
  const maxTokens     = limits.maxTokens ?? 4096
  const snapshot = await hotelSnapshot().catch(() => '')
  const tools = await toolsForTenant()

  // System como array: cache_control en el bloque estático → tools + system prompt
  // se cachean juntos (prefijo), reduciendo coste ~80-90% en iteraciones 2-6.
  const sysBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: await systemPrompt(userCtx.roles), cache_control: { type: 'ephemeral' } },
    ...(snapshot ? [{ type: 'text' as const, text: snapshot }] : []),
    ...(systemExtra.trim() ? [{ type: 'text' as const, text: systemExtra.trim() }] : []),
  ]

  const messages: Anthropic.MessageParam[] = [...userMessages]
  let finalText = ''
  let forceFinal = false  // sin vueltas de tools: última llamada obligada a responder con texto
  const actions: { tool: string; result: any }[] = []
  // Coste real acumulado de la llamada — precios Haiku 4.5: $1/$5 por MTok
  // input/output, escritura de caché ×1.25, lectura de caché ×0.1.
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0 }

  for (let i = 0; i < maxIterations + 4; i++) {  // +4: vueltas extra solo para forzar la respuesta / continuar cortes
    if (i >= maxIterations && !forceFinal) {
      forceFinal = true
      logErr('AI', 'Agente sin vueltas de tools: se fuerza respuesta final sin más herramientas', { maxIterations })
    }
    log('AI', `Iteración ${i + 1} — Claude Haiku`, { messages: messages.length })

    let response: Anthropic.Message
    try {
      response = await getAnthropicClient().messages.create({
        model:      CLAUDE_MODEL,
        // 768 se quedaba corto en respuestas largas (comparativas de varios
        // meses/años, listados largos de pendientes...) y Claude las cortaba
        // a media frase al llegar al tope. Este límite aplica a CADA
        // iteración del bucle de tools, incluida la respuesta final de
        // texto — subirlo no cuesta más salvo que de verdad genere más
        // tokens (el coste es por uso real, no por el tope en sí).
        max_tokens: maxTokens,
        system:     sysBlocks,
        messages,
        tools:      tools.claude,
        ...(forceFinal ? { tool_choice: { type: 'none' as const } } : {}),
      })
    } catch (e: any) {
      logErr('AI', 'Error llamando a Claude', { error: e.message })
      finalText = AI_UNAVAILABLE_TEXT
      break
    }

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const textBlock     = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')

    const u = response.usage
    await recordAiUsage(u)
    usage.input      += u.input_tokens
    usage.output     += u.output_tokens
    usage.cacheWrite += u.cache_creation_input_tokens ?? 0
    usage.cacheRead  += u.cache_read_input_tokens ?? 0
    usage.costUsd    += claudeCostUsd(u)

    log('AI', 'Respuesta de Claude', {
      stop_reason:     response.stop_reason,
      tool_calls:      toolUseBlocks.length,
      content_preview: textBlock?.text?.slice(0, 200) ?? null,
      usage:           u,
    })

    if (toolUseBlocks.length === 0 || forceFinal) {
      finalText += textBlock?.text ?? ''
      // Cortado por el tope de tokens a media respuesta: pídele que siga y
      // concatena (antes se enviaba el texto cortado tal cual).
      if (response.stop_reason === 'max_tokens') {
        logErr('AI', 'Respuesta cortada por max_tokens — se pide continuación', { chars: finalText.length })
        messages.push({ role: 'assistant', content: textBlock?.text ?? '' })
        messages.push({ role: 'user', content: 'Continúa EXACTAMENTE donde lo dejaste, sin repetir nada ni añadir introducción.' })
        continue
      }
      break
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tc of toolUseBlocks) {
      log('AI', `Tool call: ${tc.name}`, tc.input)
      let result: any
      try {
        result = await executeTool(tc.name, tc.input as Record<string, any>, userCtx)
      } catch (e: any) {
        result = { error: e.message }
        logErr('AI', `Tool error: ${tc.name}`, { error: e.message })
      }
      actions.push({ tool: tc.name, result })
      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: JSON.stringify(result) })
    }

    messages.push({ role: 'user', content: toolResults })
  }

  log('AI', 'Coste de la consulta', { ...usage, costUsd: usage.costUsd.toFixed(5) })
  return { text: finalText, actions, usage }
}

export async function runAgentLoop(
  userMessages: { role: 'user' | 'assistant'; content: string }[],
  userCtx: AiUserCtx,
  systemExtra = '',
  limits: { maxIterations?: number; maxTokens?: number } = {},
): Promise<AgentLoopResult> {
  const result = AI_BACKEND === 'claude'
    ? await runAgentLoopClaude(userMessages, userCtx, systemExtra, limits)
    : await runAgentLoopOllama(userMessages, userCtx, systemExtra)
  // Claude puede terminar el turno sin ningún bloque de texto (raro, pero
  // pasa) dejando `text` en '' — un turno de asistente vacío es inofensivo en
  // el chat web, pero la app de voz (voice-brief.ts) reenvía el historial
  // completo en cada pregunta y su validador exige contenido no vacío en
  // TODOS los turnos: ese '' colado una vez rompía todas las preguntas
  // siguientes hasta que el historial caducara. Se garantiza aquí, para
  // cualquier llamador, que nunca se devuelve vacío.
  if (!result.text.trim()) result.text = 'No he podido generar una respuesta esta vez — inténtalo de nuevo.'
  return result
}

// ── Scheduler de tareas programadas (create_scheduled_task) ────────────────
// Cada 5 min revisa qué tareas tienen nextRunAt vencido, les hace correr
// `prompt` por el mismo bucle de agente que el chat normal (con los roles de
// quien las creó, así respeta los mismos permisos) y reprograma la siguiente
// ejecución a una hora aleatoria dentro de su ventana horaria.

export async function ctxForUser(userId: number): Promise<AiUserCtx> {
  const [roleRows, u] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, userId)),
    db.query.users.findFirst({ where: and(eq(users.propertyId, getPropertyId()), eq(users.id, userId)), columns: { isPrimary: true } }),
  ])
  if (!u) return { roles: [] }
  const roles = roleRows.map(r => r.role as string)
  if (u.isPrimary && !roles.includes('direccion')) roles.push('direccion')
  return { userId, roles }
}

// No hay ningún humano al otro lado en una ejecución programada — sin esto,
// el modelo seguiría el flujo normal de "describe el plan y espera
// confirmación" para cualquier acción de escritura (mandar el mensaje...) y
// esa confirmación nunca llegaría, así que la tarea nunca haría nada.
// Dirección ya confirmó al crear la tarea (create_scheduled_task exige
// confirmed=true) — esta ejecución concreta actúa con esa autorización.
const SCHEDULED_TASK_SYSTEM_EXTRA =
  'Estás ejecutando una TAREA PROGRAMADA automática — no hay ningún humano hablando contigo ahora mismo. ' +
  'El mensaje de usuario que recibes es el prompt que dirección escribió y confirmó al crear esta tarea recurrente ' +
  '(ver create_scheduled_task). Actúa directamente: para cualquier acción de escritura que necesites, pasa ' +
  'confirmed=true de inmediato, sin describir el plan primero ni esperar una confirmación que nunca va a llegar.'

async function runDueScheduledTasks() {
  // Se ejecuta dentro del contexto de un tenant (forEachActiveProperty): solo
  // las tareas creadas por usuarios de ese tenant.
  const tz = (await getProperty()).timezone
  const due = await db.select().from(aiScheduledTasks).where(and(
    inArray(aiScheduledTasks.createdBy, tenantUserIds()),
    eq(aiScheduledTasks.active, true),
    lte(aiScheduledTasks.nextRunAt, new Date()),
  ))
  for (const task of due) {
    const reschedule = () => scheduleNextRun(new Date(), task.intervalDays, task.timeWindowStart, task.timeWindowEnd, tz)
    try {
      const userCtx = await ctxForUser(task.createdBy)
      const { text } = await runAgentLoop([{ role: 'user', content: task.prompt }], userCtx, SCHEDULED_TASK_SYSTEM_EXTRA)
      const failed = text === AI_UNAVAILABLE_TEXT
      await db.update(aiScheduledTasks).set({
        lastRunAt:  new Date(),
        nextRunAt:  reschedule(),
        lastResult: failed ? null : text.slice(0, 2000),
        lastError:  failed ? 'El modelo no respondió' : null,
      }).where(eq(aiScheduledTasks.id, task.id))
      log('AI', `Tarea programada ${task.id} ejecutada`, { prompt: task.prompt.slice(0, 80), ok: !failed })
    } catch (e: any) {
      await db.update(aiScheduledTasks).set({
        lastRunAt: new Date(),
        nextRunAt: reschedule(),
        lastError: e.message ?? 'Error desconocido',
      }).where(eq(aiScheduledTasks.id, task.id))
      logErr('AI', `Tarea programada ${task.id} falló`, { error: e.message })
    }
  }
}

// ── Briefing matutino del agente para dirección ───────────────────────────
// Una vez al día (a partir de las 08:00 Madrid) el agente revisa el hotel por su
// cuenta y deja el resultado como sesión "briefing-YYYY-MM-DD" en el historial
// de cada usuario de dirección (aparece entre sus conversaciones recientes).
// Los mensajes al personal se dejan como BORRADOR dentro del briefing — el agente
// no los envía solo: dirección los aprueba y se los pide.
const BRIEFING_PROMPT = `Prepara el BRIEFING MATUTINO para dirección de hoy. Revisa por tu cuenta, con los tools: (1) get_pricing_rules_status (¿el motor de reglas está vivo? ¿avisos?), (2) get_pricing_effects (¿qué reglas dinámicas funcionan y cuáles no?), (3) get_competitor_comparison (próximos 14 días: dónde estamos caros/baratos, competidores agotados), (4) get_occupancy_report de hoy y próximos 14 días frente a los mismos días del año pasado, (5) list_feedback_threads (quejas abiertas, patrones y qué elogian), (6) las alertas activas que ya tengas en el contexto. Formato: máximo ~12 líneas, en HTML no — texto plano con viñetas. Estructura: LO MÁS IMPORTANTE HOY (con impacto en €), PRECIOS (qué cuestionas o propones cambiar y por qué), FEEDBACK DE HUÉSPEDES, y PREGUNTAS PARA TI (máximo 4, cortas, de sí/no o una palabra, sobre lo que falta o está pasando en el hotel). Si propones avisar a alguien del equipo, escribe el mensaje como BORRADOR ("Borrador para X: ...") — NO lo envíes, dirección lo aprobará.`

let briefingRunning = false
async function runDirectorBriefing() {
  if (briefingRunning) return
  briefingRunning = true
  try { await runDirectorBriefingInner() } finally { briefingRunning = false }
}

const BRIEFING_SYSTEM_EXTRA = 'Estás ejecutando el BRIEFING MATUTINO automático — no hay ningún humano hablando contigo. Es solo de lectura: NO ejecutes ninguna acción de escritura (no envíes mensajes, no cambies reservas ni precios); la única excepción es create_feedback_thread si detectas un comentario de huésped sin hilo. Propón, no actúes. Si alguna de las tools citadas no está disponible en este hotel (módulo no activado), sáltate ese punto sin mencionarlo.'

async function runDirectorBriefingInner() {
  const now = new Date()
  const tz = (await getProperty()).timezone
  const localHour = parseInt(new Intl.DateTimeFormat('es-ES', { timeZone: tz, hour: 'numeric', hour12: false }).format(now), 10) % 24
  if (localHour < 8 || localHour >= 13) return
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now)
  const sid = `briefing-${day}`
  const dir = await db.selectDistinct({ id: users.id }).from(userRoles).innerJoin(users, eq(userRoles.userId, users.id))
    .where(and(eq(users.propertyId, getPropertyId()), eq(userRoles.role, 'direccion'), eq(users.active, true)))
  if (dir.length === 0) return
  const done = await db.select({ userId: aiChatMessages.userId }).from(aiChatMessages).where(and(eq(aiChatMessages.sessionId, sid), inArray(aiChatMessages.userId, dir.map(d => d.id))))
  const doneIds = new Set(done.map(d => d.userId))
  const pending = dir.filter(d => !doneIds.has(d.id))
  if (pending.length === 0) return
  const ctx = await ctxForUser(pending[0]!.id)
  const { text } = await runAgentLoop([{ role: 'user', content: BRIEFING_PROMPT }], ctx, BRIEFING_SYSTEM_EXTRA, { maxIterations: 14, maxTokens: 4096 })
  if (!text || text === AI_UNAVAILABLE_TEXT) { logErr('AI', 'Briefing matutino: el modelo no respondió'); return }
  await db.insert(aiChatMessages).values(pending.flatMap(d => [
    { userId: d.id, sessionId: sid, source: 'chat', role: 'user',      content: `📋 Briefing matutino — ${day}` },
    { userId: d.id, sessionId: sid, source: 'chat', role: 'assistant', content: text },
  ]))
  log('AI', 'Briefing matutino generado', { day, users: pending.length })
}

// Una pasada: para cada tenant con el módulo 'ai' activo, sus tareas vencidas y
// su briefing matutino (cada uno dentro de su contexto de tenant).
async function aiSchedulerPass() {
  await forEachActiveProperty('ai-scheduler', async () => {
    await runDueScheduledTasks().catch(e => logErr('AI', 'Error en sweep de tareas programadas', { error: e.message }))
    await runDirectorBriefing().catch(e => logErr('AI', 'Error en briefing matutino', { error: e.message }))
  }, { feature: 'ai' })
}

export function startAiScheduledTasksScheduler() {
  aiSchedulerPass().catch(e => logErr('AI', 'Error en arranque de tareas programadas', { error: e.message }))
  setInterval(() => {
    aiSchedulerPass().catch(e => logErr('AI', 'Error en sweep de tareas programadas', { error: e.message }))
  }, 5 * 60 * 1000)
  log('AI', 'Scheduler de tareas programadas iniciado — revisión cada 5 min')
}

app.post('/chat', zValidator('json', z.object({
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  // Agrupa esta conversación como una sesión recuperable (ver GET /sessions).
  // Si no llega (cliente antiguo), se genera una en el propio servidor.
  sessionId: z.string().min(1).max(100).optional(),
})), async (c) => {
  const { messages, sessionId } = c.req.valid('json')
  const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''
  log('AI', `Nueva consulta: "${lastUser.slice(0, 120)}"`)

  try {
    const userCtx = await loadUserCtx(c)
    const { text, actions } = await runAgentLoop(messages, userCtx)

    if (userCtx.userId && lastUser) {
      const sid = sessionId ?? crypto.randomUUID()
      db.insert(aiChatMessages).values([
        { userId: userCtx.userId, sessionId: sid, source: 'chat', role: 'user',      content: lastUser },
        { userId: userCtx.userId, sessionId: sid, source: 'chat', role: 'assistant', content: text },
      ]).catch(e => logErr('AI', 'No se pudo guardar el historial de chat', { error: String(e) }))
    }

    const navAction = actions.find(a => a.tool === 'navigate')
    return c.json({
      text,
      actions: actions.filter(a => a.tool !== 'navigate').map(a => ({ tool: a.tool, result: a.result })),
      navigate: navAction ? navAction.result : null,
    })

  } catch (e) {
    logErr('AI', 'Error inesperado en chat', { error: String(e) })
    return c.json({
      text: 'Se ha producido un error interno. Por favor, inténtalo de nuevo.',
      actions: [], navigate: null,
    })
  }
})

// ── GET /api/ai/sessions — últimas 5 sesiones del usuario actual con el
//    asistente (?source=chat, por defecto) o con AI Debug (?source=debug,
//    solo dirección). Cualquier trabajador puede recuperar las suyas de chat.
app.get('/sessions', zValidator('query', z.object({
  source: z.enum(['chat', 'debug']).optional(),
})), async (c) => {
  try {
    const src = c.req.valid('query').source ?? 'chat'
    if (src === 'debug' && !isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const userCtx = await loadUserCtx(c)
    if (!userCtx.userId) return c.json({ data: [] })

    const rows = await db.execute(drizzleSql`
      SELECT m.session_id,
             MIN(m.created_at) AS started_at,
             MAX(m.created_at) AS last_at,
             COUNT(*) AS message_count,
             (SELECT content FROM ai_chat_messages m2
              WHERE m2.session_id = m.session_id AND m2.role = 'user'
              ORDER BY m2.created_at ASC LIMIT 1) AS preview
      FROM ai_chat_messages m
      WHERE m.user_id = ${userCtx.userId} AND m.source = ${src} AND m.session_id IS NOT NULL
      GROUP BY m.session_id
      ORDER BY MAX(m.created_at) DESC
      LIMIT 5
    `) as unknown as any[]

    return c.json({
      data: rows.map(r => ({
        sessionId:    r.session_id,
        startedAt:    r.started_at,
        lastAt:       r.last_at,
        messageCount: Number(r.message_count),
        preview:      (r.preview ?? '').slice(0, 140),
      })),
    })
  } catch (err) { return serverError(c, err) }
})

// GET /api/ai/sessions/:sessionId — mensajes de una sesión propia
app.get('/sessions/:sessionId', zValidator('query', z.object({
  source: z.enum(['chat', 'debug']).optional(),
})), async (c) => {
  try {
    const src = c.req.valid('query').source ?? 'chat'
    if (src === 'debug' && !isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const userCtx = await loadUserCtx(c)
    if (!userCtx.userId) return c.json({ data: [] })

    const rows = await db.select({
      role: aiChatMessages.role, content: aiChatMessages.content, createdAt: aiChatMessages.createdAt,
    })
      .from(aiChatMessages)
      .where(and(
        eq(aiChatMessages.userId, userCtx.userId),
        eq(aiChatMessages.sessionId, c.req.param('sessionId')),
        eq(aiChatMessages.source, src),
      ))
      .orderBy(aiChatMessages.createdAt)

    return c.json({ data: rows })
  } catch (err) { return serverError(c, err) }
})

// ── POST /api/ai/proactive — chequeo espontáneo del turno (sin que el usuario
//    pregunte nada) — mismas tools, mismo modelo, un system prompt extra que le
//    pide iniciar él la conversación con algo concreto y relevante ahora mismo.
const PROACTIVE_KICKOFF = '[CHEQUEO PROACTIVO — no es un mensaje del usuario] Eres tú quien inicia la conversación, sin que nadie te haya preguntado nada. Empieza saludando con "Buenos días" / "Buenas tardes" / "Buenas noches" según la hora actual. Usa las tools que necesites (pagos pendientes, caja del día, limpieza sin asignar, resumen de hoy, reservas de huéspedes alojados hoy) para elegir UNA sola cosa concreta de la que hablar ahora — no lo enumeres todo de golpe. Elige entre: (a) algo pendiente y llamativo (un pago sin cobrar, la caja sin cerrar, limpieza sin asignar), con cifras reales; (b) si no hay nada urgente, pregunta por cómo han sido los huéspedes que ha atendido hoy — si en su respuesta te cuenta algo de un huésped concreto (bueno o malo) y lo confirma, usa update_guest_rating para dejarlo anotado; (c) si tampoco aplica, un dato breve (ocupación, alguna cifra del día) y pregunta abierta de cómo lleva el turno. Sé breve (2-3 frases), cálido y siempre con datos reales, nunca inventados.'

const BACKGROUND_KICKOFF = '[PREGUNTA DIARIA — no es un mensaje del usuario] Pregúntale de forma simpática y muy breve (1-2 frases) dónde le gustaría estar ahora mismo — una playa, una ciudad, una montaña, lo que sea, real o soñado. No consultes tools todavía, solo pregunta. Cuando responda con un lugar, usa set_dashboard_background con una descripción breve de ese lugar (en inglés si ayuda a encontrar mejor foto) para ponérselo de fondo — esto no necesita confirmación, es solo estético. Después dile en una frase que ya se lo has puesto.'

// Antes el único límite de "checkin" era el localStorage del navegador (cada
// 4h) — sin control en el servidor, cada dispositivo/sesión del mismo
// usuario (o simplemente borrar localStorage) disparaba una llamada real a
// Claude aparte, multiplicando el gasto sin que nadie lo pidiera. Ahora,
// como mucho una vez al día por usuario, decidido aquí — el localStorage
// del frontend sigue existiendo pero ya no es lo que de verdad protege el
// gasto.
const lastProactiveCheckinDay = new Map<number, string>()

app.post('/proactive', async (c) => {
  const userCtx = await loadUserCtx(c)
  if (!userCtx.userId) return c.json({ text: '', actions: [], navigate: null })

  let kind: 'checkin' | 'background' = 'checkin'
  try {
    const body: any = await c.req.json()
    if (body?.kind === 'background') kind = 'background'
  } catch {}

  if (kind === 'checkin') {
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: (await getProperty()).timezone }).format(new Date())
    if (lastProactiveCheckinDay.get(userCtx.userId) === today) {
      return c.json({ text: '', actions: [], navigate: null })
    }
    lastProactiveCheckinDay.set(userCtx.userId, today)
  }

  const kickoff = kind === 'background' ? BACKGROUND_KICKOFF : PROACTIVE_KICKOFF
  log('AI', `Chequeo proactivo solicitado (${kind})`, { userId: userCtx.userId, roles: userCtx.roles })

  try {
    const { text, actions } = await runAgentLoop(
      [{ role: 'user', content: kickoff }],
      userCtx,
      '\n\nEstás generando un mensaje proactivo (ver instrucción del usuario): sé breve, cálido y concreto.',
    )
    return c.json({
      text,
      actions: actions.filter(a => a.tool !== 'navigate').map(a => ({ tool: a.tool, result: a.result })),
      navigate: null,
    })
  } catch (e) {
    logErr('AI', 'Error inesperado en proactive', { error: String(e) })
    return c.json({ text: '', actions: [], navigate: null })
  }
})

// ── GET /api/ai/inbox — mensajes internos pendientes de otro miembro del
//    equipo (nunca de/para huéspedes), entregados por el propio asistente.
//    Excluye important=true — esos se entregan aparte, ver /important-messages
//    más abajo (popup bloqueante, no burbuja de chat).
app.get('/inbox', async (c) => {
  const userCtx = await loadUserCtx(c)
  if (!userCtx.userId) return c.json({ data: [] })

  try {
    const pending = await db.select({
      id:      staffMessages.id,
      message: staffMessages.message,
      firstName: users.firstName,
      lastName:  users.lastName,
    })
      .from(staffMessages)
      .innerJoin(users, eq(staffMessages.fromUserId, users.id))
      .where(and(eq(staffMessages.toUserId, userCtx.userId), eq(staffMessages.delivered, false), eq(staffMessages.important, false)))
      .orderBy(staffMessages.createdAt)

    if (!pending.length) return c.json({ data: [] })

    await db.update(staffMessages)
      .set({ delivered: true })
      .where(and(eq(staffMessages.toUserId, userCtx.userId), eq(staffMessages.delivered, false), eq(staffMessages.important, false)))

    const texts = pending.map(m => `📩 ${m.firstName} ${m.lastName} te dice: "${m.message}"`)
    return c.json({ data: texts })
  } catch (e) {
    logErr('AI', 'Error inesperado en inbox', { error: String(e) })
    return c.json({ data: [] })
  }
})

// ── GET /api/ai/important-messages — mensajes "Importante Ahora" de dirección
//    pendientes de confirmar lectura (nunca de/para huéspedes). El frontend
//    (ImportantStaffMessagePopup.tsx) los muestra en un popup que bloquea la
//    pantalla del destinatario, con un mínimo de 10s antes de poder confirmar.
app.get('/important-messages', async (c) => {
  const userCtx = await loadUserCtx(c)
  if (!userCtx.userId) return c.json({ data: [] })

  try {
    const pending = await db.select({
      id:        staffMessages.id,
      message:   staffMessages.message,
      firstName: users.firstName,
      lastName:  users.lastName,
      createdAt: staffMessages.createdAt,
    })
      .from(staffMessages)
      .innerJoin(users, eq(staffMessages.fromUserId, users.id))
      .where(and(eq(staffMessages.toUserId, userCtx.userId), eq(staffMessages.important, true), isNull(staffMessages.acknowledgedAt)))
      .orderBy(staffMessages.createdAt)

    return c.json({ data: pending })
  } catch (e) {
    logErr('AI', 'Error inesperado en important-messages', { error: String(e) })
    return c.json({ data: [] })
  }
})

// ── POST /api/ai/important-messages/:id/ack — el destinatario confirma que
//    ha leído el mensaje (el frontend solo deja llamar a esto tras el
//    bloqueo mínimo de 10s, pero se valida igualmente aquí que el mensaje sea
//    de verdad suyo antes de marcarlo).
app.post('/important-messages/:id/ack', async (c) => {
  const userCtx = await loadUserCtx(c)
  if (!userCtx.userId) return c.json({ error: 'No autenticado' }, 401)

  try {
    const id = Number(c.req.param('id'))
    if (!Number.isFinite(id)) return c.json({ error: 'id inválido' }, 400)

    const [row] = await db.update(staffMessages)
      .set({ acknowledgedAt: new Date(), delivered: true })
      .where(and(eq(staffMessages.id, id), eq(staffMessages.toUserId, userCtx.userId)))
      .returning({ id: staffMessages.id })

    if (!row) return c.json({ error: 'Mensaje no encontrado' }, 404)
    return c.json({ ok: true })
  } catch (e) {
    logErr('AI', 'Error inesperado en important-messages/ack', { error: String(e) })
    return c.json({ error: 'Error al confirmar el mensaje' }, 500)
  }
})

// Traza de debug con Claude — misma forma de salida (Iteration[]) que el bucle
// Ollama/RunPod de más abajo, para que AiDebugView.tsx no necesite distinguir
// backends al pintar la traza. La llamada es al SDK de Anthropic, no fetch
// crudo, así que no hay httpStatus real: 200 si respondió, el status del
// error si el SDK lo trae, si no 0.
async function runDebugLoopClaude(
  userMessages: { role: 'user' | 'assistant'; content: string }[],
  userCtx: AiUserCtx,
): Promise<{ finalText: string; iterations: any[] }> {
  const snapshot = await hotelSnapshot().catch(() => '')
  const tools = await toolsForTenant()
  const sysBlocks: Anthropic.TextBlockParam[] = [
    { type: 'text', text: await systemPrompt(userCtx.roles), cache_control: { type: 'ephemeral' } },
    ...(snapshot ? [{ type: 'text' as const, text: snapshot }] : []),
  ]

  const messages: Anthropic.MessageParam[] = [...userMessages]
  const iterations: any[] = []
  let finalText = ''

  for (let i = 0; i < 6; i++) {
    const iter: any = {
      index: i,
      requestMessages: messages.map(m => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content.slice(0, 500) : JSON.stringify(m.content).slice(0, 500),
      })),
      llmTrace: null, toolCalls: [], done: false, fatalError: null,
    }

    const t0 = Date.now()
    let response: Anthropic.Message
    try {
      response = await getAnthropicClient().messages.create({
        model: CLAUDE_MODEL, max_tokens: 4096, system: sysBlocks, messages, tools: tools.claude,
      })
    } catch (e: any) {
      iter.llmTrace = {
        backend: `Claude (${CLAUDE_MODEL})`, httpStatus: e.status ?? 0, elapsed: Date.now() - t0,
        rawText: String(e.message ?? e), jsonError: null, rawJson: null, normalized: null, fatalError: e.message ?? String(e),
      }
      iter.fatalError = e.message ?? String(e)
      iterations.push(iter)
      break
    }
    const elapsed = Date.now() - t0
    await recordAiUsage(response.usage)

    const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
    const textBlock     = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text')
    const normalized = {
      message: {
        role: 'assistant', content: textBlock?.text ?? '',
        tool_calls: toolUseBlocks.map(tb => ({ id: tb.id, function: { name: tb.name, arguments: JSON.stringify(tb.input) } })),
      },
    }
    iter.llmTrace = {
      backend: `Claude (${CLAUDE_MODEL})`, httpStatus: 200, elapsed,
      rawText: JSON.stringify(response).slice(0, 8000), jsonError: null, rawJson: response, normalized, fatalError: null,
    }

    if (toolUseBlocks.length === 0) {
      finalText = textBlock?.text ?? ''
      iter.done = true; iterations.push(iter); break
    }

    messages.push({ role: 'assistant', content: response.content })

    const toolResults: Anthropic.ToolResultBlockParam[] = []
    for (const tb of toolUseBlocks) {
      const t1 = Date.now()
      let result: any; let toolError: string | null = null
      try { result = await executeTool(tb.name, tb.input as Record<string, any>, userCtx) }
      catch (e: any) { result = { error: e.message }; toolError = e.message }
      iter.toolCalls.push({ name: tb.name, rawArgs: tb.input, parsedArgs: tb.input, argsError: null, result, toolError, elapsed: Date.now() - t1 })
      toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: JSON.stringify(result) })
    }
    messages.push({ role: 'user', content: toolResults })

    iterations.push(iter)
  }

  return { finalText, iterations }
}

// ── POST /api/ai/debug-chat — solo dirección. backend: 'ollama' (RunPod/Ollama,
//    por defecto) | 'claude'. Guarda los turnos (source='debug') para poder
//    recuperar la sesión luego (GET /sessions?source=debug).
app.post('/debug-chat', zValidator('json', z.object({
  messages: z.array(z.object({
    role:    z.enum(['user', 'assistant']),
    content: z.string(),
  })),
  backend:   z.enum(['ollama', 'claude']).optional(),
  sessionId: z.string().min(1).max(100).optional(),
})), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  const { messages, backend, sessionId } = c.req.valid('json')
  const userCtx  = await loadUserCtx(c)
  const lastUser = messages.filter(m => m.role === 'user').at(-1)?.content ?? ''

  const persist = (finalText: string) => {
    if (userCtx.userId && lastUser) {
      const sid = sessionId ?? crypto.randomUUID()
      db.insert(aiChatMessages).values([
        { userId: userCtx.userId, sessionId: sid, source: 'debug', role: 'user',      content: lastUser },
        { userId: userCtx.userId, sessionId: sid, source: 'debug', role: 'assistant', content: finalText },
      ]).catch(e => logErr('AI', 'No se pudo guardar la sesión de AI Debug', { error: String(e) }))
    }
  }

  if (backend === 'claude') {
    try {
      const { finalText, iterations } = await runDebugLoopClaude(messages, userCtx)
      persist(finalText)
      return c.json({ finalText, iterations, backend: `Claude (${CLAUDE_MODEL})` })
    } catch (e: any) {
      logErr('AI', 'Error inesperado en debug-chat (claude)', { error: String(e) })
      return c.json({ finalText: '', iterations: [], backend: `Claude (${CLAUDE_MODEL})` })
    }
  }

  const snapshot = await hotelSnapshot().catch(() => '')
  const tools = await toolsForTenant()
  const ollamaMessages: any[] = [
    { role: 'system', content: (await systemPrompt(userCtx.roles)) + (snapshot ? `\n\n${snapshot}` : '') },
    ...messages,
  ]

  const iterations: any[] = []
  let finalText = ''

  for (let i = 0; i < 6; i++) {
    const iter: any = {
      index: i,
      requestMessages: ollamaMessages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content.slice(0, 500) : m.content })),
      llmTrace: null, toolCalls: [], done: false, fatalError: null,
    }

    try {
      const trace = await callLLMWithTrace(ollamaMessages, tools.openai)
      iter.llmTrace = trace

      if (trace.fatalError || trace.jsonError) {
        iter.fatalError = trace.fatalError ?? `JSON parse error: ${trace.jsonError}`
        iterations.push(iter); break
      }

      const msg = trace.normalized?.message
      if (!msg) { iter.fatalError = 'normalizeResponse devolvió null'; iterations.push(iter); break }

      if (!msg.tool_calls?.length) {
        finalText = msg.content ?? ''
        iter.done = true; iterations.push(iter); break
      }

      ollamaMessages.push(msg)

      for (const tc of msg.tool_calls) {
        const toolName = tc.function.name
        const rawArgs  = tc.function.arguments
        let toolArgs: any = null; let argsError: string | null = null
        try { toolArgs = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs }
        catch (e: any) { argsError = e.message }

        let result: any = null; let toolError: string | null = null
        const t1 = Date.now()
        if (!argsError) {
          try { result = await executeTool(toolName, toolArgs, userCtx) }
          catch (e: any) { toolError = e.message; result = { error: e.message } }
        } else {
          result = { error: `args parse error: ${argsError}` }
        }

        iter.toolCalls.push({ name: toolName, rawArgs, parsedArgs: toolArgs, argsError, result, toolError, elapsed: Date.now() - t1 })
        ollamaMessages.push({ role: 'tool', content: JSON.stringify(result) })
      }
    } catch (e: any) {
      iter.fatalError = e.message; iterations.push(iter); break
    }

    iterations.push(iter)
  }

  persist(finalText)
  return c.json({ finalText, iterations, backend: RUNPOD_BASE ? `RunPod (${MODEL})` : `Ollama (${MODEL})` })
})

// ── GET /api/ai/logs (SSE) ────────────────────────────────────────────────────
app.get('/logs', (_c) => {
  const encoder = new TextEncoder()
  let unsub: (() => void) | null = null

  const stream = new ReadableStream({
    start(controller) {
      for (const entry of getHistory()) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`))
      }
      unsub = subscribe((entry) => {
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)) }
        catch { unsub?.() }
      })
      const timer = setInterval(() => {
        try { controller.enqueue(encoder.encode(': ping\n\n')) }
        catch { clearInterval(timer) }
      }, 15_000)
    },
    cancel() { unsub?.() },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    },
  })
})

// ── GET /api/ai/usage — consumo de IA del tenant por mes (tokens, llamadas y
//    coste estimado). Solo dirección. ?months=N (por defecto 12, máx. 36).
app.get('/usage', zValidator('query', z.object({
  months: z.coerce.number().int().min(1).max(36).optional(),
})), async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Solo dirección puede ver el consumo de IA' }, 403)
  try {
    const months = c.req.valid('query').months ?? 12
    const rows = await db.select().from(aiUsage)
      .where(eq(aiUsage.propertyId, getPropertyId()))
      .orderBy(desc(aiUsage.month))
      .limit(months)
    return c.json({
      data: rows.map(r => ({
        month: r.month, calls: r.calls,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens,
        cacheWriteTokens: r.cacheWriteTokens, cacheReadTokens: r.cacheReadTokens,
        costUsd: Number(r.costUsd),
      })),
    })
  } catch (e) {
    return serverError(c, e)
  }
})

// ── POST /api/ai/daily-summary — resumen diario del hotel por email ──────────
// Pensado para lanzarse una vez al día vía cron (23:00 hora Madrid, ver
// scripts/daily-summary-cron.ts) con un JWT de sistema (isPrimary:true), igual
// que /api/fdm/sync-reservations. También se puede llamar a mano desde el
// navegador (con sesión de dirección) para forzar un envío de prueba.
//
// El agente redacta el informe entero usando sus tools normales (occupancy,
// caja, piscina/agua, inventario de desayunos...) con role "direccion" para
// desbloquear los tools restringidos. Solo 3 cosas no tienen tool propio hoy
// (gastos de caja de cambio, alertas activas, desglose de ropa por estado) —
// se precargan aquí abajo y se le pasan ya resueltas, para no tener que sumar
// tools nuevos al catálogo compartido con el chat normal por un caso de uso tan
// puntual.
app.post('/daily-summary', async (c) => {
  if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
  try {
    const prop       = await getProperty()
    const tz         = prop.timezone
    const [poolOn, laundryOn, cashOn] = await Promise.all([hasFeature('pool'), hasFeature('laundry'), hasFeature('cashDrawer')])
    const today      = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date())
    const monthStart = `${today.slice(0, 7)}-01`
    // Día 0 del mes siguiente = último día de este mes.
    const [monthY, monthM] = monthStart.split('-').map(Number) as [number, number]
    const monthEnd = new Date(Date.UTC(monthY!, monthM!, 0)).toISOString().slice(0, 10)

    // Ocupación día a día de TODO el mes en curso (1 al último día, pasado
    // real + reservas ya hechas para lo que queda de mes) — mismo cálculo
    // que Informes → Ocupación. Se precarga aquí (en vez de dejar que el
    // agente llame a get_occupancy_rate) por dos motivos: 1) get_occupancy_rate
    // exige date_from < date_to (al menos una noche completa), así que pedir
    // la ocupación de "hoy" con date_from=date_to=hoy devolvía "Rango de
    // fechas inválido" y el informe salía con esa sección vacía; 2) esta
    // misma consulta sirve también para el gráfico de ocupación del mes
    // incrustado en el email (ver renderOccupancyChartPng más abajo).
    const { data: monthOccByDay, totals: monthOccTotals } =
      await computeOccupancyReport({ from: monthStart, to: monthEnd, group: 'day' })
    const todayOcc = monthOccByDay.find(d => d.period === today) ?? null
    const chartPng = monthOccByDay.length > 0
      ? renderOccupancyChartPng({
          title: `Ocupación de ${new Date(monthStart + 'T12:00:00').toLocaleDateString('es-ES', { month: 'long', year: 'numeric' })}`,
          days: monthOccByDay.map(d => ({ label: d.label, occupancyPct: d.occupancyPct })),
          totalRevenue: monthOccTotals.revenue,
        })
      : null

    // JWT de sistema efímero para la llamada interna a /api/alerts/urgent — NO
    // se puede reenviar la cookie de la petición original: fetch() descarta en
    // silencio la cabecera Cookie por ser "forbidden header" del spec Fetch.
    const internalToken = await sign(
      { isPrimary: true, roles: ['direccion'], propertyId: getPropertyId(), exp: Math.floor(Date.now() / 1000) + 60 },
      env.JWT_SECRET, 'HS256',
    )
    const [alertsData, expenseRows, laundryRows, newBookingRows, pendingArrivalRows, afcReadings] = await Promise.all([
      fetch(new URL('/api/alerts/urgent', c.req.url), {
        headers: { Authorization: `Bearer ${internalToken}` },
      }).then(r => r.json()).catch((e: any) => ({ alerts: [], error: e.message })),
      db.select({
        description: changeDrawerExpenses.description,
        amount:      changeDrawerExpenses.amount,
        createdAt:   changeDrawerExpenses.createdAt,
      }).from(changeDrawerExpenses)
        .where(and(eq(changeDrawerExpenses.propertyId, getPropertyId()), drizzleSql`(${changeDrawerExpenses.createdAt} AT TIME ZONE ${tz})::date = ${today}::date`)),
      db.select({
        status: laundryProcessItems.status,
        count:  laundryProcessItems.count,
      }).from(laundryProcessItems)
        .innerJoin(laundryProcessBatches, eq(laundryProcessItems.batchId, laundryProcessBatches.id))
        .where(and(eq(laundryProcessBatches.propertyId, getPropertyId()), eq(laundryProcessBatches.date, today))),
      // Reservas HECHAS hoy (bookedAt), no las que tienen check-in hoy — no hay
      // tool que filtre por fecha de reserva, así que se precarga aquí.
      db.select({
        guestFirst: guests.firstName,
        guestLast:  guests.lastName,
        channel:    bookingChannels.name,
        total:      reservations.total,
      }).from(reservations)
        .leftJoin(guests, eq(reservations.guestId, guests.id))
        .leftJoin(bookingChannels, eq(reservations.bookingChannelId, bookingChannels.id))
        .where(and(eq(reservations.propertyId, getPropertyId()), drizzleSql`(${reservations.bookedAt} AT TIME ZONE ${tz})::date = ${today}::date`)),
      // Reservas con check-in HOY que aún tienen saldo pendiente de cobro —
      // no cuenta los depósitos retenidos sin cobrar como pago de la
      // estancia (ver src/lib/paymentAggregate.ts).
      db.select({
        id:         reservations.id,
        guestFirst: guests.firstName,
        guestLast:  guests.lastName,
        room:       rooms.code,
        total:      reservations.total,
      }).from(reservations)
        .leftJoin(guests, eq(reservations.guestId, guests.id))
        .leftJoin(rooms, eq(reservations.roomId, rooms.id))
        .where(and(eq(reservations.propertyId, getPropertyId()), and(
          eq(reservations.checkInDate, today),
          notInArray(reservations.status, ['cancelled', 'no_show']),
          drizzleSql`(${reservations.total}::numeric - (
            SELECT COALESCE(SUM(amount) FILTER (WHERE payment_method NOT IN ('deposit','deposit_cc')), 0)
                 + COALESCE(SUM(amount) FILTER (WHERE category = 'deposit_cobrado'), 0)
            FROM financial_transactions ft WHERE ft.reservation_id = ${reservations.id}
          )) > 0.01`,
        ))),
      // Nivel de cloro del agua corriente (AFC) — se precarga en vez de
      // dejar que el agente llame a get_pool_water_readings: al ser una
      // sección más entre 14 y no venir en el bloque "DATOS YA CARGADOS",
      // el modelo la omitía de forma poco fiable (mismo problema que tuvo
      // antes la ocupación del día).
      (poolOn && await poolControl.isConfigured())
        ? poolControl.getColdWaterReadings().catch((e: any) => ({ error: e.message }))
        : Promise.resolve({ error: 'Integración con el sistema de mantenimiento/piscina no configurada (falta POOL_API_URL/POOL_API_KEY).' }),
    ])

    // Última lectura de AFC (agua fría de consumo) — mismo shape que devuelve
    // get_pool_water_readings: { items: [...] } con las más recientes primero,
    // o { error } si no está configurado o la API de piscina falló.
    const afcLatest = (afcReadings as any).error
      ? afcReadings
      : ((afcReadings as any).items?.[0] ?? { message: 'Sin lecturas registradas' })

    const expensesTotal = expenseRows.reduce((s, e) => s + parseFloat(e.amount), 0)
    const laundryByStatus: Record<string, number> = { listas: 0, tendidas: 0, en_agua: 0, sucias: 0, rotas: 0 }
    for (const r of laundryRows) laundryByStatus[r.status] = (laundryByStatus[r.status] ?? 0) + r.count
    const newBookings = newBookingRows.map(r => ({
      guest:   [r.guestFirst, r.guestLast].filter(Boolean).join(' ') || 'Sin nombre',
      channel: r.channel ?? 'Directo',
      total:   parseFloat(r.total) || 0,
    }))
    const pendingArrivalsPaidById = await realPaidByReservation(pendingArrivalRows.map(r => r.id))
    const pendingArrivals = pendingArrivalRows.map(r => {
      const total = parseFloat(r.total) || 0
      const paid  = pendingArrivalsPaidById.get(r.id) ?? 0
      return {
        guest: [r.guestFirst, r.guestLast].filter(Boolean).join(' ') || 'Sin nombre',
        room:  r.room ?? 'Sin asignar',
        total, paid,
        due:   calcPendingBalance(total, paid),
      }
    })

    const systemExtra = `TAREA ESPECIAL DE HOY: no es una conversación — vas a redactar el CONTENIDO COMPLETO en HTML de un email de resumen diario para dirección, que se envía automáticamente cada noche a las 23:00. Responde directamente con el informe, sin preguntas ni confirmaciones previas.

FORMATO DE SALIDA — IMPORTANTE:
- Responde ÚNICAMENTE con el HTML del cuerpo del informe (sin <html>/<head>/<body>, sin bloques de código \`\`\`), listo para insertarse dentro de un email ya maquetado.
- Usa <h3> para cada sección y <p>/<ul><li> para el contenido. Cifras concretas (€, %, unidades) — nada de relleno ni disculpas.
- Español, tono directo y profesional. Breve por sección — una lista de 2-3 líneas basta si no hay más que contar.

Genera estas secciones EN ESTE ORDEN, para el día de hoy (${today}) salvo que se diga otra cosa:
1. Ocupación del día — usa los datos ya cargados abajo (NO llames a get_occupancy_rate ni a ningún otro tool para esto): ocupación %, habitaciones ocupadas/total e ingresos de hoy. Justo después de esta sección, en su propio párrafo, incluye exactamente esta línea sin modificarla: <img src="cid:occupancy-chart" alt="Ocupación del mes" style="max-width:100%;border:1px solid #eee;border-radius:6px" /> — es el gráfico de ocupación del mes en curso día a día, ya adjunto al email; no lo describas en texto ni repitas sus números, solo incrusta la imagen ahí.
2. Reservas nuevas de hoy — usa los datos ya cargados abajo (NO llames a ningún tool), son las reservas hechas hoy (no las que tienen check-in hoy). Indica el número total y luego preséntalas en una tabla HTML compacta con columnas Huésped, Canal e Importe — no una lista. Si no hubo ninguna, dilo en una línea y no pongas tabla vacía.

ESTILO DE CUALQUIER TABLA que uses en el informe (esta u otras): <table style="border-collapse:collapse;font-size:12px;width:100%"> con <thead>/<tbody>, cabeceras en <th style="text-align:left;padding:3px 8px;border-bottom:1px solid #ddd"> y celdas en <td style="padding:2px 8px;border-bottom:1px solid #eee">. Nada de padding grande ni fuente por defecto — deben verse compactas.
3. Llegadas de hoy pendientes de cobro — usa los datos ya cargados abajo (NO llames a ningún tool), son reservas con check-in HOY que aún tienen saldo pendiente (total − cobrado > 0), estén o no ya en casa. Indica el número total y la suma del pendiente, y luego una lista con huésped, habitación e importe pendiente de cada una. Si la lista está vacía, dilo en una línea ("Todas las llegadas de hoy están cobradas") y no le dediques más espacio.
4. Pagos por método de pago — get_daily_cash con date="${today}" (desglose por método y por caja/cuenta). NO uses get_invoices ni menciones facturas — a dirección no le interesa esa sección.
5. Gastos de caja de cambio hoy — usa los datos ya cargados abajo, NO llames a ningún tool para esto.
6. Alertas activadas ahora mismo — usa los datos ya cargados abajo, NO llames a ningún tool para esto.
7. Consumo de agua del día — get_water_tank_status con range="dia". Indica SOLO el consumo de hoy (litros). NO valores ni comentes si el nivel actual del tanque es bueno/malo/preocupante — el tool no marca eso como un problema salvo que el propio resultado incluya explícitamente un aviso o alerta; si no lo incluye, no lo interpretes tú ni añadas ningún comentario sobre el nivel, limítate al consumo.
8. Nivel de cloro del agua corriente — usa los datos ya cargados abajo (NO llames a get_pool_water_readings para esto), es la lectura más reciente de agua fría de consumo (AFC, control de legionela).
9. Registros de la piscina — get_pool_water_readings con type="piscina" (cloro/pH).
10. Elementos sin existencias en el inventario de desayunos — get_breakfast_inventory SIN date (te da el más reciente); lista los productos con cantidad_actual=0 e indica la fecha de ese inventario.
11. Ropa: prendas declaradas rotas, listas (limpias) y sucias hoy — usa los datos ya cargados abajo, NO llames a ningún tool para esto.
12. Housekeeping — get_housekeeping_status con date="${today}": cuántas tareas se han resuelto hoy (status=done) y quién las hizo (usa el campo assigned_to como quien la resolvió, son lo mismo aquí). Agrupa por persona, no listes habitación por habitación salvo que sean pocas.
13. Desayunos servidos — get_breakfast_summary con date_from=date_to="${today}": cuántos se han marcado como servidos sobre el total esperado.
14. "📈 Análisis y sugerencias de mejora" — cierra con 3-5 puntos breves sobre lo que has visto arriba: qué destaca, qué merece atención (descuadres, alertas repetidas, gasto inusual, tareas sin resolver, llegadas de hoy sin cobrar...) y alguna sugerencia concreta de mejora operativa. Aplica las DIRECTRICES DE DIRECCIÓN (objetivo 100% de ocupación): señala fechas próximas con ≤2 habitaciones libres, habitaciones bloqueadas que se podrían vender y posibles no-shows a revisar. No incluyas aquí ningún comentario sobre el nivel del tanque de agua.

${[
      !poolOn && 'El módulo de piscina/mantenimiento NO está activo en este hotel: OMITE por completo las secciones 7, 8, 9 y 10 (sin mencionarlas ni numerarlas).',
      !laundryOn && 'El módulo de lavandería NO está activo en este hotel: OMITE la sección 11.',
      !cashOn && 'El módulo de caja de cambio NO está activo en este hotel: OMITE la sección 5.',
    ].filter(Boolean).join('\n')}
Moneda del hotel: ${prop.currencyCode} (donde se escribe € usa la moneda del hotel). Nombre del hotel: ${prop.name}.

Si algún tool de piscina/agua/inventario devuelve error de "no configurada", dilo en una línea dentro de esa sección y sigue con el resto — no abandones el informe entero por eso.

DATOS YA CARGADOS (no llames a ningún tool para lo siguiente, usa estos datos directamente):

Ocupación de hoy (${today}):
${todayOcc ? JSON.stringify({ occupancy_pct: todayOcc.occupancyPct, rooms_occupied: todayOcc.roomNightsOccupied, rooms_available: todayOcc.roomNightsAvailable, revenue: todayOcc.revenue }) : 'sin datos'}

Reservas hechas hoy (${newBookings.length}):
${JSON.stringify(newBookings)}

Llegadas de hoy con saldo pendiente de cobro (${pendingArrivals.length}, total pendiente ${pendingArrivals.reduce((s, r) => s + r.due, 0).toFixed(2)}€):
${JSON.stringify(pendingArrivals)}

Gastos de caja de cambio hoy (total ${expensesTotal.toFixed(2)}€):
${JSON.stringify(expenseRows)}

Alertas activas ahora mismo:
${JSON.stringify(alertsData.alerts ?? alertsData)}

Ropa procesada hoy, recuento de prendas por estado (listas=limpias, sucias, en_agua, tendidas, rotas):
${JSON.stringify(laundryByStatus)}

Nivel de cloro del agua corriente (AFC, lectura más reciente):
${JSON.stringify(afcLatest)}`

    const { text, usage } = await runAgentLoopClaude(
      [{ role: 'user', content: `Genera el informe de hoy (${today}) siguiendo las instrucciones.` }],
      { roles: ['direccion'] },
      systemExtra,
      { maxIterations: 14, maxTokens: 8192 },
    )

    // La llamada al modelo puede fallar (sin crédito, rate limit, etc.) — en
    // ese caso runAgentLoopClaude devuelve un texto de disculpa genérico en
    // vez de lanzar. No lo mandes por email como si fuera el informe de
    // verdad: aborta y que el cron lo marque como fallo.
    if (text === AI_UNAVAILABLE_TEXT) {
      logErr('AI', 'Resumen diario: el modelo no respondió, no se envía email')
      return c.json({ error: 'El agente de IA no ha podido generar el informe (fallo al llamar al modelo) — revisa /api/ai/logs' }, 502)
    }

    const recipients = await db.selectDistinct({ email: users.email })
      .from(userRoles)
      .innerJoin(users, eq(userRoles.userId, users.id))
      .where(and(eq(users.propertyId, getPropertyId()), eq(userRoles.role, 'direccion'), eq(users.active, true)))
    const to = recipients.map(r => r.email).filter((e): e is string => !!e)
    if (to.length === 0) return c.json({ error: 'No hay usuarios con rol dirección con email configurado' }, 422)

    await sendDailySummaryEmail({ to, date: today, bodyHtml: text, chartPng: chartPng ?? undefined })
    log('AI', 'Resumen diario enviado', { to, date: today, length: text.length, costUsd: usage?.costUsd.toFixed(5) ?? '?' })

    return c.json({ data: { sent: true, to, date: today, costUsd: usage ? Number(usage.costUsd.toFixed(5)) : null } })
  } catch (err) {
    return serverError(c, err)
  }
})

export default app
