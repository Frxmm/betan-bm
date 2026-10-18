import { pgTable, serial, text, char, integer, boolean, timestamp, unique, jsonb, primaryKey } from 'drizzle-orm/pg-core'
import { staffRoleEnum } from './enums'

// ─── PROPERTIES ───────────────────────────────────────────────────────────────

export const properties = pgTable('properties', {
  id:           serial('id').primaryKey(),
  name:         text('name').notNull(),
  address:      text('address'),
  city:         text('city'),
  countryCode:  char('country_code', { length: 2 }),
  phone:        text('phone'),
  email:        text('email'),
  vatNumber:    text('vat_number'),
  logoUrl:      text('logo_url'),
  currencyCode: char('currency_code', { length: 3 }).notNull().default('EUR'),
  timezone:     text('timezone').notNull().default('Europe/Madrid'),
  // Tarifas y tipos de habitación que se muestran por defecto en el calendario
  // de precios (null = mostrar todas). Configurable en Ajustes → Configuración.
  defaultCalendarRateIds:     jsonb('default_calendar_rate_ids').$type<number[]>(),
  defaultCalendarRoomTypeIds: jsonb('default_calendar_room_type_ids').$type<number[]>(),
  // Nº de días que carga el calendario de precios al abrirlo, por defecto.
  defaultCalendarDays:        integer('default_calendar_days').notNull().default(30),
  ttlockCardEnrollEnabled:    boolean('ttlock_card_enroll_enabled').notNull().default(true),
  // Nombres/apellidos que no se pueden guardar al crear/editar un huésped —
  // p.ej. "Recepción", "Hotel", el nombre del hotel (placeholders que a veces se teclean
  // por error en vez del nombre real). Comparación normalizada (sin mayúsculas
  // ni acentos) contra firstName/lastName/secondLastName. Configurable en
  // Reservas → Configuración.
  blockedGuestNames:          text('blocked_guest_names').array().notNull().default([]),
  // Canales de venta exentos de la regla "debe estar saldada para hacer
  // check-in" — reservas de estos canales pueden generar/(re)enviar el
  // código de puerta TTLock aunque tengan saldo pendiente (p.ej. canales que
  // cobran ellos aparte, como Booking.com de pago en destino gestionado por
  // el canal). Configurable en Reservas → Configuración.
  ttlockBalanceExemptChannelIds: jsonb('ttlock_balance_exempt_channel_ids').$type<number[]>().notNull().default([]),
  // ── Tenant: identidad y branding (ver drizzle/0133_multitenant.sql) ──
  slug:                    text('slug').unique(),
  legalName:               text('legal_name'),
  touristRegistryNumber:   text('tourist_registry_number'),
  postalCode:              text('postal_code'),
  region:                  text('region'),
  websiteUrl:              text('website_url'),
  publicDomain:            text('public_domain'),
  receptionEmail:          text('reception_email'),
  fromEmail:               text('from_email'),
  mapsUrl:                 text('maps_url'),
  starLabel:               text('star_label'),
  localeDefault:           text('locale_default').notNull().default('es'),
  admissionTermsHtml:      text('admission_terms_html'),
  // Ajustes libres por tenant (pricing.rootRateId, fdm.*, jumbo.*, secrets.*…) y módulos activos
  settings:                jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
  features:                jsonb('features').$type<Record<string, boolean>>().notNull().default({}),
  active:                  boolean('active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Property = typeof properties.$inferSelect
export type NewProperty = typeof properties.$inferInsert

// ─── CURRENCIES ───────────────────────────────────────────────────────────────

export const currencies = pgTable('currencies', {
  id:   serial('id').primaryKey(),
  code: char('code', { length: 3 }).notNull().unique(),
  name: text('name').notNull(),
})

export type Currency = typeof currencies.$inferSelect

// ─── COUNTRIES ────────────────────────────────────────────────────────────────

export const countries = pgTable('countries', {
  id:          serial('id').primaryKey(),
  code:        char('code', { length: 2 }).notNull().unique(),
  codeAlpha3:  char('code_alpha3', { length: 3 }),
  name:        text('name').notNull(),
  currencyId:  integer('currency_id').references(() => currencies.id),
})

export type Country = typeof countries.$inferSelect

// ─── USERS (staff) ────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  email:        text('email').notNull().unique(),
  firstName:    text('first_name').notNull(),
  lastName:     text('last_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  isPrimary:    boolean('is_primary').notNull().default(false),
  hourlyWage:   text('hourly_wage'),
  languageCode: char('language_code', { length: 2 }).notNull().default('es'),
  dni:          text('dni'),
  phone:        text('phone'),
  avatarUrl:    text('avatar_url'),
  lastLoginAt:  timestamp('last_login_at', { withTimezone: true }),
  active:       boolean('active').notNull().default(true),
  // sessionVersion: se incluye en el JWT al hacer login; requireAuth la
  // compara contra esta columna en cada petición. Incrementarla (botón
  // "Cerrar sesión" en Usuarios, solo Dirección) invalida al instante
  // CUALQUIER token ya emitido para ese usuario — los JWT no tienen estado
  // propio, así es como se fuerza un cierre de sesión real.
  sessionVersion: integer('session_version').notNull().default(1),
  // Fuerza la vista de "Resumen rápido" (AdminQuickStats) como pantalla única
  // durante toda la sesión de este usuario — sin sidebar, sin resto de la app,
  // sin forma de cerrarla salvo cerrar sesión. Solo tiene sentido para
  // dirección; se activa desde la ficha de usuario (Usuarios → Editar).
  simplifiedAdminMode: boolean('simplified_admin_mode').notNull().default(false),
  // Administrador de la plataforma: gestiona tenants (página "Tenants")
  isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type User    = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

// ─── PASSWORD RESET TOKENS ─────────────────────────────────────────────────
// Token de un solo uso para restablecer contraseña por email (autoservicio
// desde Login, o disparado por dirección desde Usuarios). El envío en sí
// está limitado a 1 cada 15 min por email (en memoria, ver src/routes/auth.ts)
// — este expiresAt es la validez del ENLACE una vez enviado (más largo).
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id:        serial('id').primaryKey(),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token:     text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt:    timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect

export const userPreferences = pgTable('user_preferences', {
  id:         serial('id').primaryKey(),
  userId:     integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  theme:      text('theme').notNull().default('dark'),
  fontFamily: text('font_family').notNull().default('system'),
  fontSize:   integer('font_size').notNull().default(14),
  // Fondo de pantalla del dashboard, elegido por el usuario en conversación con el asistente IA
  dashboardBgUrl:    text('dashboard_bg_url'),
  dashboardBgCredit: text('dashboard_bg_credit'),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.userId)])

export type UserPreferences = typeof userPreferences.$inferSelect

// ─── USER ROLES (roles del personal) ─────────────────────────────────────────

export const userRoles = pgTable('user_roles', {
  id:     serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role:   staffRoleEnum('role').notNull(),
}, t => [unique().on(t.userId, t.role)])

export type UserRole = typeof userRoles.$inferSelect

// ─── ALERT CONFIGS ────────────────────────────────────────────────────────────

// Por tenant: PK (property_id, alert_type).
export const alertConfigs = pgTable('alert_configs', {
  propertyId: integer('property_id').notNull().default(1).references(() => properties.id),
  alertType: text('alert_type').notNull(),
  label:     text('label').notNull(),
  enabled:   boolean('enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.alertType] })])

export type AlertConfig = typeof alertConfigs.$inferSelect

// ─── ALERT SEEN MARKS ─────────────────────────────────────────────────────────
// Para alertas que se "leen" al visitar una vista concreta (en vez de resolverse
// solas): guarda cuándo se vio por última vez cada tipo, y la alerta solo
// considera novedades posteriores a esa marca.

export const alertSeenMarks = pgTable('alert_seen_marks', {
  propertyId: integer('property_id').notNull().default(1).references(() => properties.id),
  alertType: text('alert_type').notNull(),
  seenAt:    timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.alertType] })])

export type AlertSeenMark = typeof alertSeenMarks.$inferSelect
