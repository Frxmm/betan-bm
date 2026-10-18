import { pgTable, serial, text, boolean, timestamp, integer, numeric, date, smallint, jsonb, primaryKey } from 'drizzle-orm/pg-core'
import { properties, users, currencies } from './core'
import { reservations } from './reservations'
import { guests } from './guests'
// ─── PAYMENT METHOD CONFIGS (formas de pago configurables) ───────────────────

export const paymentMethodConfigs = pgTable('payment_method_configs', {
  id:         serial('id').primaryKey(),
  propertyId: integer('property_id').notNull().default(1),
  key:        text('key').notNull(),
  label:      text('label').notNull(),
  color:      text('color').notNull().default('#64748b'),
  active:     boolean('active').notNull().default(true),
  sortOrder:  integer('sort_order').notNull().default(0),
})

export type PaymentMethodConfig = typeof paymentMethodConfigs.$inferSelect

// ─── FINANCIAL ACCOUNTS (cajas) ───────────────────────────────────────────────

export const financialAccounts = pgTable('financial_accounts', {
  id:             serial('id').primaryKey(),
  propertyId:     integer('property_id').notNull().references(() => properties.id),
  name:           text('name').notNull(),
  isDefault:      boolean('is_default').notNull().default(false),
  isCreditCard:   boolean('is_credit_card').notNull().default(false),
  isBankAccount:  boolean('is_bank_account').notNull().default(false),
  countInShift:   boolean('count_in_shift').notNull().default(true),
  active:         boolean('active').notNull().default(true),
  // Formas de pago permitidas (null / [] = sin restricción)
  allowedMethods: jsonb('allowed_methods').$type<string[]>(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type FinancialAccount = typeof financialAccounts.$inferSelect

// ─── SHIFTS (turnos de caja) ──────────────────────────────────────────────────

export const shifts = pgTable('shifts', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().references(() => properties.id),
  openedBy:    integer('opened_by').notNull().references(() => users.id),
  openedAt:    timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedBy:    integer('closed_by').references(() => users.id),
  closedAt:    timestamp('closed_at', { withTimezone: true }),
  openingNote: text('opening_note'),
  closingNote: text('closing_note'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Shift = typeof shifts.$inferSelect

// ─── FINANCIAL TRANSACTIONS (cobros/pagos) ────────────────────────────────────

export const financialTransactions = pgTable('financial_transactions', {
  id:                   serial('id').primaryKey(),
  propertyId:           integer('property_id').notNull().references(() => properties.id),
  reservationId:        integer('reservation_id').references(() => reservations.id),
  financialAccountId:   integer('financial_account_id').notNull().references(() => financialAccounts.id),
  amount:               numeric('amount', { precision: 10, scale: 2 }).notNull(),
  currencyId:           integer('currency_id').notNull().references(() => currencies.id),
  paymentMethod:        text('payment_method').notNull().default('cash'),
  category:             text('category'),
  description:          text('description'),
  transactionDate:      date('transaction_date').notNull(),
  onlinePaymentId:      text('online_payment_id'),
  onlinePaymentStatus:  text('online_payment_status'),
  shiftId:              integer('shift_id').references(() => shifts.id),
  user:                 text('user'),
  createdBy:            integer('created_by').references(() => users.id),
  // collectedAt/paidByUserId: la fecha+hora real de cobro y quién lo cobró de
  // verdad (debe tener rol recepción), cuando difieren de
  // transactionDate/createdBy porque el pago se registró en el sistema más
  // tarde o por otra persona ("Cobrado en otro turno" — toggle disponible al
  // registrar el pago o después, desde la pestaña Pagos de
  // ReservationDetailView). No requiere `description` — si hay una, se copia
  // como contexto en el rastro de la corrección, pero no es obligatoria.
  // Cada vez que se usa queda un rastro en payment_date_corrections para
  // poder sacar informes por usuario.
  collectedAt:          timestamp('collected_at', { withTimezone: true }),
  paidByUserId:         integer('paid_by_user_id').references(() => users.id),
  // cardOperationNumber: nº de pedido/operación de la terminal de tarjeta —
  // para pagos con forma de pago "tarjeta" hace falta este dato O, si no se
  // tiene a mano, el toggle "Cobrado en otro turno" de arriba con fecha y
  // hora reales (una de las dos, nunca ninguna) — sirve para poder conciliar
  // después el pago con el extracto de la terminal/banco.
  cardOperationNumber: text('card_operation_number'),
  // resolvedAt/resolvedBy: cuándo y quién "cobró" un depósito (POST
  // /transactions/:id/cobrar — actualiza esta misma fila, category pasa a
  // 'deposit_cobrado', no crea una fila nueva) — necesario porque la fila no
  // tiene updatedAt y createdAt/createdByUser siguen marcando el registro
  // ORIGINAL del depósito, no la resolución. La devolución sí es una fila
  // nueva (category='deposit_return'), así que ahí createdAt/createdByUser
  // de esa fila ya sirven para saber cuándo y quién la devolvió.
  resolvedAt:           timestamp('resolved_at', { withTimezone: true }),
  resolvedBy:           integer('resolved_by').references(() => users.id),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type FinancialTransaction = typeof financialTransactions.$inferSelect

// ─── PAYMENT DATE CORRECTIONS (auditoría de "Cobrado en otro turno") ──────────
// Una fila cada vez que se fija la fecha/hora/usuario real de cobro de una
// transacción (ver financialTransactions.collectedAt/paidByUserId arriba) —
// tanto al registrar el pago como después — para poder sacar informes de
// "pagos corregidos por usuario" (quién registra pagos de otro turno, con qué
// frecuencia, y quién los corrige cuando no fue así desde el principio).
export const paymentDateCorrections = pgTable('payment_date_corrections', {
  id:                      serial('id').primaryKey(),
  transactionId:           integer('transaction_id').notNull().references(() => financialTransactions.id, { onDelete: 'cascade' }),
  reservationId:           integer('reservation_id').references(() => reservations.id),
  // Copia de la descripción de la transacción en el momento de fijar la
  // corrección — aunque luego se edite, la justificación de ESTA corrección
  // concreta queda fija. La descripción NO es obligatoria para corregir.
  description:             text('description'),
  // Lo que habría quedado sin la corrección: la fecha con la que se habría
  // registrado (hoy, si es al crear el pago) y quién la estaba registrando.
  previousTransactionDate: date('previous_transaction_date').notNull(),
  previousCreatedBy:       integer('previous_created_by').references(() => users.id),
  correctedAt:             timestamp('corrected_at', { withTimezone: true }).notNull(),
  paidByUserId:            integer('paid_by_user_id').notNull().references(() => users.id),
  // fixedBy: quién aplicó la corrección (el usuario logueado en ese momento,
  // no necesariamente el mismo que paidByUserId).
  fixedBy:                 integer('fixed_by').references(() => users.id),
  fixedAt:                 timestamp('fixed_at', { withTimezone: true }).notNull().defaultNow(),
})

export type PaymentDateCorrection = typeof paymentDateCorrections.$inferSelect
export type NewFinancialTransaction = typeof financialTransactions.$inferInsert

// ─── CASH COLLECTIONS (recogidas de efectivo) ─────────────────────────────────

export const cashCollections = pgTable('cash_collections', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().references(() => properties.id),
  collectedBy: integer('collected_by').notNull().references(() => users.id),
  collectedAt: timestamp('collected_at', { withTimezone: true }).notNull(),
  dateFrom:    timestamp('date_from', { withTimezone: true }),
  dateTo:      timestamp('date_to',   { withTimezone: true }),
  amount:      numeric('amount', { precision: 10, scale: 2 }).notNull(),
  note:        text('note'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type CashCollection = typeof cashCollections.$inferSelect

// ─── SALE ITEMS (extras/productos) ───────────────────────────────────────────

export const saleItems = pgTable('sale_items', {
  id:                      serial('id').primaryKey(),
  propertyId:              integer('property_id').notNull().references(() => properties.id),
  title:                   text('title').notNull(),
  description:             text('description'),
  active:                  boolean('active').notNull().default(true),
  activeForBookingEngine:  boolean('active_for_booking_engine').notNull().default(false),
  color:                   text('color'),
  commissionValue:         numeric('commission_value', { precision: 10, scale: 2 }).notNull().default('0'),
  isAddOn:                 boolean('is_add_on').notNull().default(false),
  taxRate:                 numeric('tax_rate', { precision: 5, scale: 2 }),
  defaultPrice:            numeric('default_price', { precision: 10, scale: 2 }),
  categoryId:              integer('category_id'),
  // Campos de booking engine (migración 0023)
  pricingType:             text('pricing_type').notNull().default('per_stay'), // per_stay | per_night | per_person | per_person_night
  icon:                    text('icon'),
  maxQuantity:             smallint('max_quantity').notNull().default(1),
  createdAt:               timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:               timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type SaleItem = typeof saleItems.$inferSelect

// ─── RESERVATION SALE ITEMS (extras en una reserva) ──────────────────────────

export const reservationSaleItems = pgTable('reservation_sale_items', {
  id:            serial('id').primaryKey(),
  reservationId: integer('reservation_id').notNull().references(() => reservations.id),
  saleItemId:    integer('sale_item_id').notNull().references(() => saleItems.id),
  quantity:      smallint('quantity').notNull().default(1),
  unitPrice:     numeric('unit_price', { precision: 10, scale: 2 }).notNull(),
  date:          date('date'),
  notes:         text('notes'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  createdBy:     integer('created_by').references(() => users.id),
})

// ─── DEPOSIT ITEMS (garantías) ────────────────────────────────────────────────

export const depositItems = pgTable('deposit_items', {
  id:                   serial('id').primaryKey(),
  propertyId:           integer('property_id').notNull().references(() => properties.id),
  name:                 text('name').notNull(),
  active:               boolean('active').notNull().default(true),
  requiredForCheckIn:   boolean('required_for_check_in').notNull().default(false),
})

export type DepositItem = typeof depositItems.$inferSelect

// ─── INVOICES (facturas) ──────────────────────────────────────────────────────

export const invoices = pgTable('invoices', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().references(() => properties.id),
  reservationId: integer('reservation_id').references(() => reservations.id),
  invoiceNumber: text('invoice_number').notNull(),
  issuedAt:      date('issued_at').notNull(),
  guestId:       integer('guest_id').references(() => guests.id),
  subtotal:      numeric('subtotal', { precision: 10, scale: 2 }).notNull(),
  taxAmount:     numeric('tax_amount', { precision: 10, scale: 2 }).notNull().default('0'),
  total:         numeric('total', { precision: 10, scale: 2 }).notNull(),
  currencyId:    integer('currency_id').notNull().references(() => currencies.id),
  billingName:   text('billing_name'),
  billingNif:    text('billing_nif'),
  billingAddress:text('billing_address'),
  notes:         text('notes'),
  lineItems:     jsonb('line_items'),
  pdfUrl:        text('pdf_url'),
  createdBy:     integer('created_by').references(() => users.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Invoice = typeof invoices.$inferSelect
export type NewInvoice = typeof invoices.$inferInsert

// ─── INVOICE SETTINGS ─────────────────────────────────────────────────────────

export const invoiceSettings = pgTable('invoice_settings', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  numberFormat: text('number_format').notNull().default('{N:7}/{YYYY}'),
  nextNumber:   integer('next_number').notNull().default(1),
  taxRate:      numeric('tax_rate', { precision: 5, scale: 2 }).notNull().default('10'),
  htmlTemplate: text('html_template'),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// ─── MESSAGE SETTINGS (qué mensajes salen por qué canal) ──────────────────────

export const messageSettings = pgTable('message_settings', {
  propertyId:         integer('property_id').notNull().default(1).references(() => properties.id),
  key:                text('key').notNull(),
  email:              boolean('email').notNull().default(true),
  whatsapp:           boolean('whatsapp').notNull().default(true),
  // Reservas de estos canales de venta NO reciben este mensaje
  excludedChannelIds: jsonb('excluded_channel_ids').$type<number[]>().notNull().default([]),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.key] })])

// ─── MESSAGE TEMPLATES (plantillas de email personalizables) ──────────────────

export const messageTemplates = pgTable('message_templates', {
  propertyId: integer('property_id').notNull().default(1).references(() => properties.id),
  key:       text('key').notNull(),
  subject:   text('subject').notNull(),
  html:      text('html').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.propertyId, t.key] })])

// ─── CAJA DE CAMBIO (arqueos por denominación + gastos por reponer) ───────────

export const changeDrawerCounts = pgTable('change_drawer_counts', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().default(1).references(() => properties.id),
  counts:      jsonb('counts').$type<Record<string, number>>().notNull().default({}),
  totalCash:   numeric('total_cash', { precision: 10, scale: 2 }).notNull().default('0'),
  floatAmount: numeric('float_amount', { precision: 10, scale: 2 }).notNull().default('500'),
  countedBy:   integer('counted_by').references(() => users.id),
  countedAt:   timestamp('counted_at', { withTimezone: true }).notNull().defaultNow(),
})

export const changeDrawerExpenses = pgTable('change_drawer_expenses', {
  id:            serial('id').primaryKey(),
  propertyId:    integer('property_id').notNull().default(1).references(() => properties.id),
  description:   text('description').notNull(),
  amount:        numeric('amount', { precision: 10, scale: 2 }).notNull(),
  createdBy:     integer('created_by').references(() => users.id),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  replenishedAt: timestamp('replenished_at', { withTimezone: true }),
  replenishedBy: integer('replenished_by').references(() => users.id),
})

// Verificación manual de depósitos en efectivo: quien hace la caja marca, uno
// por uno, los depósitos que ha contado físicamente. Solo se guarda un registro
// cuando hay discrepancia (el sistema tiene más depósitos activos que los
// marcados) — sirve de histórico de incidencias, no de cada verificación.
export const changeDrawerDepositChecks = pgTable('change_drawer_deposit_checks', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().default(1).references(() => properties.id),
  checkedAt:    timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
  checkedBy:    integer('checked_by').references(() => users.id),
  systemCount:  integer('system_count').notNull(),
  countedCount: integer('counted_count').notNull(),
  missingIds:   jsonb('missing_ids').$type<number[]>().notNull().default([]),
})

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

export const notifications = pgTable('notifications', {
  id:             serial('id').primaryKey(),
  propertyId:     integer('property_id').notNull().references(() => properties.id),
  type:           smallint('type').notNull(),
  message:        text('message').notNull(),
  additionalInfo: jsonb('additional_info'),
  sentBy:         integer('sent_by').references(() => users.id),
  isRead:         boolean('is_read').notNull().default(false),
  sentAt:         timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
})

export type Notification = typeof notifications.$inferSelect

// ─── BLOCKED BEDS ─────────────────────────────────────────────────────────────

export const blockedBeds = pgTable('blocked_beds', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().references(() => properties.id),
  roomId:      integer('room_id').notNull(),
  roomTypeId:  integer('room_type_id').notNull(),
  bedNumber:   text('bed_number').notNull(),
  blockDate:   date('block_date').notNull(),
  reason:      text('reason'),
  // Bloqueo de Dirección: inamovible para el resto de roles (solo dirección
  // puede quitarlo) y nunca se sugiere "vender bloqueadas" sobre él.
  lockedByDirection: boolean('locked_by_direction').notNull().default(false),
  createdBy:   integer('created_by').notNull().references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export type BlockedBed = typeof blockedBeds.$inferSelect
export type NewBlockedBed = typeof blockedBeds.$inferInsert
