import { pgTable, serial, text, smallint, boolean, timestamp, integer, numeric, char, date } from 'drizzle-orm/pg-core'
import { properties } from './core'
import { bathroomTypeEnum, terraceTypeEnum, bedSizeEnum, viewTypeEnum } from './enums'

// ─── ROOM TYPES (tipos de habitación) ─────────────────────────────────────────

export const roomTypes = pgTable('room_types', {
  id:              serial('id').primaryKey(),
  propertyId:      integer('property_id').notNull().references(() => properties.id),
  name:            text('name').notNull(),
  description:     text('description'),
  prefix:          text('prefix'),
  // roomClass: categoría interna (FDM: 7=doble, 8=doble ensuite, 9=cuádruple...)
  roomClass:       smallint('room_class'),
  maxOccupancy:    smallint('max_occupancy').notNull().default(2),
  ensuite:         boolean('ensuite').notNull().default(true),
  allowExtraBeds:  smallint('allow_extra_beds').notNull().default(0),
  extraBedPrice:   numeric('extra_bed_price', { precision: 10, scale: 2 }).notNull().default('0'),
  defaultPrice:    numeric('default_price', { precision: 10, scale: 2 }).notNull().default('0'),
  orderIndex:          smallint('order_index').notNull().default(0),
  bookingEngineLabel:          text('booking_engine_label'),
  maxOccupancyBookingEngine:   smallint('max_occupancy_booking_engine'),
  isVirtual:                   boolean('is_virtual').notNull().default(false),
  color:               char('color', { length: 7 }),
  backgroundColor:     char('background_color', { length: 7 }),
  fontColor:           char('font_color', { length: 7 }),
  nobedsRoomId:        integer('nobeds_room_id'),
  // Derivación de precio respecto a otro tipo de habitación (misma idea que
  // rates.baseRateId/adjustType/adjustValue, pero aplicada al tipo de habitación:
  // ej. "Individual" = "Doble" -12%, para TODAS las tarifas por igual)
  baseRoomTypeId:  integer('base_room_type_id'),
  adjustType:      text('adjust_type'),   // 'fixed' | 'percentage' | 'amount'
  adjustValue:     numeric('adjust_value', { precision: 10, scale: 2 }),
  photoUrl:        text('photo_url'),
  active:          boolean('active').notNull().default(true),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:       timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RoomType = typeof roomTypes.$inferSelect
export type NewRoomType = typeof roomTypes.$inferInsert

// ─── ROOMS (habitaciones físicas) ─────────────────────────────────────────────

export const rooms = pgTable('rooms', {
  id:                 serial('id').primaryKey(),
  propertyId:         integer('property_id').notNull().references(() => properties.id),
  roomTypeId:         integer('room_type_id').notNull().references(() => roomTypes.id),
  // code: número visible de la habitación ("101", "201", "Cabaña 3"...)
  code:               text('code').notNull(),
  active:             boolean('active').notNull().default(true),
  orderIndex:         smallint('order_index').notNull().default(0),
  startingBedNumber:  smallint('starting_bed_number').notNull().default(1),
  // ── Características físicas ──────────────────────────────────────────────────
  bathroom:           bathroomTypeEnum('bathroom'),
  terrace:            terraceTypeEnum('terrace'),
  balcony:            boolean('balcony').notNull().default(false),
  bedSize:            bedSizeEnum('bed_size'),
  roomSizeSqm:        numeric('room_size_sqm', { precision: 6, scale: 1 }),
  view:               viewTypeEnum('view'),
  acBrand:            text('ac_brand'),
  tvBrand:            text('tv_brand'),
  lockType:           text('lock_type'),
  ttlockId:           text('ttlock_id'),
  // Token opaco para el QR de la habitación (src/routes/room-access.ts) — se
  // genera bajo demanda la primera vez que se pide el QR desde el panel, no
  // en la creación de la habitación. Deliberadamente NO es el id de la
  // habitación: si lo fuera, cualquiera podría adivinar la URL de otra
  // habitación sin escanear nada.
  qrToken:            text('qr_token').unique(),
  // Override de color respecto al tipo (opcional; si es null hereda del room type)
  color:              char('color', { length: 7 }),
  backgroundColor:    char('background_color', { length: 7 }),
  fontColor:          char('font_color', { length: 7 }),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Room = typeof rooms.$inferSelect
export type NewRoom = typeof rooms.$inferInsert

// ─── ROOM AVAILABILITY OVERRIDES (sobreescribe disponibilidad calculada) ──────

export const roomAvailOverrides = pgTable('room_avail_overrides', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().references(() => properties.id),
  roomTypeId: integer('room_type_id').notNull().references(() => roomTypes.id, { onDelete: 'cascade' }),
  date:       date('date').notNull(),
  maxAvail:   integer('max_avail').notNull(),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
