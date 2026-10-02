import { pgTable, serial, integer, text, boolean, timestamp, unique, primaryKey } from 'drizzle-orm/pg-core'
import { properties } from './core'
import { rooms } from './rooms'

export const housekeepingTasks = pgTable('housekeeping_tasks', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  date:         text('date').notNull(),                        // YYYY-MM-DD
  roomId:       integer('room_id').notNull().references(() => rooms.id),
  taskType:     text('task_type').notNull().default('stay'),   // 'stay' | 'departure'
  assignedTo:   integer('assigned_to'),                        // users.id nullable
  assignedAt:   timestamp('assigned_at', { withTimezone: true }), // momento de la asignación actual (null si no está asignada)
  status:       text('status').notNull().default('pending'),   // 'pending' | 'done' | 'dnd'
  linenChanges: text('linen_changes').array().notNull().default([]),
  dnd:          boolean('dnd').notNull().default(false),
  notes:        text('notes'),
  completedAt:  timestamp('completed_at', { withTimezone: true }),
  completedBy:  integer('completed_by'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.date, t.roomId)])

export type HousekeepingTask    = typeof housekeepingTasks.$inferSelect
export type NewHousekeepingTask = typeof housekeepingTasks.$inferInsert

// Tareas de limpieza de zonas comunes (no ligadas a ninguna habitación) —
// misma idea que housekeepingTasks pero sin lencería/DND/objetos robados: solo
// asignación y marcar limpio/pendiente. Las 8 zonas son fijas (ver COMMON_AREAS
// en src/routes/housekeeping.ts), areaKey las identifica.
export const commonAreaTasks = pgTable('common_area_tasks', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().references(() => properties.id),
  date:        text('date').notNull(),
  areaKey:     text('area_key').notNull(),
  assignedTo:  integer('assigned_to'),
  assignedAt:  timestamp('assigned_at', { withTimezone: true }),
  status:      text('status').notNull().default('pending'), // 'pending' | 'done'
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedBy: integer('completed_by'),
  // Solo aplica a las zonas de baño (ver COMMON_AREAS[].isBathroom) — marca
  // independiente de "limpio": se puede reponer el papel antes, después o
  // sin llegar a marcar la zona como limpia ese día.
  paperRefilledAt: timestamp('paper_refilled_at', { withTimezone: true }),
  paperRefilledBy: integer('paper_refilled_by'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('common_area_tasks_property_date_area_uniq').on(t.propertyId, t.date, t.areaKey)])

export type CommonAreaTask    = typeof commonAreaTasks.$inferSelect
export type NewCommonAreaTask = typeof commonAreaTasks.$inferInsert

// Por tenant: PK (property_id, date)
export const breakfastNoService = pgTable('breakfast_no_service', {
  propertyId: integer('property_id').notNull().default(1).references(() => properties.id),
  date:     text('date').notNull(),
  markedAt: timestamp('marked_at', { withTimezone: true }).notNull().defaultNow(),
  markedBy: integer('marked_by'),
}, t => [primaryKey({ columns: [t.propertyId, t.date] })])

// Valoración diaria de cómo fue el servicio de desayunos (1-10, ver
// constante RATING_SCALE en housekeeping.ts): 1 = muchas quejas, 5 = alguna
// queja, 10 = ninguna queja, todo perfecto. La pone quien lo sirve
// (housekeeping/recepción), una vez al día.
export const breakfastServiceRatings = pgTable('breakfast_service_ratings', {
  propertyId: integer('property_id').notNull().default(1).references(() => properties.id),
  date:      text('date').notNull(),
  rating:    integer('rating').notNull(),
  notes:     text('notes'),
  ratedAt:   timestamp('rated_at', { withTimezone: true }).notNull().defaultNow(),
  ratedBy:   integer('rated_by'),
}, t => [primaryKey({ columns: [t.propertyId, t.date] })])
