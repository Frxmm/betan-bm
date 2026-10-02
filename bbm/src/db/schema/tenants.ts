import { pgTable, serial, integer, text, jsonb, timestamp } from 'drizzle-orm/pg-core'
import { properties, users } from './core'

// ─── AUDITORÍA DE TENANTS (acciones de administradores de plataforma) ─────────
export const tenantAuditLog = pgTable('tenant_audit_log', {
  id:             serial('id').primaryKey(),
  platformUserId: integer('platform_user_id').references(() => users.id),
  propertyId:     integer('property_id').references(() => properties.id),
  action:         text('action').notNull(),
  details:        jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TenantAuditEntry = typeof tenantAuditLog.$inferSelect
