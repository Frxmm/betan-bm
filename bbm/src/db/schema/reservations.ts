import {
  pgTable, serial, text, smallint, boolean, timestamp,
  integer, numeric, date, time, jsonb, unique,
} from 'drizzle-orm/pg-core'
import { properties, users, currencies } from './core'
import { guests } from './guests'
import { rooms, roomTypes } from './rooms'
import { reservationStatusEnum } from './enums'

// ─── OPERATORS (OTAs y canales de venta) ──────────────────────────────────────

export const operators = pgTable('operators', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().references(() => properties.id),
  name:       text('name').notNull(),
  code:       text('code').notNull(),       // slug: 'booking', 'agoda', 'airbnb'...
  logoUrl:    text('logo_url'),
  active:     boolean('active').notNull().default(true),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Operator = typeof operators.$inferSelect

// ─── BOOKING CHANNELS (canales de distribución) ────────────────────────────

export const bookingChannels = pgTable('booking_channels', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().references(() => properties.id),
  name:       text('name').notNull(),
  logoUrl:    text('logo_url'),
  isDefault:  boolean('is_default').notNull().default(false),
  active:     boolean('active').notNull().default(true),
  // % de comisión de la OTA sobre el total de la reserva (ej. 15.00 para
  // Booking.com) — null = sin comisión configurada, se trata como 0 en el
  // informe. Ajustable por canal desde Informes → Comisiones.
  commissionPct: numeric('commission_pct', { precision: 5, scale: 2 }),
})

export type BookingChannel = typeof bookingChannels.$inferSelect

// ─── RATES (tarifas) ──────────────────────────────────────────────────────────

