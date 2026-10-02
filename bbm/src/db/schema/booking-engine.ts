import { pgTable, serial, text, timestamp, integer, numeric, date, boolean, jsonb } from 'drizzle-orm/pg-core'
import { reservations } from './reservations'

export const customerTokens = pgTable('customer_tokens', {
  id:        serial('id').primaryKey(),
  email:     text('email').notNull(),
  token:     text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt:    timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─── ABANDONED CARTS (carritos web sin pagar: registro + recuperación) ────────

export const abandonedCarts = pgTable('abandoned_carts', {
  id:              serial('id').primaryKey(),
  reservationId:   integer('reservation_id').notNull().unique().references(() => reservations.id),
  email:           text('email'),
  phone:           text('phone'),
  guestName:       text('guest_name'),
  amount:          numeric('amount', { precision: 10, scale: 2 }).notNull().default('0'),
  checkIn:         date('check_in'),
  checkOut:        date('check_out'),
  roomTypeId:      integer('room_type_id'),
  // Recuperación con descuento
  recoveryToken:   text('recovery_token').unique(),
  discountPct:     integer('discount_pct').notNull().default(10),
  emailSentAt:     timestamp('email_sent_at', { withTimezone: true }),
  // Motivo del fallo si el email de recuperación no se pudo enviar (Resend
  // devuelve el error sin lanzar excepción, o falla la conexión) — null si se
  // envió bien o si no se llegó a intentar (sin email, canal desactivado...).
  emailError:      text('email_error'),
  // Motivo por el que NO se intentó enviar el email (a diferencia de
  // emailError, que es un intento que falló) — p.ej. "no es cliente nuevo",
  // "sin email", canal desactivado, Resend sin configurar. Null si sí se
  // intentó (haya ido bien o mal).
  emailSkipReason: text('email_skip_reason'),
  whatsappSentAt:  timestamp('whatsapp_sent_at', { withTimezone: true }),
  whatsappError:   text('whatsapp_error'),
  expiresAt:       timestamp('expires_at', { withTimezone: true }),
  recoveredAt:     timestamp('recovered_at', { withTimezone: true }),
  recoveredAmount: numeric('recovered_amount', { precision: 10, scale: 2 }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type AbandonedCart = typeof abandonedCarts.$inferSelect

// ─── CART RECOVERY SETTINGS (configuración de recuperación de carritos) ───────

export type DiscountTier = { threshold: number; pct: number }

export const cartRecoverySettings = pgTable('cart_recovery_settings', {
  id:              serial('id').primaryKey(),
  propertyId:       integer('property_id').notNull().default(1).unique(),
  enabled:         boolean('enabled').notNull().default(true),
  minAgeMin:       integer('min_age_min').notNull().default(20),
  maxAgeHours:     integer('max_age_hours').notNull().default(24),
  validityHours:   integer('validity_hours').notNull().default(24),
  // Tramos de descuento: [{ threshold: 3500, pct: 25 }, ...] ordenados de mayor a menor
  discountTiers:   jsonb('discount_tiers').$type<DiscountTier[]>().notNull().default([
    { threshold: 3500, pct: 25 },
    { threshold: 2000, pct: 20 },
    { threshold: 1000, pct: 15 },
    { threshold: 0,    pct: 10 },
  ]),
  // Criterios de cliente nuevo (AND: deben cumplirse todos los activos)
  // targetNewPhone:   el teléfono del huésped no existe en ningún otro perfil de huésped
  // targetNewName:    el nombre+apellido normalizados no existen en ningún otro perfil
  // targetFirstTime:  el huésped no tiene ninguna reserva anterior completada
  targetNewPhone:    boolean('target_new_phone').notNull().default(true),
  targetNewName:     boolean('target_new_name').notNull().default(true),
  targetFirstTime:   boolean('target_first_time').notNull().default(true),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CartRecoverySettings = typeof cartRecoverySettings.$inferSelect

// ─── CANCELLATION RECOVERY (reenganche de reservas canceladas con descuento) ──
// Mismo patrón que abandonedCarts/cartRecoverySettings, pero el disparador es
// una reserva CANCELADA (no un carrito sin pagar) — la recuperación NO revive
// la reserva original (tiene su propio rastro de auditoría/cancelación ya
// cerrado), crea una reserva NUEVA con la MISMA tarifa, a precio rebajado.
// Ver src/lib/cancellationRecovery.ts.

export const cancellationRecoveries = pgTable('cancellation_recoveries', {
  id:              serial('id').primaryKey(),
  // La reserva CANCELADA original — de ahí sale el huésped/fechas/tarifa.
  reservationId:   integer('reservation_id').notNull().unique().references(() => reservations.id),
  email:           text('email'),
  phone:           text('phone'),
  guestName:       text('guest_name'),
  checkIn:         date('check_in').notNull(),
  checkOut:        date('check_out').notNull(),
  roomTypeId:      integer('room_type_id'),
  rateId:          integer('rate_id'),
  // originalAmount: lo que costó/iba a costar la reserva cancelada.
  originalAmount:  numeric('original_amount', { precision: 10, scale: 2 }).notNull(),
  // currentAmount: lo que costaría HOY esa misma estancia con la MISMA tarifa
  // (repricing) — null si ya no se puede calcular (tarifa/tipo eliminados).
  currentAmount:   numeric('current_amount', { precision: 10, scale: 2 }),
  // baseAmount: el menor de los dos anteriores — sobre el que se aplica el %.
  baseAmount:      numeric('base_amount', { precision: 10, scale: 2 }).notNull(),
  discountPct:     integer('discount_pct').notNull().default(15),
  discountedAmount: numeric('discounted_amount', { precision: 10, scale: 2 }).notNull(),
  recoveryToken:   text('recovery_token').unique(),
  // newReservationId: la reserva NUEVA (tentative) creada al pulsar el enlace,
  // antes de pagar — se confirma sola vía el webhook de Stripe normal, igual
  // que cualquier reserva nueva del motor de reservas.
  newReservationId: integer('new_reservation_id'),
  emailSentAt:     timestamp('email_sent_at', { withTimezone: true }),
  emailError:      text('email_error'),
  emailSkipReason: text('email_skip_reason'),
  whatsappSentAt:  timestamp('whatsapp_sent_at', { withTimezone: true }),
  whatsappError:   text('whatsapp_error'),
  expiresAt:       timestamp('expires_at', { withTimezone: true }),
  recoveredAt:     timestamp('recovered_at', { withTimezone: true }),
  recoveredAmount: numeric('recovered_amount', { precision: 10, scale: 2 }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CancellationRecovery = typeof cancellationRecoveries.$inferSelect

export const cancellationRecoverySettings = pgTable('cancellation_recovery_settings', {
  id:            serial('id').primaryKey(),
  propertyId:       integer('property_id').notNull().default(1).unique(),
  enabled:       boolean('enabled').notNull().default(true),
  // Espera desde que se cancela hasta que se manda la oferta (da margen a un
  // cancel accidental que se revierte a mano) y ventana máxima de antigüedad
  // de la cancelación en la que aún merece la pena intentarlo.
  minAgeHours:   integer('min_age_hours').notNull().default(2),
  maxAgeHours:   integer('max_age_hours').notNull().default(12),
  validityHours: integer('validity_hours').notNull().default(48),
  discountPct:   integer('discount_pct').notNull().default(15),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CancellationRecoverySettings = typeof cancellationRecoverySettings.$inferSelect

// ─── TEMPORARY DISCOUNT (descuento temporal en la propia página de reserva) ───
// Distinto de cart-recovery/cancellation-recovery: no se manda nada por email,
// vive entera dentro de la sesión de reserva en curso. Se activa a los
// `activationMinutes` de que el cliente rellene sus datos (email, nombre) en
// el motor de reservas, y solo es válido hasta `activationMinutes +
// windowMinutes` desde ese mismo instante — si no ha completado y pagado la
// reserva para entonces, el descuento deja de aplicar.

export const temporaryDiscountSettings = pgTable('temporary_discount_settings', {
  id:                serial('id').primaryKey(),
  propertyId:       integer('property_id').notNull().default(1).unique(),
  enabled:           boolean('enabled').notNull().default(false),
  activationMinutes: integer('activation_minutes').notNull().default(5),
  windowMinutes:     integer('window_minutes').notNull().default(30),
  discountPct:       integer('discount_pct').notNull().default(10),
  updatedAt:         timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TemporaryDiscountSettings = typeof temporaryDiscountSettings.$inferSelect

// Un timer por intento de reserva — se crea al rellenar email+nombre, se
// consulta y se consume (usedAt) al confirmar el pago en /public/checkout.
// email/firstName/lastName se guardan para que el descuento solo se pueda
// canjear con esos mismos datos (evita que un token ajeno, visto u obtenido
// por casualidad, se cuele en la reserva de otra persona) y para limitar un
// uso REAL (usedAt) por email o nombre normalizado cada 2 días (ver POST
// /public/discount-timer) — que no se pueda repetir sin más reabriendo la
// página.
export const bookingDiscountTimers = pgTable('booking_discount_timers', {
  id:            serial('id').primaryKey(),
  token:         text('token').notNull().unique(),
  email:         text('email').notNull(),
  firstName:     text('first_name'),
  lastName:      text('last_name'),
  startedAt:     timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt:        timestamp('used_at', { withTimezone: true }),
  reservationId: integer('reservation_id').references(() => reservations.id),
  // % e importe realmente aplicados al consumirse (ver POST /checkout y
  // /checkout/resume) — para poder mostrar "descuento ya aplicado" al volver
  // a la pantalla de completar pago sin tener que recalcularlo.
  discountPct:    integer('discount_pct'),
  discountAmount: numeric('discount_amount', { precision: 10, scale: 2 }),
})

export type BookingDiscountTimer = typeof bookingDiscountTimers.$inferSelect
