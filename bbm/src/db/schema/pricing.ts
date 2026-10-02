import { pgTable, serial, integer, text, numeric, boolean, date, timestamp, unique } from 'drizzle-orm/pg-core'
import { properties, users } from './core'
import { rates } from './reservations'
import { roomTypes } from './rooms'

// Temporadas — rangos de fechas con precio mínimo y color para el calendario
export const seasons = pgTable('seasons', {
  id:          serial('id').primaryKey(),
  propertyId:  integer('property_id').notNull().references(() => properties.id),
  name:        text('name').notNull(),
  dateFrom:    date('date_from').notNull(),
  dateTo:      date('date_to').notNull(),
  minPrice:    numeric('min_price', { precision: 10, scale: 2 }),
  color:       text('color').notNull().default('#3b82f6'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Reglas de precio dinámico — aplicadas por src/lib/pricingRulesEngine.ts sobre
// la tarifa raíz (de la que derivan todas las demás), siempre a
// partir de rateDailyPrices.basePrice, nunca del price ya ajustado.
export const pricingRules = pgTable('pricing_rules', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  name:         text('name').notNull(),
  // 'low_availability' = SUBE el precio cuando % disponible ese día <
  //   thresholdPct (thresholdPct = umbral de DISPONIBILIDAD). Recorre un
  //   horizonte de días (30) buscando cada día que cumpla la condición.
  // 'lead_time_dip'    = BAJA el precio, y solo para el día que cae
  //   exactamente en hoy + lead time medio de reservas de Booking.com
  //   (últimos 28 días), cuando la OCUPACIÓN de ese día concreto <
  //   thresholdPct (aquí thresholdPct = umbral de OCUPACIÓN, no de
  //   disponibilidad — mismo campo, significado distinto según el tipo).
  // 'local_min_dip'    = BAJA el precio en los mínimos locales discretos de
  //   ocupación (mesetas completas incluidas) dentro de hoy+3..hoy+60, con
  //   OCUPACIÓN < thresholdPct. Si el mínimo coincide con el día exacto de
  //   lead_time_dip, manda lead_time_dip y esta no toca esa fecha.
  // 'demand_pulse_dip' = BAJA el precio de forma progresiva en fechas de
  //   check-in hoy..hoy+3 cuando pasan bloques de 4h sin ninguna reserva
  //   nueva (thresholdPct = techo de OCUPACIÓN por debajo del cual se sigue
  //   bajando), y lo va subiendo de vuelta la mitad de lo que baja cada 2
  //   reservas nuevas, hasta volver al precio original. En cuanto la
  //   OCUPACIÓN de esa fecha vuelve a superar thresholdPct, el descuento se
  //   retira del todo en el acto (no espera a las reservas nuevas). Nunca
  //   baja el precio de una fecha por debajo de minAdrFloorPct% del ADR real
  //   de SU semana (ver weeklyAdrByDate en occupancyReport.ts) — si esa
  //   semana aún no tiene ADR real (sin ninguna noche ocupada todavía), se
  //   usa como red de seguridad un tope fijo del 30% de descuento sobre
  //   basePrice (PULSE_FALLBACK_MAX_DISCOUNT_PCT en pricingRulesEngine.ts).
  //   Necesita memoria entre pasadas — ver demandPulseState.
  // 'competitor_undercut' = BAJA el precio de referenceRateId en fechas
  //   hoy+3..hoy+21 cuando su precio resuelto es mayor que el más barato de
  //   los competidores activos ese día Y la OCUPACIÓN de ese día <
  //   thresholdPct (aquí, igual que en local_min_dip, umbral de OCUPACIÓN).
  //   El precio nuevo es adjustValue% de descuento sobre el precio MÁS BARATO
  //   del competidor ese día (no sobre nuestro propio precio) — ver
  //   invertRateChainToRoot/invertRoomTypeChainToBase en price-resolver.ts
  //   para cómo se traduce ese objetivo al precio real de tarifa raíz.
  ruleType:     text('rule_type').notNull().default('low_availability'),
  thresholdPct: integer('threshold_pct').notNull().default(15),
  adjustType:   text('adjust_type').notNull().default('percentage'), // 'fixed' | 'percentage'
  adjustValue:  numeric('adjust_value', { precision: 10, scale: 2 }).notNull().default('0'),
  // Solo demand_pulse_dip — suelo de precio como % del ADR real semanal.
  minAdrFloorPct: integer('min_adr_floor_pct').notNull().default(90),
  // Solo demand_pulse_dip — minutos sin reservas nuevas para sumar un
  // escalón de bajada (antes fijo a 4h/240min, PULSE_HOURS_THRESHOLD en
  // pricingRulesEngine.ts). Mismo valor que decide si se respeta o no un
  // override manual: la regla NUNCA sobrescribe un precio puesto a mano si
  // ese override es más reciente que esta ventana — solo lo sobrescribe
  // cuando el override ya es más antiguo que ella (se considera "caducado").
  pulseSilenceMinutes: integer('pulse_silence_minutes').notNull().default(240),
  // Solo evening_clearance_dip — minutos que se respeta un override manual
  // antes de darlo por caducado (mismo mecanismo que pulseSilenceMinutes en
  // demand_pulse_dip, pero como valor propio: la ventana de esta regla no
  // tiene por qué coincidir con la de Parada de reservas).
  clearanceOverrideMinutes: integer('clearance_override_minutes').notNull().default(60),
  // Solo evening_clearance_dip — hora (0-23, Europe/Madrid) a partir de la
  // que empieza a actuar la regla cada día (antes fija a las 20:00).
  clearanceStartHour: integer('clearance_start_hour').notNull().default(20),
  // Solo competitor_undercut — la tarifa NUESTRA cuyo precio resuelto se
  // compara contra los competidores (puede ser cualquier tarifa, no solo
  // (tarifa raíz); el ajuste real siempre se aplica sobre tarifa raíz, invirtiendo la
  // cadena de derivación hasta ella — ver pricingRulesEngine.ts).
  referenceRateId: integer('reference_rate_id').references(() => rates.id),
  // 'sold_out_upsell' = venta de superiores: cuando sourceRoomTypeId (p.ej.
  //   "Doble") se queda sin disponibilidad calculada (0 unidades libres) en
  //   una fecha, BAJA el precio de sourceRoomTypeId (agotado, no pierde
  //   ventas) para que targetRoomTypeId (p.ej. "Doble Superior", DERIVADO de
  //   él) quede a precio original de sourceRoomTypeId + adjustValue € — hace
  //   casi irresistible subir de categoría en vez de perder la venta.
  //   thresholdPct no se usa (la condición es binaria: 0 disponibles).
  sourceRoomTypeId: integer('source_room_type_id').references(() => roomTypes.id),
  targetRoomTypeId: integer('target_room_type_id').references(() => roomTypes.id),
  // 'booking_surge' = SUBE el precio de una fecha cuando se detectan 2 o más
  //   reservas con ESE check-in hechas (bookedAt) dentro de los últimos
  //   thresholdPct MINUTOS (aquí thresholdPct no es un %, es la ventana en
  //   minutos — reutilizado, igual que en otros tipos; por defecto 60). El
  //   ajuste es adjustValue% (adjustType normalmente 'percentage') sobre el
  //   basePrice. Sin memoria entre pasadas (a diferencia de demand_pulse_dip):
  //   cada pasada vuelve a contar reservas recientes en vivo, así que se
  //   desactiva sola en cuanto deja de haber 2+ reservas dentro de la ventana
  //   — o porque ya pasó el tiempo configurado sin reservas nuevas, o porque
  //   el propio pico de reservas ya quedó fuera de la ventana móvil.
  // Prioridad: número MENOR = gana. Si varias reglas activas se cumplen la
  // misma fecha, solo se aplica la de menor prioridad (empate → la de menor
  // id) y decide el precio de todas las celdas de esa fecha — ver
  // pricingRulesEngine.ts.
  priority:     integer('priority').notNull().default(100),
  active:       boolean('active').notNull().default(true),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Log de cada cambio de precio real que hace el motor — sirve para la alerta
// ("Aplicada regla automática de precio el día...") y como auditoría de qué
// tocó el motor y cuándo. dismissedAt: se marca al pulsar "Entendido" en la
// alerta — esa marca es lo que hace que no vuelva a aparecer.
export const pricingRuleApplications = pgTable('pricing_rule_applications', {
  id:          serial('id').primaryKey(),
  ruleId:      integer('rule_id').notNull().references(() => pricingRules.id, { onDelete: 'cascade' }),
  date:        date('date').notNull(),
  roomTypeId:  integer('room_type_id'),
  oldPrice:    numeric('old_price', { precision: 10, scale: 2 }).notNull(),
  newPrice:    numeric('new_price', { precision: 10, scale: 2 }).notNull(),
  appliedAt:   timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  // batchId: agrupa todas las filas escritas por una misma pasada del motor
  // (applyPricingRules) — lo usa la pestaña Historial del calendario de
  // precios para mostrar "N fechas afectadas" en una sola línea en vez de
  // una fila por celda. Nulo en filas de antes de que existiera esta
  // columna: el historial las muestra sueltas, una por una, sin agrupar.
  batchId:     text('batch_id'),
})

// Historial UNIFICADO de cambios de precio — manuales (desde el calendario,
// upsertDailyPrice en catalog.ts) Y automáticos (una copia de lo que ya
// registra pricing_rule_applications, para no tener que hacer two-source
// UNION con joins distintos en la pestaña Historial). dismissedAt NO existe
// aquí a propósito: esta tabla es un registro permanente, no se vacía nunca
// (a diferencia de la alerta, que sí usa pricing_rule_applications.dismissedAt).
export const priceChangeLog = pgTable('price_change_log', {
  id:              serial('id').primaryKey(),
  propertyId:      integer('property_id').notNull().references(() => properties.id),
  rateId:          integer('rate_id').notNull().references(() => rates.id, { onDelete: 'cascade' }),
  roomTypeId:      integer('room_type_id'),
  date:            date('date').notNull(),
  oldPrice:        numeric('old_price', { precision: 10, scale: 2 }),
  // newPrice nulo = se eliminó el override manual y el precio vuelve a
  // calcularse (herencia/derivación) — no hay un "precio destino" fijo que
  // registrar, así que el historial lo muestra como reverso, no como cambio
  // a un valor concreto.
  newPrice:        numeric('new_price', { precision: 10, scale: 2 }),
  closed:          boolean('closed').notNull().default(false),
  source:          text('source').notNull(), // 'manual' | 'auto'
  // changedByUserId nulo = cambio automático (motor de reglas); si no,
  // quién lo hizo a mano desde el calendario.
  changedByUserId: integer('changed_by_user_id').references(() => users.id),
  ruleId:          integer('rule_id').references(() => pricingRules.id, { onDelete: 'set null' }),
  // batchId: agrupa los cambios de una misma acción (un bulk-edit desde el
  // calendario, o una pasada del motor) para mostrarlos como una sola línea.
  batchId:         text('batch_id').notNull(),
  changedAt:       timestamp('changed_at', { withTimezone: true }).notNull().defaultNow(),
})

// Estado persistente de la regla 'demand_pulse_dip' (parada de reservas de
// última hora) — una fila por cada fecha de check-in que el motor ha llegado
// a tocar. A diferencia del resto de reglas (que recalculan targetPrice desde
// cero cada pasada, sin memoria), esta necesita memoria: cuántos escalones de
// bajada lleva acumulados y cuántas reservas van "hacia" el próximo escalón
// de subida — eso no es derivable solo de "cuándo fue la última reserva",
// porque en cuanto llega UNA reserva ese dato salta a ~0 y perderíamos la
// subida gradual. Ver src/lib/pricingRulesEngine.ts.
export const demandPulseState = pgTable('demand_pulse_state', {
  id:                 serial('id').primaryKey(),
  propertyId:         integer('property_id').notNull().references(() => properties.id),
  ruleId:             integer('rule_id').notNull().references(() => pricingRules.id, { onDelete: 'cascade' }),
  date:               date('date').notNull(),
  // % de descuento acumulado actualmente sobre basePrice, ya neto de
  // escalones de subida. 0 = fecha recuperada del todo / sin activar.
  discountPct:        numeric('discount_pct', { precision: 5, scale: 2 }).notNull().default('0'),
  // Cuándo empezó el silencio actual (ancla para contar bloques de horas sin
  // reservas). Null cuando discountPct = 0 (no hay episodio de bajada activo).
  silenceStartAt:     timestamp('silence_start_at', { withTimezone: true }),
  // Nº de reservas de esa fecha vistas en la última pasada — para detectar
  // cuántas son NUEVAS (recuento actual − este) sin tener que releer todo el
  // histórico de reservas cada vez.
  bookingsSeenTotal:  integer('bookings_seen_total').notNull().default(0),
  // Reservas nuevas acumuladas hacia el próximo escalón de subida (se
  // resetea cada vez que se consume un escalón).
  bookingsTowardStep: integer('bookings_toward_step').notNull().default(0),
  updatedAt:          timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

// Último estado (precio/disponibilidad/cierre) empujado con éxito a FDM por
// cada combinación fecha × tarifa FDM × tipo de habitación FDM — así el push
// manual (POST /api/fdm/push-prices, ver src/routes/fdm.ts) puede comparar lo
// recién calculado contra esto y enviar solo lo que de verdad cambió (precio
// O disponibilidad — la disponibilidad puede cambiar sin que cambie ningún
// precio, por una reserva/cancelación/bloqueo).
export const fdmPushState = pgTable('fdm_push_state', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  date:         date('date').notNull(),
  fdmRateId:    integer('fdm_rate_id').notNull(),
  fdmRoomUseId: integer('fdm_room_use_id').notNull(),
  price:        numeric('price', { precision: 10, scale: 2 }).notNull(),
  avail:        integer('avail').notNull(),
  closed:       boolean('closed').notNull().default(false),
  pushedAt:     timestamp('pushed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.propertyId, t.date, t.fdmRateId, t.fdmRoomUseId)])

// Igual que fdmPushState pero para Jumbo — un solo precio por fecha (no hay
// distinción por tipo de habitación en el contrato de Jumbo). Sustituye al
// enfoque anterior (comparar rate_daily_prices.updatedAt de la celda raíz de
// tarifa raíz contra un jumboPushedAt en esa misma fila): ese enfoque no detectaba
// una edición manual hecha DIRECTAMENTE sobre la tarifa JUMBO AL (que no toca
// la fila de tarifa raíz) — comparar por VALOR contra el último precio resuelto y
// empujado cubre ambos casos (cambio en tarifa raíz que se hereda, y override
// manual directo en JUMBO AL) sin importar de dónde vino el cambio.
// price/availability/stopSales van por separado (nullable) — una fecha puede
// tener solo precio cacheado, solo disponibilidad, solo parada de ventas, o
// cualquier combinación, según qué se haya empujado hasta ahora; el push
// manual/automático solo actualiza el campo que de verdad se envió esa vez.
// stopSales: true = la fecha está cerrada a la venta en Jumbo (setStopSales,
// operation=Y) porque la disponibilidad calculada (global − colchón) dio
// ≤ 0 — se usa en vez de mandar 0 por setStock (ver src/lib/jumbo-push.ts).
export const jumboPushState = pgTable('jumbo_push_state', {
  id:           serial('id').primaryKey(),
  propertyId:   integer('property_id').notNull().references(() => properties.id),
  date:         date('date').notNull(),
  price:        numeric('price', { precision: 10, scale: 2 }),
  availability: integer('availability'),
  stopSales:    boolean('stop_sales'),
  pushedAt:     timestamp('pushed_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [unique().on(t.propertyId, t.date)])

export type Season                 = typeof seasons.$inferSelect
export type NewSeason              = typeof seasons.$inferInsert
export type PricingRule            = typeof pricingRules.$inferSelect
export type PricingRuleApplication = typeof pricingRuleApplications.$inferSelect
export type PriceChangeLogRow      = typeof priceChangeLog.$inferSelect
export type DemandPulseState       = typeof demandPulseState.$inferSelect
