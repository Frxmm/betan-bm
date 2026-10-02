import { pgTable, serial, text, timestamp, integer } from 'drizzle-orm/pg-core'
import { properties, users } from './core'
import { guests } from './guests'
import { reservations } from './reservations'

// ─── GUEST CONTRACTS (contratos de admisión firmados en el móvil) ─────────────

export const guestContracts = pgTable('guest_contracts', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().references(() => properties.id),
  reservationId: integer('reservation_id').notNull().references(() => reservations.id),
  guestId:       integer('guest_id').notNull().references(() => guests.id),
  token:         text('token').notNull().unique(),
  // pending | signed | cancelled
  status:        text('status').notNull().default('pending'),
  // HTML autocontenido del contrato firmado (firma embebida en base64)
  contractHtml:  text('contract_html'),
  signedAt:      timestamp('signed_at', { withTimezone: true }),
  signedIp:      text('signed_ip'),
  expiresAt:     timestamp('expires_at', { withTimezone: true }).notNull(),
  createdBy:     integer('created_by').references(() => users.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type GuestContract = typeof guestContracts.$inferSelect
export type NewGuestContract = typeof guestContracts.$inferInsert