export const rates = pgTable('rates', {
  id:                      serial('id').primaryKey(),
  propertyId:              integer('property_id').notNull().references(() => properties.id),
  title:                   text('title').notNull(),
  code:                    text('code'),
  active:                  boolean('active').notNull().default(true),
  activeForBookingEngine:  boolean('active_for_booking_engine').notNull().default(false),
  // adjustType + adjustValue: cómo se calcula el precio sobre la tarifa base
  // 'fixed' = precio fijo, 'percentage' = % sobre base
  adjustType:              text('adjust_type'),
  adjustValue:             numeric('adjust_value', { precision: 10, scale: 2 }),
  // baseRateId: si esta tarifa deriva de otra (ej: tarifa web = base + 8%)
  baseRateId:              integer('base_rate_id'),
  roomTypeId:              integer('room_type_id').references(() => roomTypes.id),
  cancellationPolicyId:    integer('cancellation_policy_id'),
  // highWeekDays: bitmask de qué días cuentan como "fin de semana" (FDM: 48 = sáb+dom)
  highWeekDays:            smallint('high_week_days'),
  description:             text('description'),
  // ── Nuevas propiedades de gestión ────────────────────────────────────────
  minStay:                 integer('min_stay').notNull().default(1),
  maxStay:                 integer('max_stay'),
  userEditable:            boolean('user_editable').notNull().default(true),
  locked:                  boolean('locked').notNull().default(false),
  lockedAt:                timestamp('locked_at', { withTimezone: true }),
  lockedBy:                integer('locked_by').references(() => users.id),
  operatorId:              integer('operator_id').references(() => operators.id),
  createdAt:               timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:               timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Rate = typeof rates.$inferSelect
export type NewRate = typeof rates.$inferInsert

// ─── RATE DAILY PRICES (overrides de precio por fecha) ────────────────────────

export const rateDailyPrices = pgTable('rate_daily_prices', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().references(() => properties.id),
  rateId:     integer('rate_id').notNull().references(() => rates.id, { onDelete: 'cascade' }),
  roomTypeId: integer('room_type_id').references(() => roomTypes.id, { onDelete: 'cascade' }),
  date:       date('date').notNull(),
  price:      numeric('price', { precision: 10, scale: 2 }).notNull(),
  // basePrice: el precio puesto A MANO desde el calendario — se actualiza
  // SOLO cuando alguien edita el precio manualmente (ver upsertDailyPrice en
  // catalog.ts). El motor de reglas dinámicas (pricingRulesEngine.ts) nunca
  // escribe aquí, solo lee: siempre calcula el nuevo `price` a partir de
  // `basePrice`, nunca del `price` ya ajustado por una pasada anterior — así
  // no se acumula el ajuste sobre sí mismo en cada ejecución del motor.
  basePrice:  numeric('base_price', { precision: 10, scale: 2 }),
  // manualOverrideAt: cuándo se editó el precio A MANO por última vez,
  // mientras la condición de alguna regla de tipo umbral (disponibilidad
  // baja, lead time, mínimos locales, competidores, venta de superiores —
  // NO parada de reservas, que ya tiene su propio mecanismo vía
  // demand_pulse_state) seguía activa. Mientras esté puesto, esas reglas NO
  // vuelven a tocar esta celda aunque la condición se siga cumpliendo — se
  // limpia solo (se pone a null) en cuanto una pasada del motor comprueba
  // que NINGUNA regla se está disparando ya para esta celda, así la próxima
  // vez que se dispare (un episodio nuevo) sí actúa con normalidad. Ver
  // pricingRulesEngine.ts.
  manualOverrideAt: timestamp('manual_override_at', { withTimezone: true }),
  closed:     boolean('closed').notNull().default(false),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RateDailyPrice = typeof rateDailyPrices.$inferSelect

// ─── RESERVATIONS (reservas) ───────────────────────────────────────────────────

export const reservations = pgTable('reservations', {
  id:                   serial('id').primaryKey(),
  propertyId:           integer('property_id').notNull().references(() => properties.id),
  // externalCode: código del canal (ej: "6928561379" de Booking.com)
  externalCode:         text('external_code'),
  status:               reservationStatusEnum('status').notNull().default('confirmed'),
  previousStatus:       reservationStatusEnum('previous_status'),
  // Fechas
  checkInDate:          date('check_in_date').notNull(),
  checkOutDate:         date('check_out_date').notNull(),
  arrivalTime:          time('arrival_time'),
  nights:               smallint('nights').notNull(),
  // Huésped titular de la reserva
  guestId:              integer('guest_id').notNull().references(() => guests.id),
  people:               smallint('people').notNull().default(1),
  // Canal y tarifa
  bookingChannelId:     integer('booking_channel_id').references(() => bookingChannels.id),
  operatorId:           integer('operator_id').references(() => operators.id),
  rateId:               integer('rate_id').references(() => rates.id),
  roomId:               integer('room_id').references(() => rooms.id),
  // Financiero
  currencyId:           integer('currency_id').notNull().references(() => currencies.id),
  total:                numeric('total', { precision: 10, scale: 2 }).notNull().default('0'),
  // originalTotal: precio de la reserva en el momento de importarla — antes de
  // sumar extras (reservationSaleItems) o ampliaciones de estancia, que se
  // suman directamente a `total` después. Se rellena SOLO al importar desde
  // FDM (fdm.ts / fdm-import.ts); reservas ya existentes o creadas por otras
  // vías se quedan a null — el informe de comisiones cae entonces a `total`.
  // Es la base sobre la que se calcula la comisión de OTA: los extras y
  // ampliaciones no llevan comisión.
  originalTotal:        numeric('original_total', { precision: 10, scale: 2 }),
  amountPaid:           numeric('amount_paid', { precision: 10, scale: 2 }).notNull().default('0'),
  // bmCommission: comisión que la propia FDM/Booking.com reporta para esta
  // reserva (campo BMCommission de FDM) — cuando está disponible es más
  // preciso que aplicar un % nuestro, porque ya lo calculó el canal. Se
  // rellena solo al importar desde FDM, igual que originalTotal.
  bmCommission:         numeric('bm_commission', { precision: 10, scale: 2 }).notNull().default('0'),
  serviceFee:           numeric('service_fee', { precision: 10, scale: 2 }).notNull().default('0'),
  cityTax:              numeric('city_tax', { precision: 10, scale: 2 }).notNull().default('0'),
  cityTaxFromPortal:    boolean('city_tax_from_portal'),
  // Check-in / Check-out
  checkedInAt:           timestamp('checked_in_at', { withTimezone: true }),
  checkedInBy:           integer('checked_in_by').references(() => users.id),
  checkedOutAt:          timestamp('checked_out_at', { withTimezone: true }),
  checkinStartedAt:      timestamp('checkin_started_at', { withTimezone: true }),
  checkinHadContract:    boolean('checkin_had_contract'),    // contrato firmado en el momento del check-in
  checkinZktecoEnrolled: boolean('checkin_zkteco_enrolled'), // tarjeta ZKTeco enrollada en el momento del check-in
  checkinSesSent:        boolean('checkin_ses_sent'),        // parte SES enviado en el momento del check-in
  checkinAbandonedAt:    timestamp('checkin_abandoned_at', { withTimezone: true }), // último intento de check-in abandonado
  checkinAbandonedBy:    integer('checkin_abandoned_by').references(() => users.id),
  // Objetos robados (housekeeping, salida) — se limpia al registrar un depósito nuevo
  stolenItemsReportedAt: timestamp('stolen_items_reported_at', { withTimezone: true }),
  stolenItemsReportedBy: integer('stolen_items_reported_by').references(() => users.id),
  // Extras
  groupName:            text('group_name'),
  extraField1:          text('extra_field1'),
  extraField2:          text('extra_field2'),
  source:               text('source'),
  isFromPortal:         boolean('is_from_portal').notNull().default(false),
  onlineCheckIn:        boolean('online_check_in').notNull().default(false),
  onlineGuestUrl:       text('online_guest_url'),
  emailConsentGiven:    boolean('email_consent_given').notNull().default(false),
  // Preferencia (no garantía) marcada por el huésped en el motor de reservas al
  // elegir una habitación doble ("Dos Camas" / dos camas separadas en vez de
  // una grande). Se compara luego contra rooms.bedSize ('twin') de la
  // habitación que se le asigne — ver alerta de descuadre en alerts.ts.
  bedPreferenceTwin:    boolean('bed_preference_twin').notNull().default(false),
  // Pago automático (tokenización Stripe/Adyen)
  autoAuthoriseStatus:  text('auto_authorise_status'),
  autoChargeStatus:     text('auto_charge_status'),
  // Facturación
  invoiceCount:         smallint('invoice_count').notNull().default(0),
  invoiceTotal:         numeric('invoice_total', { precision: 10, scale: 2 }).notNull().default('0'),
  // Cerradura TTLock (habitaciones)
  ttlockCode:           text('ttlock_code'),
  ttlockCodeId:         text('ttlock_code_id'),
  ttlockSentAt:         timestamp('ttlock_sent_at', { withTimezone: true }),
  // Tarjeta TTLock (credencial IC/Mifare de la misma tarjeta ZKTeco enrolada en las
  // cerraduras) — JSON [{room,lockId,cardId}]. Se guarda el cardId que devuelve TTLock
  // al enrolar para poder borrarla antes de re-enrolarla (ampliación de estancia) sin
  // duplicados, igual que ttlockCodeId con los códigos.
  ttlockCardIds:        text('ttlock_card_ids'),
  // ZKTeco C3-400 (acceso al recinto)
  zktecoCardNo:         text('zkteco_card_no'),    // Wiegand 26 decimal (3 bytes LE), ej: "5533773"
  zktecoCardBe:         text('zkteco_card_be'),    // UID completo hex (4 bytes), ej: "4D7054FD" → parseInt(x,16) = cardNumber TTLock
  zktecoEnrolledAt:     timestamp('zkteco_enrolled_at', { withTimezone: true }),
  // Al hacer check-out/cancelar/revocar a mano, la tarjeta se revoca en el
  // sistema real (revokeCard) pero YA NO se borra zktecoCardNo/zktecoCardBe —
  // se marca aquí en su lugar, para poder reutilizar la misma tarjeta física
  // en una reserva consecutiva del mismo huésped sin que la vuelva a pasar
  // (ver "Enrolado automático por reserva consecutiva" en check-in). "Tarjeta
  // activa ahora mismo" = zktecoCardNo IS NOT NULL AND zktecoCardRevokedAt IS NULL.
  // Esta marca cubre también las tarjetas extra de zktecoExtraCards.
  zktecoCardRevokedAt:  timestamp('zkteco_card_revoked_at', { withTimezone: true }),
  // Tarjetas ZKTeco adicionales (huéspedes extra). Array de
  // { cardNo, cardBe, pin, enrolledAt } donde pin = reservationId + 1_000_000_000 × n.
  // ttlockCardIds almacena las credenciales TTLock de TODAS las tarjetas (primary + extra).
  zktecoExtraCards:     jsonb('zkteco_extra_cards'),
  // SES Hospedajes
  sesSubmittedAt:       timestamp('ses_submitted_at', { withTimezone: true }),
  sesLocutorioId:       text('ses_locutorio_id'),
  // Nobeds channel manager
  nobedsOrderId:        integer('nobeds_order_id'),
  // Auditoría
  createdBy:            integer('created_by').references(() => users.id),
  bookedAt:             timestamp('booked_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lastModifiedAt:       timestamp('last_modified_at', { withTimezone: true }),
  // Datos de facturación (pueden diferir del titular de la reserva)
  billingName:          text('billing_name'),
  billingNif:           text('billing_nif'),
  billingAddress:       text('billing_address'),
  // Habitaciones adicionales (además de roomId) para reservas multi-habitación
  extraRoomIds:         jsonb('extra_room_ids').$type<number[]>(),
  // Habitaciones de la reserva (roomId o alguna de extraRoomIds) marcadas como
  // "cerradas" — no se puede reasignar a otro huésped de la misma reserva,
  // aunque la reserva en general siga activa (p.ej. ya se hizo el check-in de
  // esa habitación y no se quiere que se mueva a nadie más dentro)
  lockedRoomIds:        jsonb('locked_room_ids').$type<number[]>().notNull().default([]),
  // Partir reserva por fecha (mover parte de la estancia a otra habitación):
  // referencias cruzadas entre la reserva original (truncada) y la continuación
  splitFromReservationId: integer('split_from_reservation_id'),
  splitToReservationId:   integer('split_to_reservation_id'),
  // Snapshot de antes de la ÚLTIMA ampliación de estancia (ver PATCH /:id en
  // reservations.ts) — permite un botón "Deshacer ampliación" de un solo
  // nivel mientras lo añadido siga sin cobrar (GET /:id/undo-extension lo
  // exige). Se sobrescribe en cada ampliación nueva (solo se puede deshacer
  // la última) y se limpia (null) al deshacer.
  pendingExtension:     jsonb('pending_extension').$type<{ prevCheckOutDate: string; prevNights: number; prevTotal: string; extendedAt: string }>(),
})

export type Reservation = typeof reservations.$inferSelect
export type NewReservation = typeof reservations.$inferInsert

// ─── RESERVATION NIGHTS (una fila por persona por noche) ──────────────────────
// Este es el detalle de precio diario por huésped.
// Permite que dos personas en la misma habitación paguen precios distintos
// y que el precio varíe noche a noche (temporada alta/baja).

export const reservationNights = pgTable('reservation_nights', {
  id:            serial('id').primaryKey(),
  reservationId: integer('reservation_id').notNull().references(() => reservations.id),
  date:          date('date').notNull(),
  guestId:       integer('guest_id').notNull().references(() => guests.id),
  roomId:        integer('room_id').notNull().references(() => rooms.id),
  roomTypeId:    integer('room_type_id').notNull().references(() => roomTypes.id),
  rateId:        integer('rate_id').references(() => rates.id),
  // bedIndex: identificador de la cama dentro de la habitación ("1A", "1B", "2"...)
  bedIndex:      text('bed_index'),
  price:         numeric('price', { precision: 10, scale: 2 }).notNull(),
  commission:    numeric('commission', { precision: 10, scale: 2 }).notNull().default('0'),
  currencyId:    integer('currency_id').notNull().references(() => currencies.id),
  cancelled:     boolean('cancelled').notNull().default(false),
  // isOriginal: false si es una cama extra añadida después
  isOriginal:    boolean('is_original').notNull().default(true),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ReservationNight = typeof reservationNights.$inferSelect
export type NewReservationNight = typeof reservationNights.$inferInsert

// ─── RESERVATION NOTES (notas internas) ───────────────────────────────────────

export const reservationNotes = pgTable('reservation_notes', {
  id:            serial('id').primaryKey(),
  reservationId: integer('reservation_id').notNull().references(() => reservations.id),
  authorId:      integer('author_id').references(() => users.id),
  note:          text('note').notNull(),
  // type: 'note' = nota manual de usuario; 'change' = registro automático de modificación
  type:          text('type').notNull().default('note'),
  // popupAt: mostrar esta nota automáticamente al abrir la reserva en esta fecha
  popupAt:       timestamp('popup_at', { withTimezone: true }),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type ReservationNote = typeof reservationNotes.$inferSelect
export type NewReservationNote = typeof reservationNotes.$inferInsert

// ─── RESERVATION FIELD RULES (qué campos son editables por rol/canal) ─────────

export const reservationFieldRules = pgTable('reservation_field_rules', {
  id:                 serial('id').primaryKey(),
  propertyId:         integer('property_id').notNull().default(1).references(() => properties.id),
  fieldKey:           text('field_key').notNull(),
  label:              text('label').notNull(),
  allowedRoles:       jsonb('allowed_roles').notNull().default([]),
  allowedChannelIds:  jsonb('allowed_channel_ids').notNull().default([]),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique('reservation_field_rules_property_field_uniq').on(t.propertyId, t.fieldKey)])

export type ReservationFieldRule = typeof reservationFieldRules.$inferSelect

// ─── ROOM ACCESS VISITS (uso del QR de habitación por el huésped) ────────────
// Una fila por cada vez que un huésped abre con éxito la página de su
// habitación (QR físico → GET /api/room-access/reservation, ver
// src/routes/room-access.ts) — una fila por carga de página/sesión abierta,
// no por cada llamada posterior (extras, ampliar, feedback...) que haga
// dentro de esa misma visita. Sirve para el informe "Uso QR habitaciones".
export const roomAccessVisits = pgTable('room_access_visits', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().references(() => properties.id),
  roomId:        integer('room_id').references(() => rooms.id),
  reservationId: integer('reservation_id').references(() => reservations.id),
  visitedAt:     timestamp('visited_at', { withTimezone: true }).notNull().defaultNow(),
})

export type RoomAccessVisit = typeof roomAccessVisits.$inferSelect
