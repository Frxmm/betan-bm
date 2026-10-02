import { pgTable, serial, integer, text, timestamp, date, index } from 'drizzle-orm/pg-core'
import { properties, users } from './core'
import { reservations } from './reservations'
import { guests } from './guests'

// ─── FEEDBACK DE HUÉSPEDES (hilos de trabajo) ──────────────────────────────────
// Todo lo que dice un huésped (queja, elogio, sugerencia, comentario neutro) es
// calificable y abre un hilo con responsable, estado y plazo. Los hilos los
// abre cualquier miembro del equipo o el agente de IA (source='ai').
export const feedbackThreads = pgTable('feedback_threads', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().references(() => properties.id),
  reservationId: integer('reservation_id').references(() => reservations.id),
  guestId:       integer('guest_id').references(() => guests.id),
  // Dónde lo dijo: booking | whatsapp | email | verbal | encuesta | otro
  channel:       text('channel').notNull().default('verbal'),
  text:          text('text').notNull(),
  // positive | neutral | complaint | suggestion
  sentiment:     text('sentiment').notNull().default('neutral'),
  // limpieza | ruido | camas | wifi | desayuno | ducha | checkin | precio | trato | ubicacion | otro
  category:      text('category').notNull().default('otro'),
  // open | in_progress | resolved | wontfix
  status:        text('status').notNull().default('open'),
  assigneeId:    integer('assignee_id').references(() => users.id),
  dueDate:       date('due_date'),
  source:        text('source').notNull().default('staff'),   // staff | ai
  createdBy:     integer('created_by').references(() => users.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  resolvedAt:    timestamp('resolved_at', { withTimezone: true }),
}, t => [index('feedback_threads_status_idx').on(t.status, t.createdAt)])

export const feedbackComments = pgTable('feedback_comments', {
  id:        serial('id').primaryKey(),
  threadId:  integer('thread_id').notNull().references(() => feedbackThreads.id, { onDelete: 'cascade' }),
  authorId:  integer('author_id').references(() => users.id),
  text:      text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type FeedbackThread = typeof feedbackThreads.$inferSelect
