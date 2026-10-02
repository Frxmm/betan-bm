import { pgTable, serial, integer, text, numeric, date, timestamp, boolean, jsonb, unique } from 'drizzle-orm/pg-core'
import { properties } from './core'

// ─── COMPETITOR HOTELS ──────────────────────────────────────────────────────
// Hoteles competidores a comparar precios — el precio se lee directamente de
// la API pública que su propio motor de reservas expone (la que usa su
// página web para pintar el calendario de precios), nunca de Booking.com u
// otra OTA (scraping ahí incumple sus términos de uso). Cada "platform"
// soportada tiene su propio parser en src/lib/competitorPricing.ts.
export const competitorHotels = pgTable('competitor_hotels', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().references(() => properties.id),
  name:       text('name').notNull(),
  // 'paraty' | 'cloudbeds' — motor de reservas del competidor.
  platform:   text('platform').notNull(),
  // Config específica de esa plataforma:
  //   paraty:    { namespace: string, websiteUrl: string, apiBaseUrl?: string }
  //              apiBaseUrl es opcional — por defecto
  //              https://<namespace>-dot-online-secure-booking.appspot.com,
  //              pero algunos hoteles sirven Paraty desde su propio dominio
  //              (proxy inverso), hay que indicarlo explícito en ese caso.
  //   cloudbeds: { baseUrl: string }  (ej. "https://www.sunserramar.com")
  config:     jsonb('config').notNull().default({}),
  // El precio leído de su web es tarifa de mostrador — un cliente cualquiera
  // suele sacar bastante menos en Booking.com (Genius + rebaja adicional).
  // Cada competidor tiene su propio descuento efectivo aproximado, así que es
  // configurable por hotel (no una constante global) — el precio guardado se
  // divide entre este valor. 1 = no aplicar ningún ajuste.
  bookingEffectiveDivisor: numeric('booking_effective_divisor', { precision: 4, scale: 2 }).notNull().default('1.38'),
  active:     boolean('active').notNull().default(true),
  lastFetchedAt: timestamp('last_fetched_at', { withTimezone: true }),
  lastError:     text('last_error'),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CompetitorHotel = typeof competitorHotels.$inferSelect

// ─── COMPETITOR PRICES ──────────────────────────────────────────────────────
// Un precio por competidor y noche — el más barato disponible ese día (no
// desglosado por tipo de habitación, para poder comparar directamente contra
// nuestro precio base). price = null si no había disponibilidad ese día.
export const competitorPrices = pgTable('competitor_prices', {
  id:           serial('id').primaryKey(),
  competitorId: integer('competitor_id').notNull().references(() => competitorHotels.id, { onDelete: 'cascade' }),
  date:         date('date').notNull(),
  price:        numeric('price', { precision: 10, scale: 2 }),
  fetchedAt:    timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.competitorId, t.date)])

export type CompetitorPrice = typeof competitorPrices.$inferSelect
