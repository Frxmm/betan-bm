import { pgTable, serial, integer, text, numeric, date, timestamp } from 'drizzle-orm/pg-core'
import { properties, users } from './core'
import { roomTypes } from './rooms'

// ─── OFERTAS CORPORATIVAS (precio fijo semanal a empresas) ─────────────────────
// Empresa = una reserva cuyo NIF de facturación (reservations.billingNif) tiene
// forma de CIF (letra + 8 caracteres), no de DNI/NIE de particular — ver
// src/lib/corporateDetection.ts. No hay tabla de "empresas": se agregan sobre
// la marcha desde reservations, esta tabla solo guarda las OFERTAS que se les
// hacen.
export const corporateOffers = pgTable('corporate_offers', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  companyName:  text('company_name').notNull(),
  companyNif:   text('company_nif'),
  roomTypeId:   integer('room_type_id').references(() => roomTypes.id),
  weeklyPrice:  numeric('weekly_price', { precision: 10, scale: 2 }).notNull(),
  validFrom:    date('valid_from').notNull(),
  validTo:      date('valid_to').notNull(),
  notes:        text('notes'),
  // draft | sent | accepted | rejected | expired
  status:       text('status').notNull().default('draft'),
  createdBy:    integer('created_by').references(() => users.id),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sentAt:       timestamp('sent_at', { withTimezone: true }),
  decidedAt:    timestamp('decided_at', { withTimezone: true }),
})

export type CorporateOffer = typeof corporateOffers.$inferSelect
