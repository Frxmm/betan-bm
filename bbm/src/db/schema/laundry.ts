import { pgTable, serial, integer, smallint, text, timestamp } from 'drizzle-orm/pg-core'
import { properties } from './core'

export const laundryDeliveries = pgTable('laundry_deliveries', {
  id:              serial('id').primaryKey(),
  propertyId:      integer('property_id').notNull().references(() => properties.id),
  date:            text('date').notNull(),
  deliveredById:   integer('delivered_by_id').notNull(),
  deliveredAt:     timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
  location:        text('location').notNull(),
  deliveredToId:   integer('delivered_to_id').notNull(),
  showerTowels:    smallint('shower_towels').notNull().default(0),
  handTowels:      smallint('hand_towels').notNull().default(0),
  sheetSets:       smallint('sheet_sets').notNull().default(0),
  footTowels:      smallint('foot_towels').notNull().default(0),
  notes:           text('notes'),
  // Confirmación de recepción por el receptor
  recipientStatus:       text('recipient_status'),        // null | 'ok' | 'discrepancy'
  recipientNote:         text('recipient_note'),
  recipientConfirmedAt:  timestamp('recipient_confirmed_at', { withTimezone: true }),
  // Reconocimiento de discrepancia por el entregador
  discrepancyAckAt:      timestamp('discrepancy_ack_at', { withTimezone: true }),
  discrepancyAckBy:      integer('discrepancy_ack_by'),
  // Completado: cuando el receptor cierra el procesado
  processedById:   integer('processed_by_id'),
  processedAt:     timestamp('processed_at', { withTimezone: true }),
  processBatchId:  integer('process_batch_id').references(() => laundryProcessBatches.id),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const laundryProcessBatches = pgTable('laundry_process_batches', {
  id:                   serial('id').primaryKey(),
  propertyId:           integer('property_id').notNull().references(() => properties.id),
  date:                 text('date').notNull(),
  processedById:        integer('processed_by_id').notNull(),
  recipientId:          integer('recipient_id'),   // receptor al que pertenece este batch parcial
  processedAt:          timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  distributionLocation: text('distribution_location').notNull(),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const laundryProcessItems = pgTable('laundry_process_items', {
  id:       serial('id').primaryKey(),
  batchId:  integer('batch_id').notNull().references(() => laundryProcessBatches.id, { onDelete: 'cascade' }),
  itemType: text('item_type').notNull(), // 'shower' | 'manos' | 'sabanas' | 'pies'
  status:   text('status').notNull(),   // 'listas' | 'tendidas' | 'en_agua' | 'sucias' | 'rotas'
  count:    smallint('count').notNull(),
})

export type LaundryDelivery      = typeof laundryDeliveries.$inferSelect
export type NewLaundryDelivery   = typeof laundryDeliveries.$inferInsert
export type LaundryProcessBatch  = typeof laundryProcessBatches.$inferSelect
export type LaundryProcessItem   = typeof laundryProcessItems.$inferSelect
