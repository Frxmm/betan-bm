import { pgTable, serial, integer, text, timestamp } from 'drizzle-orm/pg-core'
import { properties, users } from './core'
import { reservations } from './reservations'

// ─── ALERT EVENTS (historial de alertas) ───────────────────────────────────────
// El sistema de alertas (GET /api/alerts/urgent) se recalcula en vivo a partir
// del estado actual de la BD — no queda ningún rastro de cuándo se activó o se
// resolvió cada una. Esta tabla es ese rastro: cada vez que /urgent detecta una
// alerta activa se abre (o se refresca, si ya estaba abierta) una fila aquí;
// cuando la condición deja de cumplirse, se cierra sola (resolvedAt). Sirve
// para: 1) listar en la vista Alertas qué estuvo activo en un rango de fechas,
// 2) "silenciar" una alerta activa (oculta de la barra hasta que se resuelva
// o vuelva a aparecer más tarde como una alerta nueva), 3) alertas creadas a
// mano (no ligadas a ninguna condición en vivo — ver "Comunicarse con
// Dirección").
export const alertEvents = pgTable('alert_events', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().references(() => properties.id),
  // alertType: la clave estable del tipo (coincide con alert_configs.alertType
  // cuando la alerta es de las automáticas; para las creadas a mano, un tipo
  // propio como 'direccion-urgente').
  alertType:     text('alert_type').notNull(),
  // entityKey: el id concreto de ESTA ocurrencia, tal cual lo devuelve /urgent
  // (p.ej. "unpaid-42") — a lo sumo una fila abierta (resolvedAt IS NULL) por
  // entityKey a la vez.
  entityKey:     text('entity_key').notNull(),
  message:       text('message').notNull(),
  severity:      text('severity').notNull().default('urgent'),
  reservationId: integer('reservation_id').references(() => reservations.id),
  // audienceRole: null = visibilidad normal de esa alerta; con valor, solo se
  // muestra a usuarios con ese rol (p.ej. 'recepcion' para "Comunicarse con
  // Dirección", que la crea dirección pero es recepción quien debe verla).
  audienceRole:  text('audience_role'),
  firstSeenAt:   timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt:    timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  // resolvedAt: la condición dejó de cumplirse sola (automáticas) o se marcó
  // resuelta a mano (p.ej. "Comunicarse con Dirección" tras atenderla).
  resolvedAt:    timestamp('resolved_at', { withTimezone: true }),
  // resolvedBy: solo cuando se resuelve con una acción explícita identificable
  // (botón "Hecho" en una alerta manual, "no-show-confirm"...) — null cuando se
  // resuelve sola (la condición dejó de cumplirse, p.ej. alguien pagó) porque
  // ahí no hay una persona concreta a la que atribuírselo. Usado por el
  // resumen de fin de turno (src/lib/shiftEndReport.ts) para dar +1 por cada
  // alerta roja resuelta que no sea "suya" (createdBy distinto de quien la resolvió).
  resolvedBy:    integer('resolved_by').references(() => users.id),
  silencedAt:    timestamp('silenced_at', { withTimezone: true }),
  silencedBy:    integer('silenced_by').references(() => users.id),
  // createdBy: solo en las creadas a mano desde la vista Alertas — null en las
  // automáticas.
  createdBy:     integer('created_by').references(() => users.id),
})

export type AlertEvent = typeof alertEvents.$inferSelect
