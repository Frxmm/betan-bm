import { pgTable, serial, integer, bigint, text, timestamp, boolean, numeric, primaryKey } from 'drizzle-orm/pg-core'
import { users, properties } from './core'

// Historial de conversaciones con el asistente IA — solo turnos de usuario/
// asistente (sin llamadas a tools intermedias), para poder responder cosas
// como "¿de qué ha hablado el equipo hoy con el asistente?" (solo dirección).
export const aiChatMessages = pgTable('ai_chat_messages', {
  id:        serial('id').primaryKey(),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Agrupa los turnos de una misma conversación — permite listar y recuperar
  // las últimas sesiones del usuario. Null en filas antiguas, de antes de
  // existir esta columna (quedan fuera del listado de sesiones, sin más).
  sessionId: text('session_id'),
  // 'chat'  = asistente normal (widget flotante / vista Agente), cualquier trabajador.
  // 'debug' = vista AI Debug (solo dirección) — aparte para no mezclarse con
  // get_staff_ai_activity ni con el historial de conversaciones reales.
  source:    text('source').notNull().default('chat'),
  role:      text('role').notNull(), // 'user' | 'assistant'
  content:   text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AiChatMessage = typeof aiChatMessages.$inferSelect

// Mensajes internos de dirección a otro usuario del sistema, entregados por el
// asistente IA (nunca a huéspedes — solo personal). `delivered` se marca en
// cuanto el asistente se los transmite al destinatario en el chat (con
// important=true NO se marca ahí, solo al confirmar lectura — ver abajo).
// important: dirección pidió expresamente que sea urgente/bloqueante — en vez
// de aparecer como burbuja de chat normal, se entrega como un popup que
// bloquea la pantalla del destinatario (ver ImportantStaffMessagePopup.tsx en
// el frontend y GET/POST /api/ai/important-messages).
// acknowledgedAt: cuándo el DESTINATARIO confirmó que lo leyó (tras esperar
// el bloqueo mínimo en el frontend) — a diferencia de `delivered` (que se
// pone solo con que el mensaje se haya mostrado), esto exige una acción
// explícita de quien lo recibe.
export const staffMessages = pgTable('staff_messages', {
  id:            serial('id').primaryKey(),
  fromUserId:    integer('from_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  toUserId:      integer('to_user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  message:       text('message').notNull(),
  delivered:     boolean('delivered').notNull().default(false),
  important:     boolean('important').notNull().default(false),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type StaffMessage = typeof staffMessages.$inferSelect

// Tareas programadas del asistente IA — el usuario le pide por chat algo como
// "envía un chiste sobre hoteles al personal cada dos días a horas
// randomizadas" y el asistente crea una fila aquí (tool create_scheduled_task
// en src/routes/ai.ts). El scheduler (startAiScheduledTasksScheduler, mismo
// archivo) revisa cada pocos minutos qué tareas tienen nextRunAt vencido, les
// hace correr `prompt` por el mismo bucle de agente que el chat normal (con
// los roles de quien la creó) y deja constancia de qué pasó.
export const aiScheduledTasks = pgTable('ai_scheduled_tasks', {
  id:            serial('id').primaryKey(),
  createdBy:     integer('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // Instrucción en lenguaje natural — se manda tal cual como turno de usuario
  // al agente en cada ejecución, con las mismas tools disponibles (puede
  // enviar mensajes, consultar datos, etc.) y los roles de createdBy.
  prompt:        text('prompt').notNull(),
  intervalDays:  integer('interval_days').notNull().default(1),
  // Ventana horaria (HH:MM, hora local del hotel) dentro de la que se sortea la
  // hora exacta de cada ejecución — "a horas randomizadas".
  timeWindowStart: text('time_window_start').notNull().default('09:00'),
  timeWindowEnd:   text('time_window_end').notNull().default('20:00'),
  active:        boolean('active').notNull().default(true),
  nextRunAt:     timestamp('next_run_at', { withTimezone: true }).notNull(),
  lastRunAt:     timestamp('last_run_at', { withTimezone: true }),
  // Resumen del resultado de la última ejecución (texto final del agente,
  // recortado) — para que dirección pueda comprobar que está funcionando sin
  // tener que revisar los logs.
  lastResult:    text('last_result'),
  lastError:     text('last_error'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AiScheduledTask = typeof aiScheduledTasks.$inferSelect

// Consumo del agente IA por tenant y mes — base para cobrar la IA por uso.
// Una fila por (property_id, month); `month` es 'YYYY-MM' en la zona horaria
// del hotel. Los tokens de caché de Anthropic se desglosan aparte porque se
// facturan a otro precio; cost_usd es el coste estimado a tarifas de la API.
// Se rellena en src/routes/ai.ts (recordAiUsage) y se lee con GET /api/ai/usage.
export const aiUsage = pgTable('ai_usage', {
  propertyId:       integer('property_id').notNull().references(() => properties.id, { onDelete: 'cascade' }),
  month:            text('month').notNull(),
  inputTokens:      bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens:     bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cacheWriteTokens: bigint('cache_write_tokens', { mode: 'number' }).notNull().default(0),
  cacheReadTokens:  bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
  calls:            integer('calls').notNull().default(0),
  costUsd:          numeric('cost_usd', { precision: 12, scale: 5 }).notNull().default('0'),
  updatedAt:        timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.month] })])

export type AiUsage = typeof aiUsage.$inferSelect
