# Betan Booking Manager (betan-bm) — Inventario de funcionalidades

> Documento generado leyendo el código fuente de `betania-booking-manager` (rama `dubai`, 133 migraciones, ~28.000 líneas en `src/routes` + `src/lib`, ~23.500 en `frontend/views`).
> Estado: PMS hotelero con IA en producción en Hotel Betania (Benalmádena). Todo lo descrito existe en código; lo que NO existe se indica expresamente (p. ej. VERIFACTU).
> Convenciones: **Rol** = quién lo usa (`direccion`, `recepcion`, `conserje`, `limpieza`, `mantenimiento`, `cocina`, `huésped`, `público`, `sistema`). Rutas bajo `/api/...`. "Tablas" = Drizzle (`src/db/schema`) salvo las marcadas *(SQL)*, que existen solo en migraciones.

> **Documentación ampliada.** Este inventario es el resumen; el detalle (con límites y huecos conocidos) está en `docs/features/`:
> - [IA-AGENTE.md](features/IA-AGENTE.md): agente "Betan", 84 tools, permisos, briefing, tareas programadas, voz.
> - [REVENUE-MOTOR-PRECIOS-COMPETIDORES.md](features/REVENUE-MOTOR-PRECIOS-COMPETIDORES.md): las 8 reglas, auditoría "Efecto reglas", competidores, canales, recuperación.
> - [SES-CHECKIN-CUMPLIMIENTO.md](features/SES-CHECKIN-CUMPLIMIENTO.md): SES Hospedajes, escáner de DNI, contrato, check-in online, acceso, RGPD.
> - [EXTRAS-DESCUBIERTOS.md](features/EXTRAS-DESCUBIERTOS.md): auditoría de huecos de este documento, top 15 a destacar, funcionalidades a medias.
> Las correcciones verificadas de esa auditoría ya están aplicadas aquí; ver también la sección 25.

---

## Índice

1. Reservas y planning
2. Habitaciones y tipos
3. Huéspedes
4. Motor de reservas web, widget y portal del huésped
5. QR de habitación
6. Tarifas, derivación, calendario de precios y motor de reglas dinámicas
7. Competidores
8. Recuperación de carritos y de cancelaciones; descuento temporal
9. Facturación y contabilidad
10. Caja de cambio
11. Housekeeping, zonas comunes, desayunos y lavandería
12. SES Hospedajes
13. Escaneo de DNI con IA (visión)
14. Contratos y firma
15. Alertas
16. Implicación del personal (engagement)
17. Feedback de huéspedes
18. Mensajería (email Resend, WhatsApp Meta) y configuración de mensajes
19. Usuarios, roles y permisos
20. Agente IA (tools, tareas programadas, voz, chat, Android, informe diario)
21. Integraciones (TTLock, ZKTeco, Nobeds, FDM, Jumbo, Stripe, Google, SerpAPI, Pexels, piscina, RunPod/Anthropic)
22. Informes y paneles
23. Capacidades de un vistazo (tabla resumen)
24. Limitaciones conocidas / deuda
25. Controles de calidad y conciliación (hallazgos de alto valor)

---

## 1. Reservas y planning

**Qué hace.** Ciclo de vida completo de la reserva con estados `tentative` (provisional: carrito web sin pagar o reserva FDM sin confirmar), `arriving` (llega hoy, aún sin check-in), `confirmed`, `checked_in`, `checking_out`, `checked_out`, `cancelled`, `no_show`.

- Alta/edición manual con historial de cambios (campos, habitación, fechas, tarifa, canal, precio, personas) y línea de tiempo (`reservation_status_logs`, notas).
- Cálculo de precio por noche (`GET /reservations/calc-price`) con el mismo resolvedor que usa el motor web (`src/lib/price-resolver.ts`): tarifas derivadas y tipos de habitación derivados.
- Check-in / check-out / cancelación / revertir check-in / abandono del proceso de check-in; no-show.
- **Reservas de grupo**: habitaciones adicionales (`extra_room_ids`), huéspedes adicionales con habitación concreta dentro del grupo (`reservation_nights`), cambio de titular conservando al anterior como acompañante.
- **Split de estancia** (`POST /:id/split`): parte la reserva en una fecha de corte y crea una continuación en otra habitación repartiendo precio proporcionalmente.
- Extras de reserva (`reservation_sale_items`), depósitos/fianzas (`deposit_items`, métodos `deposit`/`deposit_cc`), notas internas.
- Confirmación de reserva por email/WhatsApp (manual) y HTML imprimible (`confirmation-print`); enlaces de check-in online y recordatorio de pago por email/WhatsApp.
- Borrado total (solo dirección).
- Auto-estado diario a las 12:00 (`autoStatus`): confirmed→arriving, →no_show, checked_in→checking_out, y cancela tentatives caducadas (carritos web tras `maxAgeHours`).
- Búsqueda global (topbar) por ID/código externo, nombre, habitación.
- **Planning** (Gantt) por rango: `GET /reservations/planning`; vista de camas (`GET /rooms/bed-view`), camas bloqueadas (`blocked_beds`).
- Reglas de edición de campos configurables (`reservation_field_rules`): qué campos puede tocar cada rol.
- Canales de venta (`booking_channels`: Booking.com, Agoda, Jumbo, web directa, etc.), operadores, comisiones por canal (informe Comisiones, `bmCommission`).
- Corporativo: detección de empresa por forma de CIF en el NIF de facturación (`corporateDetection.ts`) y ofertas de precio fijo semanal (`corporate_offers`).

**Rol.** `recepcion` y `direccion` gestionan (`canManageReservations`); `conserje`/`mantenimiento`/`cocina` ven según vista; `limpieza` NO accede a reservas.

**Rutas clave.** `GET/POST /reservations`, `GET /reservations/{search,stats,planning,calc-price}`, `GET/PATCH/DELETE /reservations/:id`, `POST /:id/{check-in,check-out,cancel,revert-checkin,checkin-abandon,checkin-start,split,notes,extras,guests,change-primary-guest,contract,send-confirmation,checkin-email,payment-email}`, `GET /:id/{history,guests,extras,contracts,confirmation-print}`; `GET /dashboard/{arrivals,departures,in-house,billing,occupancy,recent}`; `/corporate/{companies,offers}`.

**Nota:** `cityTax` y `cityTaxFromPortal` existen en el esquema pero ningún código las usa: la tasa turística no se calcula ni se factura.

**Tablas.** `reservations` (≈75 columnas: código externo, estado, fechas, canal, tarifa, total/originalTotal/amountPaid, comisiones, flags de check-in online, TTLock, ZKTeco, SES, Nobeds, split…), `reservation_nights`, `reservation_notes`, `reservation_field_rules`, `reservation_sale_items`, `deposit_items`, `reservation_status_logs` *(SQL)*, `booking_channels`, `operators`, `corporate_offers`, `blocked_beds`.

## 2. Habitaciones y tipos

**Qué hace.** CRUD de habitaciones físicas y de tipos; características físicas (baño ducha/bañera, terraza, balcón, cama, m², vista mar/piscina/interior/lateral, marca AC/TV, tipo de cerradura), código, orden, colores en planning. Tipos con ocupación máxima, camas extra y precio de cama extra, **ocupación máxima específica para el motor de reservas** (`maxOccupancyBookingEngine`), etiqueta en el motor (`bookingEngineLabel`), foto, habitaciones virtuales (varias reservas simultáneas), **tipos derivados** (`baseRoomTypeId` + `adjustType/adjustValue`: p. ej. "Doble Superior" = Doble + X €), mapeo a Nobeds (`nobedsRoomId`), disponibilidad forzada por día (`room_avail_overrides`). Disponibilidad por rango y por reserva (`/rooms/availability`, `/available-for-reservation`). Bloqueo de camas/habitaciones con vínculo a incidencias de mantenimiento (alerta). Generación del QR de cada habitación (`GET /rooms/:id/qr`, token opaco `rooms.qrToken`) y script de impresión (`scripts/print-room-qrs.ts`).

**Rol.** Lectura todos; edición dirección/admin.
**Rutas.** `/rooms`, `/rooms/types`, `/rooms/blocked-beds`, `/rooms/:id/qr`, `/catalog/avail/:roomTypeId/:date`.
**Tablas.** `rooms`, `room_types`, `room_avail_overrides`, `blocked_beds`.

## 3. Huéspedes

**Qué hace.** Ficha de huésped (datos personales, documento `dni|nie|passport|driving_licence|other`, nacionalidad, nacimiento, dirección con autocompletado Google Places y base postal española offline `postal-es.json`), valoración interna del huésped 1-5, estadísticas demográficas (`/guests/stats`, pestaña "demo"), listado/búsqueda, lista de **nombres bloqueados** (rechaza nombres basura al crear/editar), validación de texto (`textValidation.ts`, con tests). Importación masiva (scripts: `import-guests-xls.ts`, `fdm-enrich-guests.ts`).

**Rol.** `recepcion`/`direccion` (no `limpieza`). **Rutas.** `/guests`, `/guests/stats`, `/settings/blocked-guest-names`, `/postal/{cp/:cp,cities}`. **Tabla.** `guests`.

## 4. Motor de reservas web, widget y portal del huésped

### 4.1 Motor de reservas (`/booking`, `frontend-public/booking.tsx`)
- Búsqueda de disponibilidad y precio por tipo/tarifa (`GET /public/availability`), extras vendibles (`GET /public/extras`), 7 idiomas (es, en, fr, de, it, uk, zh; `i18n.ts`).
- Checkout con **Stripe Checkout** (`POST /public/checkout`): crea reserva `tentative`, sesión de pago, extras, preferencia de cama twin, descuento temporal validado en servidor. Origen `standalone` o `widget` (decide URL de vuelta).
- Reanudación de reserva pendiente tras pago cancelado (`GET /public/booking/pending/:id`, `POST /public/checkout/resume`).
- **Webhook Stripe** (`POST /public/stripe/webhook`, firma verificada, idempotente) que confirma la reserva y trata cuatro tipos de sesión: reserva nueva, `pending_payment` (saldo desde portal), `extra_purchase` (extras desde portal) y `extend_stay` (ampliación); `checkout.session.expired` libera/cancela. Fallback `GET /public/booking/confirm`.
- Conversión de Google Ads (`GOOGLE_ADS_ID` + `GOOGLE_ADS_CONVERSION_LABEL` en `GET /public/config`; `gtag.ts`).
- Proxy de Google Places (autocompletado de dirección; la API key no sale del servidor).

### 4.2 Widget embebible (`/booking-widget`, `/portal-widget`)
Versiones iframe del motor y del portal para incrustar en la web del hotel (nginx emite `frame-ancestors` para `hotelbetania.es`).

### 4.3 Portal del huésped (`/portal`, `frontend-public/portal.tsx`, API `/customer`)
- **Magic link** por email (`POST /public/auth/send`, `GET /public/auth/verify`), rate-limit en memoria por email; JWT de cliente 30 días (`type:'customer'`) y tabla `customer_tokens`. Sustitución del email temporal de Booking (`PATCH /customer/email`).
- Mis reservas y detalle; **check-in online** (`POST /customer/reservations/:id/checkin`) con validación de DNI/NIE/pasaporte, nacionalidad, fecha de nacimiento, hora de llegada y dirección; firma de contrato (`/sign`).
- **Pago** del saldo pendiente por Stripe (`/pay`), compra de **extras** (`/extras`), descarga de **factura** y solicitud de factura (`/invoice`, `/request-invoice` → email al hotel).
- **Ampliación de estancia autopagada** (`/extend-quote`, `/extend`, máx. 14 noches; solo reservas de una habitación y saldadas; el check-out solo cambia en el webhook tras cobrar; si la habitación está ocupada pero hay otra libre del mismo tipo se avisa a dirección para reubicar — alertas `extend-unavailable`/`extend-needs-relocation`).
- Feedback del huésped (`/feedback`) → hilo `source='guest'`.

**Rol.** Público / huésped. **Tablas.** `customer_tokens`, `reservations`, `financial_transactions`, `guest_contracts`, `feedback_threads`, `sale_items`.

## 5. QR de habitación

Cada habitación tiene un QR con token opaco (`rooms.qrToken`). `/room?t=…` (`frontend-public/room.tsx`): el huésped alojado ahora (checked_in/checking_out, incluyendo habitaciones adicionales) confirma su primer apellido y recibe un JWT corto (`type:'room-guest'`) acotado a esa reserva. Permite ver la estancia, **ampliarla** (mismo flujo Stripe que el portal), pedir extras, dejar feedback y **solicitar la limpieza del día** (`housekeeping-today`, `housekeeping-request`). Cada carga registra una visita (`room_access_visits`) para el informe "Uso QR habitaciones". Rutas: `POST /room-access/verify`, `GET /room-access/reservation`, `GET /extend-quote`, `POST /extend|extras|feedback|housekeeping-request`. Rol: huésped; informe: dirección/recepción. Tablas: `rooms`, `room_access_visits`.

## 6. Tarifas, derivación, calendario de precios y reglas dinámicas

### 6.1 Tarifas y precios
- Tarifas (`rates`): código, `activeForBookingEngine`, ajuste (`fixed|percentage`) respecto a `baseRateId` (**derivación encadenada**, p. ej. Dir AL → Dir HD → JUMBO AL +31 %), `highWeekDays`, min/max estancia, política de cancelación, bloqueo (`lock/unlock`), operador asociado.
- Precios diarios (`rate_daily_prices`: `basePrice` manual + `price` ajustado por reglas), edición puntual y masiva, borrado, histórico de cambios (`price_change_log`), temporadas con precio mínimo (`seasons`), disponibilidad forzada.
- Resolutor común (`price-resolver.ts`): tarifa derivada × tipo derivado, con inversión de cadena para saber qué precio poner en la raíz "Dir AL" para lograr un objetivo en una tarifa derivada.
- **Calendario de precios** (`PriceCalendarView`): pestañas calendario, competidores, histórico y configuración (tarifas/tipos/días por defecto); fila resumen de ocupación, ADR semanal real coloreando el calendario.
- Rutas: `/catalog/rates*`, `/catalog/rates/calendar`, `/catalog/rates/:id/prices/*`, `/catalog/rates/price-history`, `/catalog/seasons`, `/catalog/pricing-rules`.
- Tablas: `rates`, `rate_daily_prices`, `seasons`, `price_change_log`, `room_avail_overrides`.

### 6.2 Motor de reglas de precio dinámico (`src/lib/pricingRulesEngine.ts`, cada 30 min)
Ajusta la tarifa raíz **Dir AL** (de ella derivan las demás). Siempre parte de `basePrice` (el precio manual) y nunca acumula sobre sí mismo. **Una sola regla por fecha**: gana la de menor `priority` (empate: id menor); las prioridades iniciales (migr. 0113): parada de reservas < liquidación nocturna < venta de superiores < lead time < mínimos locales < disponibilidad baja < competidores. Un override manual reciente se respeta (ventana configurable) y caduca. Cada aplicación queda en `pricing_rule_applications` (alerta morada). Tras cada pasada se empuja a Jumbo (`syncJumboPrices`).

| Tipo | Efecto | Ventana | Condición |
|---|---|---|---|
| `low_availability` | SUBE | hoy+30 d | disponibilidad < umbral |
| `lead_time_dip` | BAJA | solo el día = hoy + lead time medio de Booking (28 d) | ocupación de ese día < umbral |
| `local_min_dip` | BAJA | hoy+3…hoy+60 | mínimos locales discretos de ocupación (mesetas completas) < umbral; cede ante `lead_time_dip` |
| `demand_pulse_dip` | BAJA progresivo (con memoria, `demand_pulse_state`) | hoy…hoy+3 | bloques de `pulseSilenceMinutes` (def. 240) sin reservas nuevas que pasen por esa noche; sube de vuelta ½ escalón cada 2 reservas; retirada total si ocupación > umbral o hay `booking_surge`; suelo = `minAdrFloorPct` % del ADR real semanal (fallback −30 %) |
| `booking_surge` ("reservas seguidas") | SUBE | noche | ≥2 reservas hechas en los últimos N minutos (`thresholdPct` = ventana) cuya estancia pasa por esa noche; sin memoria |
| `competitor_undercut` | BAJA | hoy+3…hoy+21 | precio de la tarifa de referencia > el más barato de competidores activos y ocupación < umbral; objetivo = −x % sobre el más barato del competidor |
| `sold_out_upsell` | BAJA el tipo origen agotado | hoy+30 d | origen con 0 disponibles → el tipo destino (derivado) queda a precio original del origen + X € |
| `evening_clearance_dip` | BAJA por hora | solo HOY desde `clearanceStartHour` (def. 20:00) | precio > ADR semanal real y ocupación de hoy < umbral; −adjustValue % por hora completa, suelo `minAdrFloorPct` % del ADR; sin ADR real no actúa |

Extras: estado/diagnóstico del motor (`getPricingEngineStatus`, `getPricingDateDiagnosis`, tool IA `get_pricing_rules_status`), alerta de salud del motor, informe **Efecto reglas** (`/pricing-effects`: reservas de esa noche en las 72 h antes/después de cada cambio de precio). Tests: `pricingRulesEngine.test.ts`, `pricingEffects.test.ts`.
Rol: configuración `direccion`; lectura calendario `recepcion`/resto salvo `limpieza`.

**Resumen ampliado.**
- El motor corre cada 30 min (con una pasada inmediata al arrancar), omite la pasada si la anterior sigue en curso y calcula siempre desde `basePrice`, de modo que el ajuste no se acumula ni se contagia entre pasadas (salvo `demand_pulse_dip`, la única con memoria). La ocupación es la de calendario (habitaciones físicas + camas bloqueadas, respetando overrides de disponibilidad), la misma que ve el usuario en la fila resumen.
- Suelos de seguridad: las reglas de bajada con memoria no bajan de `minAdrFloorPct` % del ADR real semanal (o −30 % si aún no hay ADR). Es el "suelo" que el agente también cita al recomendar precios.
- **Efecto reglas** (`pricingEffects.ts`, `GET /pricing-effects?days=3-120`, solo dirección): para cada cambio con más de 72 h mide las reservas de esa noche hechas 72 h antes y 72 h después y agrupa por regla (o "Manual"). Veredicto: *Funciona*, *Sin efecto*, *Perjudica* o *Pocos datos* (menos de 8 cambios), con consejo en texto ("rebajas sin más reservas: se está regalando precio, reduce el descuento…"). Es indicativo, no causal, y mide reservas, no euros. Lo consulta el agente en el briefing matutino.
- Auditoría completa: `price_change_log` (todo cambio, manual o automático, con regla y lote), `pricing_rule_applications` (alerta morada) y diagnóstico por fecha ("por qué esta fecha tiene este precio").
- **Push diferencial a canales** (`fdm_push_state`, `jumbo_push_state`): se guarda el último vector {precio, disponibilidad, cerrado} por fecha × tarifa × tipo y solo se reenvía lo que cambió, con opción `force`. Jumbo se actualiza solo tras cada pasada del motor; FDM y Nobeds (Expedia, tarifa "Expedia AL") se lanzan con botón.
- Límites reconocidos: sin previsión de demanda ni pickup histórico, sin restricciones dinámicas (CTA/CTD, LOS), una sola regla activa por tipo, los eventos locales no alimentan el motor y hoy es monohotel (ids fijos). Detalle: [REVENUE-MOTOR-PRECIOS-COMPETIDORES.md](features/REVENUE-MOTOR-PRECIOS-COMPETIDORES.md).

## 7. Competidores

Alta de hoteles competidores con su plataforma (parsers `paraty` y `cloudbeds` en `competitorPricing.ts`; añadir un motor nuevo requiere código). Lee el precio público desde la API del propio motor de reservas del competidor (nunca de Booking, por términos de uso). Divisor configurable por hotel (`bookingEffectiveDivisor`, def. 1,38 ≈ Genius + 10 %) para comparar contra un precio realista. Refresco diario a las 06:00 y manual (`POST /competitors/:id/refresh`); un precio por competidor y noche (el más barato, null si sin disponibilidad). Comparativa nuestro precio base vs competidores (`GET /competitors/prices`) en la pestaña Competidores del calendario; la usa la regla `competitor_undercut`. Rol: lectura recepción, gestión dirección. Tablas: `competitor_hotels`, `competitor_prices`.

**Resumen ampliado.** Soporta dos motores (Paraty y Cloudbeds), filtrando en Cloudbeds la habitación de baño privado más barata; un fallo en un hotel no detiene a los demás. El divisor Booking/Genius (def. 1,38) convierte el precio de mostrador en un precio efectivo comparable (120 EUR de web / 1,38 = 86,96 EUR); es una estimación manual por hotel y no se contrasta con Booking. La comparativa (por defecto 45 días, hasta 365) muestra nuestro "desde X EUR" tras reglas frente a cada competidor, y `null` indica competidor agotado (señal de demanda). El agente la usa (`get_competitor_comparison`, hasta 60 días) en el briefing. **Eventos locales**: SerpAPI (Google Events) para Benalmádena/Málaga con impacto alto/medio/bajo por palabras clave; a las 09:00 avisa a dirección, pero es solo informativo y no mueve precios. Detalle: [REVENUE-MOTOR-PRECIOS-COMPETIDORES.md](features/REVENUE-MOTOR-PRECIOS-COMPETIDORES.md).

## 8. Recuperación de carritos y de cancelaciones; descuento temporal

- **Carritos abandonados** (`cartRecovery.ts`, cada 10 min): detecta reservas web `tentative` sin pagar entre `minAgeMin` y `maxAgeHours`, las registra (`abandoned_carts`) y envía email/WhatsApp con enlace de recuperación (`GET /public/recover/:token`) con **descuento escalonado** (`discountTiers`) válido `validityHours`; segmentación (teléfono nuevo, nombre nuevo, primera vez). Alerta "carrito abandonado con teléfono — llamar" con confirmación. Informe "Carritos abandonados".
- **Reenganche de canceladas** (`cancellationRecovery.ts`, cada 10 min): reservas recién canceladas (`minAgeHours`–`maxAgeHours`) con email real (no alias de Booking); descuento sobre el menor entre lo pagado y lo que costaría hoy con la MISMA tarifa; el enlace (`/public/recover-cancellation/:token`) crea una reserva NUEVA.
- **Descuento temporal** (`/public/discount-timer`): al rellenar email+nombre arranca un temporizador en servidor; a los `activationMinutes` se activa un descuento válido `windowMinutes`; el servidor valida el token (ligado a email/nombre, 1 uso real por persona cada 2 días).
- Configuración en Tarifas → Promociones Web (`/catalog/{cart-recovery,cancellation-recovery,temporary-discount}-settings`), dirección.
- Recuperación y descuento temporal son descuentos dirigidos por intención (no por fecha): no tocan la tarifa pública ni contaminan el ADR de referencia. Los resultados se miden en los informes de Carritos y de Reenganches; para la publicidad, el motor dispara la conversión de Google Ads solo con importe realmente pagado (conversiones mejoradas, linker entre dominios y deduplicación por `transaction_id`).
- Tablas: `abandoned_carts`, `cart_recovery_settings`, `cancellation_recoveries`, `cancellation_recovery_settings`, `temporary_discount_settings`, `booking_discount_timers`.

## 9. Facturación y contabilidad

- **Cuentas financieras (cajas)**: efectivo, tarjeta, Stripe, etc. con saldo (`/financial/accounts`, `/accounts/status`); **formas de pago configurables** (`payment_method_configs`) sobre el enum `cash|credit_card|bank_transfer|stripe|booking_virtual_card|deposit|deposit_cc|jumbo_credit|other`.
- **Transacciones/pagos**: registrar, editar (importe/caja/forma solo admin; descripción también recepción), borrar (admin), "cobrar" depósito, **"Cobrado en otro turno"** (corrige fecha/hora real y quién cobró, con rastro en `payment_date_corrections` + informe de pagos corregidos). Turnos de caja (`shifts`) y cobros en efectivo (`cash_collections`).
- **Facturas**: manual, desde reserva (parcial/total, nunca más de lo pendiente de facturar), **rectificativa/abono** (`credit-note`, importes negados, "Factura rectificativa de X"), edición (admin), borrado (dirección), numeración configurable (`{N:7}/{YYYY}`, contador en `invoice_settings`), IVA configurable (def. 10 %), plantilla HTML editable, **proforma** (datos para imprimir, no se guarda). **Auto-facturación**: cada pago con tarjeta, Stripe o Jumbo a crédito crea/actualiza la factura `[auto]` de la reserva (las manuales no se tocan); Jumbo factura a JUMBONLINE ACCOMMODATIONS & SERVICES SL.
- Informes de caja: resumen por forma de pago y caja (`/financial/reports/summary`, `/reports/payments`), pestaña "Facturación" (pendientes, resumen, todas, analytics, caja).
- Auditoría de facturas con IA (tool `get_invoice_anomalies`: duplicados, huecos, facturas a 0 €); scripts de reconciliación (`debug-invoice-*`, `find-total-paid-mismatch.ts`).
- Cálculo de saldo real sin contar depósitos retenidos (`paymentAggregate.ts`).
- **VERIFACTU / Facturae / TicketBAI / SII: NO implementado** (sin hash encadenado, sin QR tributario, sin envío a AEAT; no hay ninguna referencia en el código). Las facturas son PDF/HTML internos.
- Rol: dirección (Facturación), recepción+dirección (Facturas, Transacciones; `limpieza` excluida). Tablas: `financial_accounts`, `payment_method_configs`, `financial_transactions`, `payment_date_corrections`, `shifts`, `cash_collections`, `invoices`, `invoice_settings`, `sale_items`. Rutas: `/financial/*` (29 endpoints).

## 10. Caja de cambio

Arqueo por denominaciones contra una consigna (p. ej. 500 €): efectivo contado + gastos sin reponer = consigna; gastos por reponer (`expenses`, reposición), comprobación de **depósitos de garantía en efectivo** de huéspedes en casa; histórico. Alertas de descuadre/arqueo faltante en primer/segundo turno y de depósitos. Rol: recepción y dirección. Rutas: `/cash-drawer`, `/count`, `/deposit-check`, `/expenses`, `/replenish`. Tablas: `change_drawer_counts`, `change_drawer_expenses`, `change_drawer_deposit_checks`.

## 11. Housekeeping, zonas comunes, desayunos y lavandería

- **Housekeeping** (`/housekeeping?date=`): genera solas las tareas del día (salida `departure` y estancia `stay` solo si `checked_in`), incluye habitaciones adicionales de reservas de grupo; asignación individual y por bloques a limpiadores; estado pendiente/hecha; cambios de lencería, No Molestar, notas; **objetos robados** (marca en salida → alerta global hasta nuevo depósito); la petición de limpieza llega también desde el QR de habitación. Vistas "Salidas / Clientes (estancia)".
- **Zonas comunes** (`common_area_tasks`): 8 zonas fijas (baño recepción, baños planta 2, recepción, comedor, salón planta 2, pasillos, escalera/ascensor bajo, ascensor alto), asignación, marcar limpio y **reposición de papel higiénico** (`paperRefilledAt/By`).
- **Desayunos**: lista diaria a preparar/servir (de tarifa y de extras), servir/desmarcar (`breakfast_logs`), "no hay servicio" (`breakfast_no_service`), **valoración diaria 1-10** del servicio (`breakfast_service_ratings`), alerta de desayuno sin confirmar (11-13 h), servicio flojo (≤5, corte 15 h) e inventario de desayunos desactualizado (desde la app de mantenimiento).
- **Lavandería**: entregas de ropa (toallas ducha/mano/pie, juegos de sábanas) con confirmación de recepción por el receptor, discrepancias y su reconocimiento, **procesado por lotes** con estados de prenda (listas, tendidas, en agua, sucias), sugerencias; alerta de procesado sin declarar (16:30–19:00). Informes de lavandería y de productividad de housekeeping por trabajador.
- Rol: `limpieza` (su página de inicio es housekeeping), `conserje`, `cocina` (desayunos), `recepcion`, `direccion`. Tablas: `housekeeping_tasks`, `common_area_tasks`, `breakfast_logs` *(SQL)*, `breakfast_no_service`, `breakfast_service_ratings`, `laundry_deliveries`, `laundry_process_batches`, `laundry_process_items`.

## 12. SES Hospedajes (Ministerio del Interior, RD 933/2021)

Cliente SOAP/HTTPS (Basic Auth) con XML comprimido ZIP+Base64, XSD v3.1.3: alta de parte de viajeros (titular + acompañantes), consulta de lote y anulación; entorno **pre** y **pro** (`SES_PRODUCCION=true`). Validación local previa (`GET /ses/validate/:id`) sin enviar, envío (`POST /ses/submit/:id`), estado, listado de partes y consulta de lote. Marca `reservations.sesSubmittedAt`. Catálogos (`scripts/ses-catalogo.ts`, `countries.json`). Envío **manual** desde la vista SES / reserva (no hay scheduler). Rol: recepción y dirección.

**Corrección verificada:** `anularComunicaciones` existe en `src/lib/ses.ts` pero **ninguna ruta ni pantalla lo llama**: hoy no hay anulación desde la UI (ni comunicación de modificación o baja por cancelación).

**Resumen ampliado.**
- Un parte = un contrato de hospedaje + una persona por huésped (rol viajero). Los menores se envían sin documento; el número de personas es el de fichas cargadas.
- Validación local previa (titular y acompañantes): nombre, primer apellido y nacimiento; email o teléfono; tipo y número de documento y nº de soporte para adultos con DNI/NIE; segundo apellido para NIF. La UI de recepción además exige dirección completa, país válido y municipio INE de 5 dígitos (base postal offline) y bloquea el check-in manual si hay errores.
- Ayudas: país a ISO-3 desde 249 países, catálogo postal español offline, `SesView` con consulta de lote individual o "consultar todos" (rango máx. 2 días).
- Límites: envío manual sin scheduler ni alerta de parte pendiente o con errores; credenciales por `.env` (una cuenta por instalación); no hay integración específica con Mossos d'Esquadra/Ertzaintza; el alta de arrendador en el Ministerio es un trámite previo que el producto no asiste.
- Detalle: [SES-CHECKIN-CUMPLIMIENTO.md](features/SES-CHECKIN-CUMPLIMIENTO.md).

## 13. Escaneo de DNI con IA (visión)

`IdScanView` (móvil, sin app nativa): recepción fotografía DNI/NIE/pasaporte; el servidor envía la imagen (data-URL jpeg/png/webp ≤ 8 MB) a Anthropic (modelo `VISION_MODEL` = **claude-sonnet-5**; el comentario del código aún dice Haiku) con una tool de extracción estructurada, el usuario revisa/corrige y se aplica al titular o a un acompañante (`GET /id-scan/:id/slots`, `POST /extract`, `POST /:id/apply`). Solo reservas con check-in HOY y estado `arriving|confirmed` (deliberadamente más estricto que la ficha normal). Validación de formato de documentos en `frontend/lib/idDocValidation.ts`. Rol: recepción/dirección. Reduce la imagen en el navegador (lado máx. 1600 px) y **no la guarda** en el servidor. La IA lee el texto visual: no hay lectura MRZ; la letra de control DNI/NIE se valida solo en el frontend, y la nacionalidad se guarda como texto libre (si no es un código ISO, el parte SES la rechazaría). Detalle: [SES-CHECKIN-CUMPLIMIENTO.md](features/SES-CHECKIN-CUMPLIMIENTO.md). (Funcionalidad nueva, aún sin commit en la rama.)

## 14. Contratos y firma

Contrato de admisión del huésped (HTML autocontenido generado por `contract.ts`, PDF base embebido en el binario `public/docs/contrato-admision.pdf`). Recepción genera un **enlace de firma** (`POST /reservations/:id/contract`), el huésped firma en el móvil (`/sign`, `GET/POST /public/contract/:token[/sign]`, firma embebida en base64) y queda archivado (`GET /:id/contracts[/:cid/html]`). Sustituye a la tableta Wacom. Tabla: `guest_contracts`.

Detalle: enlace con token de 64 caracteres y caducidad de 24 h (con QR para escanear en el móvil), firma dibujada (PNG ≤ 800 KB) que se incrusta en el HTML archivado junto a fecha/hora (Madrid), IP y nº de reserva; es firma electrónica simple (sin hash ni sello cualificado). El check-in se bloquea si existe contrato sin firmar (pide motivo de ≥15 palabras), pero no si nunca se generó. El **check-in online** del portal es un formulario único solo para el titular (documento, nacionalidad, nacimiento, dirección con Google Places, hora de llegada): no recoge nº de soporte, segundo apellido ni acompañantes, ni firma el contrato, ni envía el parte SES ni genera el código de puerta; eso lo hace el check-in físico (TTLock offline o tarjeta ZKTeco con regla de saldo cero). Los datos fiscales del hotel están hardcodeados en `contract.ts`. Ver [SES-CHECKIN-CUMPLIMIENTO.md](features/SES-CHECKIN-CUMPLIMIENTO.md).

## 15. Alertas

Sistema calculado **en vivo** (`GET /alerts/urgent`, barra `UrgentAlertsBar`) con severidades urgent/warning/info/suggestion, alertas agrupadas, acción de "hecho" y filtro por rol y hora (Europe/Madrid). Tipos (31, activables desde `alert_configs`): `checkout-pending`, `hk-unassigned`, `unpaid-reservation`, `zero-total-reservation`, `unassigned-room`, `new-extras-web-directa`, `booking-no-checkin`, `no-show-booking`, `stolen-items`, `laundry-process-missing`, `drawer-mismatch` / `drawer-missing-first|second`, `drawer-deposits-mismatch` / `-missing-first|second`, `checkin-abandoned`, `breakfast-unconfirmed`, `breakfast-inventory-stale`, `breakfast-service-low`, `stale-room-incident`, `blocked-room-no-incident`, `bed-preference-mismatch`, `in-house-no-access`, `zkteco-unenrolled-card`, `abandoned-cart-call`, `pricing-rule-applied`, `pricing-engine-health`, `high-occupancy`, `feedback-complaint-open`, más las de ampliación (`extend-unavailable`, `extend-needs-relocation`) y la manual "Comunicarse con Dirección urgente". Historial persistente (`alert_events`), silenciar, marcar visto, informe por empleado/turno. Rol: recepción/dirección ven las suyas; `AlertsView` (config e historial) solo dirección. Rutas: `/alerts/*`. Tablas: `alert_configs`, `alert_events`, `alert_seen_marks`.

## 16. Implicación del personal (engagement)

Heurística transparente 0-100 por empleado a partir de acciones con autor+fecha (reservas, estados, cobros, notas, limpieza, precios manuales, alertas silenciadas, turnos de caja y actividad en la app de mantenimiento vía `externalStaffActivity.ts`): 50 % volumen (frente a la mediana de su rol) + 50 % constancia. Rating "oficial" = media ponderada de 3 periodos de 30 días (50/30/20) + ajustes manuales de dirección (`engagement_adjustments` *(SQL)*, también vía IA `adjust_engagement_rating`). Popup semanal al empleado. Rutas: `/engagement`, `/engagement/me`, `/engagement/adjustments`. Informe completo solo dirección; cada empleado ve el suyo.

## 17. Feedback de huéspedes

Hilos de trabajo (queja/elogio/sugerencia/neutro) con categoría, responsable, estado y plazo; los abre cualquier miembro del equipo, el huésped (portal/QR, `source='guest'`) o el agente IA (`source='ai'`); comentarios; dirección puede borrar. Alerta por queja sin resolver >24 h; pestaña Informes → Feedback. Rutas `/feedback`, `/:id/comments`. Tablas: `feedback_threads`, `feedback_comments`.

## 18. Mensajería y notificaciones

- **Control central de canales** (`messaging.ts`, Ajustes → Mensajes): por tipo de mensaje se decide email y/o WhatsApp y canales de venta excluidos. Tipos: `booking_confirmation`, `lock_code`, `checkin_link`, `payment_reminder`, `cart_recovery`, `cancellation_recovery`, `guest_thank_you` (email únicamente; check-out con valoración 5★ + petición de reseña). Plantillas de email editables con restauración de fábrica (`message_templates`, `message_settings`).
- **Email (Resend)**: confirmación, enlace de check-in, recordatorio de pago, agradecimiento, código de cerradura, magic link, recuperación de contraseña, resumen diario con gráfico PNG de ocupación embebido (`@resvg/resvg-js`).
- **WhatsApp Business Cloud API (Meta)**: plantillas aprobadas en español `betania_checkin`, `betania_pago`, `betania_codigo`, `betania_carrito`, `betania_confirmacion`; envíos manuales desde reserva (`/whatsapp/checkin/:id`, `/payment/:id`), código de cerradura y recuperaciones. Canales que cobran ellos mismos (Booking/Agoda/Jumbo) excluidos del reclamo de pago.
- **Pantalla "Notificaciones"** (`/notifications`, `NotificationsView.tsx`, solo dirección): es en realidad la **configuración de mensajería** (canales de envío, plantillas de email y de WhatsApp; usa `/api/settings/messages` y `/message-templates`). **Corrección verificada:** no existe una campana en la UI que liste la tabla `notifications`, y ningún código inserta filas en ella (tabla y `src/routes/notifications.ts` sin emisor).
- **Mensajes internos del personal** (`staff_messages`): dirección → usuario/todos, entregados al abrir el asistente; popup de mensajes importantes con acuse (`/ai/important-messages/:id/ack`).

## 19. Usuarios, roles y permisos

Roles (`staff_role`): `direccion`, `recepcion`, `conserje`, `mantenimiento`, `limpieza`, `cocina`; un usuario puede tener varios (`user_roles`) y existe `isPrimary` (superadministrador). Login email+contraseña (`Bun.password`), JWT HS256 en cookie `auth_token` (httpOnly, SameSite=Lax, 7 días) o `Authorization: Bearer`; recuperación de contraseña (autoservicio + botón de dirección; token de un uso, cooldown 15 min/email, `password_reset_tokens`); presencia en tiempo real (ping, usuarios online últimos 90 s); preferencias por usuario (tema, fuente, tamaño, fondo de panel con foto Pexels); perfil y avatar; **modo admin simplificado** (`simplifiedAdminMode`: pantalla única de resumen rápido); selector "ver como rol" para admins. Permisos aplicados en backend (`requireAuth`, `isAdmin`, `canManageReservations`) y en frontend (`Access`, `onlyDireccion`, `notLimpieza`, `recepcionODireccion`). Rutas: `/auth/{login,logout,me,forgot-password,reset-password}`, `/users/*`, `/settings/*`. Tablas: `users`, `user_roles`, `user_preferences`, `password_reset_tokens`, `properties`.

Matriz resumida de acceso del panel:

| Pantalla | direccion | recepcion | conserje/mant./cocina | limpieza |
|---|---|---|---|---|
| Inicio, Planning, Entradas/Salidas, Habitaciones, Housekeeping, Lavandería, Implicación | sí | sí | sí | sí |
| Reservas, Huéspedes, Facturas, Transacciones, Precios (calendario), Informes | sí | sí | sí | no |
| Caja de cambio, Extras, SES, Escaneo IDs, Accesos (ZKTeco) | sí | sí | no | no |
| Facturación, Tarifas, Nobeds, Notificaciones (config. de mensajería), Alertas, Usuarios, AI Debug | sí | no | no | no |

## 20. Agente IA

**Motor.** `src/routes/ai.ts` (5.500 líneas). Backend seleccionable `AI_BACKEND` = `claude` (por defecto, **claude-haiku-4-5**, SDK Anthropic), `runpod` (serverless, `RUNPOD_ENDPOINT_ID`, `AI_AGENT_API_KEY`, `RUNPOD_MODEL`) u `ollama` (local `localhost:11434`). Bucle agéntico con límite de iteraciones (6 por defecto, 14 en briefing/informe), **prompt caching** (`cache_control` en el último tool y en el system), system prompt dependiente de roles, las acciones de escritura exigen `confirmed=true` tras confirmación del usuario, y cada tool "solo dirección" se bloquea en ejecución según `ctx.roles`. Historial por sesión (`ai_chat_messages`), listado y recuperación de sesiones, logs en vivo y consola AI Debug (`/ai/debug-chat`, `/ai/logs`).

**Resumen ampliado.**
- **Gerente proactivo, no chatbot:** el prompt incorpora directrices de dirección (objetivo 100 % de ocupación, cuestionar bloqueos y cambios de precio, agrupar incidencias por causa raíz, pedir valoración 1-10 tras cada check-out, preguntas cortas de sí/no al director). Es además traductor (traduce mensajes de huéspedes y propone respuesta en su idioma) y conoce reglas de negocio como el cobro de Agoda en el check-out.
- **Briefing matutino** de solo lectura (08:00-13:00): salud del motor, efecto de reglas, competidores a 14 días, ocupación frente al año anterior, quejas abiertas y alertas; termina con "preguntas para ti" (máx. 4). Lo que propone enviar al personal queda como BORRADOR.
- **Seguridad en capas:** gate de rol en servidor para cada tool de escritura, `confirmed=true` solo tras confirmación explícita, una acción = una entidad (sin operaciones masivas) y gate de datos (importes solo dirección). Las tareas programadas ejecutan con los roles de quien las creó. Auditoría cruzada: dirección puede ver qué han hablado los demás con el asistente.
- **Voz:** Web Speech API en el panel (apagada por defecto, envío automático al detectar silencio) y app Android con wake word "Betan" y respuestas de 1-3 frases.
- **Coste:** prompt caching en tools y system prompt; el código documenta una reducción del 80-90 % en las vueltas posteriores; el coste real de cada ejecución queda en logs (estimación propia de 1-3 céntimos de dólar por consulta típica, no medida en producción).
- Detalle: [IA-AGENTE.md](features/IA-AGENTE.md).

**Superficies.**
- **Chat** flotante en el panel (`AgentFloat`; `AgentView.tsx` existe pero **no está enrutada ni importada**, el chat vive en `AgentFloat`; `POST /ai/chat`, `GET /ai/sessions[/:id]`) con acciones de navegación (`navigate`).
- **Voz** en el navegador (Web Speech API nativa: reconocimiento y `speechSynthesis` es-ES, `frontend/lib/speech.ts`) en el asistente flotante y en el Resumen rápido de dirección (`AdminQuickStats`).
- **Voice-brief Android** (`POST /voice-brief`, `GET /voice-brief/dashboard`): app nativa con wake word "Betan" (Picovoice Porcupine) y reconocedor de Android; autenticación por token estático `VOICE_APP_TOKEN`, actúa como `VOICE_APP_USER_ID`; reutiliza el mismo bucle y tools; sirve las cifras de la pantalla principal.
- **Chequeo proactivo** (`POST /ai/proactive`, `checkin` máx. 1/día/usuario en servidor, o `background`) y **bandeja** (`GET /ai/inbox`, mensajes importantes).
- **Briefing matutino** automático (08:00–13:00 Madrid, 1 vez al día, solo lectura, sesión `briefing-YYYY-MM-DD` para cada usuario de dirección; mensajes al personal quedan como BORRADOR).
- **Tareas programadas** (`ai_scheduled_tasks`): dirección programa prompts recurrentes (intervalo en días + ventana horaria); barrido cada 5 min; guardan último resultado/error.
- **Informe diario por email** (`POST /ai/daily-summary`, solo admin): ocupación del mes, alertas, gráfico PNG, redactado por el agente y enviado con Resend; se dispara con `scripts/daily-summary-cron.ts` (cron externo a las 23:00 Madrid).

**Tools (84 definidas en `TOOLS`, agrupadas).**

| Grupo | Tools |
|---|---|
| Resúmenes y KPIs | `get_today_summary`, `get_period_summary`, `get_occupancy_report`, `get_occupancy_rate`, `get_revenue`, `get_revenue_forecast`, `get_channel_stats`, `get_channel_comparison`, `get_stay_stats`, `get_booking_patterns`, `get_repeat_guests`, `get_new_bookings` |
| Reservas (lectura) | `search_reservations`, `search_reservations_by_guest_profile`, `query_reservations`, `get_reservation`, `get_reservation_history`, `get_arrivals`, `get_departures`, `get_in_house`, `get_no_shows`, `get_unassigned_reservations`, `get_pending_payments`, `get_abandoned_carts` |
| Reservas (escritura, con confirmación) | `create_reservation`, `update_reservation`, `cancel_reservation`, `check_in`, `check_out`, `assign_room`, `extend_stay`, `add_reservation_note`, `add_payment` |
| Disponibilidad y precio | `get_availability`, `search_rooms`, `get_room_stats`, `calc_rate_quote`, `calc_extension_price`, `get_price_recommendation`, `set_sale_price` (dirección: cambia Dir AL, habitación doble) |
| Huéspedes | `search_guests`, `get_guest_history`, `update_guest`, `update_guest_rating` |
| Pricing dinámico y mercado | `get_pricing_rules_status`, `get_pricing_effects`, `get_competitor_comparison`, `search_local_events` (SerpAPI) |
| Caja y facturación | `get_transactions`, `get_daily_cash`, `get_invoices`, `get_invoice`, `get_invoice_anomalies` |
| Housekeeping y lavandería | `get_housekeeping_status`, `set_housekeeping_done`, `assign_housekeeping_task`, `create_housekeeping_task`, `get_breakfast_summary`, `get_laundry_status` |
| Mantenimiento/piscina (solo dirección, lectura app externa) | `get_breakfast_inventory`, `get_breakfast_inventory_catalog`, `get_room_incidents`, `get_pool_supplies_level`, `get_pool_water_readings`, `get_water_tank_status` |
| Feedback y personal | `create_feedback_thread`, `list_feedback_threads`, `adjust_engagement_rating`, `get_staff_ai_activity`, `get_staff_list`, `get_online_users`, `send_staff_message`, `broadcast_staff_message` |
| Tareas programadas | `create_scheduled_task`, `list_scheduled_tasks`, `set_scheduled_task_active`, `delete_scheduled_task` |
| Alertas | `get_alert_configs`, `set_alert_enabled` |
| Control físico | `open_access_door` (ZKTeco, puertas 1-4, dirección) |
| UI/personalización | `navigate`, `set_dashboard_background`, `clear_dashboard_background`, `set_user_dashboard_background` |

(Verificado: las 84 tools de `TOOLS` en `src/routes/ai.ts` aparecen en la tabla; las "solo dirección" se bloquean en ejecución según `ctx.roles`.)

## 21. Integraciones

| Integración | Qué hace | Código |
|---|---|---|
| **Stripe** | Checkout, webhook firmado, pago de saldo/extras/ampliación | `lib/stripe.ts`, `routes/public.ts`, `customer.ts`, `room-access.ts` |
| **TTLock** (cloud EU `euapi.ttlock.com`) | Códigos de cerradura por reserva (14:00 o 09:00 con activación anticipada con comentario obligatorio), multi-habitación, tarjetas IC; regla "solo con saldo cero" salvo canales exentos configurables | `lib/ttlock.ts`, `routes/ttlock.ts` |
| **ZKTeco C3-400** (vía `bridge_win`, API REST en un PC Windows) | Control de accesos: abrir puertas 1-4, tarjetas, eventos, `enroller.exe` que enrola la tarjeta ligada al nº de reserva (auth `X-Enroller-Key`), revocación al check-out; alertas de tarjeta no enrolada/huésped sin acceso; re-enrolado en TTLock de la misma tarjeta | `lib/zkteco.ts`, `routes/zkteco.ts` |
| **Nobeds** (channel manager, `api.nobeds.com`) | Importar reservas, mapear tipos (`nobedsRoomId`), empujar disponibilidad y tarifas, bloquear/desbloquear fechas | `lib/nobeds.ts`, `routes/nobeds.ts` |
| **FDM / FrontDesk Master** (PMS anterior, `frontdeskmaster.com`) | Sincronización de reservas FDM → BD local (paginación hasta página incompleta) y push de precios a tarifas FDM 27 (Dir AL) y 28 (Dir HD); scripts de importación/enriquecimiento; cron externo `fdm-sync-cron.ts` | `lib/fdm-push.ts`, `routes/fdm.ts`, `scripts/fdm-*` |
| **Jumbo** (`contracts.jumbonline.com`) | Login por formulario (no hay API) y `setPrice`/`getContractsCalendar`; empuja precios de la tarifa JUMBO AL (derivada +31 %), disponibilidad = libres − colchón de 8, stop sales; push en segundo plano con estado consultable; tras cada pasada del motor de reglas; pago `jumbo_credit` | `lib/jumbo-push.ts`, `routes/jumbo.ts`, `jumbo_push_state` |
| **Google Places** | Autocompletado de dirección (proxy servidor) | `routes/public.ts` |
| **Google Ads / gtag** | Conversión de reserva en el motor web | `frontend-public/gtag.ts` |
| **SerpAPI** | Eventos locales (Google Events) en Benalmádena/Málaga, cacheado por día; scheduler 09:00 avisa a dirección de eventos de impacto alto/medio a 30 días | `lib/serpapi.ts`, `eventsScheduler.ts` |
| **Pexels** | Foto de fondo del panel por descripción de lugar (con atribución) | `lib/pexels.ts` |
| **Control de piscina / mantenimiento** (app Flask aparte, solo lectura, `X-API-Key`) | Incidencias, nivel de gas/cloro, cloro/pH, AFC/ACS (legionela), aljibe, inventario de desayunos, higiene, tareas completadas (para engagement) | `lib/poolControl.ts`, `externalStaffActivity.ts` |
| **Anthropic** | Agente (Haiku 4.5) y visión de DNI (Sonnet) | `routes/ai.ts`, `routes/id-scan.ts` |
| **RunPod / Ollama** | Backends alternativos del agente (por defecto no usados) | `routes/ai.ts` |
| **SES Hospedajes** | Partes de viajeros (ver §12) | `lib/ses.ts` |
| **Resend / WhatsApp Meta** | Ver §18 | `lib/email.ts`, `lib/whatsapp.ts` |
| **App Android "Betan"** | Voz con wake word | `routes/voice-brief.ts` |

## 22. Informes y paneles

- **Dashboard** (llegadas, salidas, en casa, ocupación hoy/semana, facturación del periodo) y **Resumen rápido de dirección** (`AdminQuickStats`) con chat de voz.
- **Informes** (pestañas): Ocupación (ocupación %, ingresos, ADR, RevPAR), Ventas por canal, Comisiones (editables por canal), Cancelaciones (+ detalle y recuperaciones), Lead time, Recepción (hora de check-in, pagos corregidos), Desayunos, Lavandería, Housekeeping por trabajador, Carritos abandonados, Efecto reglas, Empresas, Feedback, Uso QR habitaciones. Mapas geográficos (`GeoMaps`, d3-geo/topojson) en estadísticas de huéspedes.
- Exportación de listados (Reservas y Facturas) a **CSV con BOM UTF-8** (pagina hasta traer todas las filas; se abre con tildes correctas en Excel). **Corrección verificada:** no es `.xlsx`; la librería `xlsx` solo la usan scripts de importación.

---

## 23. Capacidades de un vistazo

| Módulo | Estado | Rol principal | Integración / dependencia | Notas |
|---|---|---|---|---|
| Reservas + planning + grupos + split | Producción | recepción, dirección | — | Historial completo, 8 estados |
| Habitaciones y tipos derivados | Producción | dirección | Nobeds (mapeo) | Tipos derivados y virtuales |
| Huéspedes | Producción | recepción | Google Places | Validación y nombres bloqueados |
| Motor de reservas web (7 idiomas) | Producción | público | Stripe, Google Ads | Webhook idempotente |
| Widget embebible de reserva y portal | Producción | público | nginx frame-ancestors | iframe |
| Portal del huésped (magic link, check-in, pago, extras, ampliación) | Producción | huésped | Stripe, Resend | Ampliación max 14 noches |
| QR de habitación | Producción | huésped | — | Token opaco, sesión corta, petición de limpieza |
| Tarifas derivadas + calendario de precios | Producción | dirección | — | Dir AL como raíz |
| Reglas de precio dinámico (8 tipos) | Producción | dirección | Jumbo/FDM push | Cada 30 min, una regla por fecha |
| Competidores | Producción | dirección | APIs de motores Paraty/Cloudbeds | Solo 2 plataformas |
| Recuperación carritos / canceladas / descuento temporal | Producción | dirección | Resend, WhatsApp | Cada 10 min |
| Facturación (facturas, proforma, abonos, auto-factura) | Producción | recepción, dirección | — | Sin VERIFACTU |
| Caja, transacciones, turnos, correcciones | Producción | recepción, dirección | Stripe | Rastro de auditoría |
| Caja de cambio | Producción | recepción | — | Arqueo por denominaciones |
| Housekeeping, zonas comunes, desayunos, lavandería | Producción | limpieza, cocina | — | Papel higiénico, valoración desayuno |
| SES Hospedajes | Producción | recepción | Ministerio del Interior | Envío manual |
| Escaneo de DNI con IA | Nuevo (sin commit) | recepción | Anthropic visión | Solo check-in hoy |
| Contratos y firma móvil | Producción | recepción, huésped | — | Sustituye a Wacom |
| Alertas (31 tipos) | Producción | dirección, recepción | varias | Cálculo en vivo + historial |
| Engagement del personal | Producción | dirección | App de mantenimiento | Heurística transparente |
| Feedback | Producción | todos | — | Hilos con IA y huésped |
| Mensajería email/WhatsApp | Producción | sistema | Resend, Meta | Canales configurables |
| Usuarios, roles, recuperación contraseña | Producción | dirección | Resend | 6 roles |
| Agente IA (84 tools, voz, tareas, briefing) | Producción | dirección y personal | Anthropic | Haiku 4.5, prompt caching |
| Android voice-brief | Producción | dirección | Anthropic, app APK | Token estático |
| Informe diario | Producción | dirección | Resend, cron externo | 23:00 |
| TTLock / ZKTeco | Producción | recepción | Cloud TTLock, bridge Windows | Requiere hardware |
| Nobeds / FDM / Jumbo | Producción | dirección | APIs de terceros | Jumbo por scraping de formulario |
| Piscina/mantenimiento | Producción (solo lectura) | dirección | App Flask externa | Datos para IA y alertas |

---

## 24. Limitaciones conocidas / deuda

**Producto / cumplimiento**
- **VERIFACTU/Facturae no implementados**: relevante para comercializar en España (obligatoriedad escalonada). Facturas sin hash encadenado ni QR; IVA único configurable (sin desglose por tipos, sin tasa turística en factura).
- **Multi-tenant ausente**: `PROPERTY_ID = 1` / `propertyId: 1` hardcodeado en ~22 ficheros de `src`; `properties` existe pero no hay aislamiento por inquilino ni selector de hotel; un despliegue = un hotel (BD, binario y `.env` propios).
- **Acoplamiento al hotel**: IDs de tarifa/tipo (tarifa "Dir AL", tipo "Doble" id 1, tarifa JUMBO AL id 8), ids FDM (propiedad 9713, rates 27/28, room uses), IDs y rate/room codes de Jumbo (con defaults en código), texto "Hotel Betania"/`hotelbetania.es` en email, contrato, mensajería, plantillas WhatsApp `betania_*`, las 8 zonas comunes y el umbral de alertas (horas fijas) están en código, no en configuración. `set_sale_price` del agente solo opera sobre una habitación concreta.
- Competidores: solo parsers `paraty` y `cloudbeds`.
- Integración Jumbo vía login por formulario y scraping de JS del portal: frágil ante cambios del proveedor. FDM y Nobeds acoplan a APIs/credenciales de terceros; FDM_CM_TOKEN o usuario/contraseña.
- ZKTeco depende de un PC Windows (`bridge_win`, `enroller.exe`) que no está en este repositorio; la app Android está en otro repo (`betania-apk`) y la app de mantenimiento/piscina (Flask) en otro (`control-piscina-betania`).

**Técnica**
- **Pocos tests**: solo 4 ficheros `bun test` en `src/lib` (motor de reglas, efectos de precio, detección corporativa, validación de texto); sin tests de rutas ni E2E (en `ideas.txt`: "falta el testing").
- Ficheros muy grandes: `ai.ts` (5.5k líneas), `reservations.ts` (2.3k), `public.ts` (1.7k), `alerts.ts` (1.5k), `catalog.ts` (1.3k) — difícil de mantener.
- Estado en memoria: rate-limit del magic link, cooldown de reset de contraseña, `lastProactiveCheckinDay`, cachés SerpAPI/tokens TTLock/FDM → se pierde al reiniciar y no escala a varias instancias.
- Schedulers dentro del propio proceso (`setInterval`), sin cola ni lock distribuido: con más de una réplica se ejecutarían duplicados. Cron externos (`daily-summary-cron`, `fdm-sync-cron`) viven fuera del repo/instalador.
- Tablas creadas solo por migración SQL y no modeladas en Drizzle: `breakfast_logs`, `engagement_adjustments`, `reservation_status_logs` (se consultan con SQL crudo).
- Tabla `notifications` sin emisores aparentes en el código actual (la API solo lista/marca leídas).
- Sin rate limiting general ni CAPTCHA en endpoints públicos (solo magic link); `cors()` abierto en `/api/*`.
- Nginx/README: el README de despliegue dice `root@…` pero `package.json` despliega con `direccion@…`; el script de backup apunta a `betania_test` con `KEEP_DAYS=3` aunque el comentario dice 14 días; no hay backups de `public/avatars` ni restauración documentada.
- Migraciones manuales por política del proyecto (nunca automáticas en el arranque); no hay rollback.
- El agente usa Haiku 4.5 (coste bajo, pero menor precisión) y el escáner de DNI `claude-sonnet-5` (más coste por escaneo); `AI_BACKEND` runpod/ollama están poco probados. Cambiar de modelo requiere tocar constantes (`CLAUDE_MODEL`, `VISION_MODEL`).
- Contratos: un único PDF/plantilla fijo; sin plantillas multi-idioma ni de facturas personalizables más allá del HTML de factura ("faltan plantillas de facturas" en `ideas.txt`).
- Pendientes anotados en `ideas.txt`: turnos y horarios, buzón de tareas, menú de incidencias de habitaciones, registros de inventario/higiene/piscina propios (hoy en app aparte), gestión documental, auto-facturación por canal de venta ampliada.

## 25. Controles de calidad y conciliación (hallazgos de alto valor)

Resultado de la auditoría de huecos (`features/EXTRAS-DESCUBIERTOS.md`): lo que diferencia a este PMS de uno genérico son los controles internos y las herramientas de cuadre.

**Controles de calidad y antifraude**
- **Puertas de calidad en el check-in:** se bloquea si hay contrato sin firmar, no hay depósito registrado, el huésped conserva el alias de Booking (`@guest.booking.com`) o falta municipio INE válido. Para saltarse tarjeta ZKTeco, parte SES o contrato hace falta un motivo de **mínimo 15 palabras** que queda como nota de la reserva. Nota: es control de proceso en el cliente; el backend no exige SES.
- **Check-out bloqueado con depósitos sin resolver** (efectivo o preautorización) y check-in que exige al menos un depósito activo. La exigencia está cableada en `reservations.ts`: `deposit_items.requiredForCheckIn` no se lee en ninguna parte.
- **Motivo obligatorio (≥5 palabras reales)** para cambiar de habitación a un huésped en casa o a un tipo virtual, o quitar extras; se valida en servidor, también cuando lo hace el agente, y queda en el historial.
- **Emails inventados:** bloqueo del alias temporal de Booking y detección de emails sospechosos; el recepcionista declara que el cliente se lo dio y queda registrado con nombre y hora.
- **Lista negra de huéspedes** con motivo y severidad (banner rojo al abrir la reserva); nombres bloqueados configurables; campos de reserva editables por rol y canal.
- **Reutilización automática de la tarjeta ZKTeco** en estancias consecutivas del mismo titular (por documento) y revocación sin borrado al hacer check-out o cancelar.
- **RGPD:** borrar un huésped lo anonimiza y conserva el historial contable; consentimiento de email por huésped.
- **Planning operativo:** arrastrar reservas con modal actual vs. nuevo (pide motivo si procede), menú contextual, selección de rango y edición en línea del precio Dir AL / Dir HD en la cabecera de ocupación.

**Conciliación y análisis**
- **Conciliación bancaria por día** (Facturación): se pegan los movimientos del banco (fecha + importe) y se compara por día con lo cobrado según el PMS, por caja o global, marcando diferencias mayores de 0,02 EUR.
- **Comparación de periodos A vs. B** con variación absoluta y porcentual por KPI (verde/rojo) y presets Hoy/Ayer/Semana/Mes/Personalizado.
- **Cobros con tarjeta conciliables con el TPV:** el pago exige el número de operación de la terminal o el flujo "Cobrado en otro turno"; recogidas de efectivo con rango de fecha-hora; depósitos cobrados no se borran (`resolvedAt/By`).
- **Auditoría de comisiones de OTA:** el informe calcula sobre `originalTotal` (sin extras ni ampliaciones) y usa la comisión real del canal cuando existe; un script compara el extracto de Booking con el 15 % de lo pagado.
- **Alertas con informe por empleado/turno**, tiempo de check-in por empleado y housekeeping con tiempo de respuesta medido.
- **Sincronización FDM/Jumbo/Nobeds:** push diferencial, autoasignación de habitación al importar de FDM (paginando hasta página incompleta, sin sobrescribir el total local) y scripts de comparación contra un backup restaurado para migrar sin perder datos.
- **Google Ads** con conversiones mejoradas y deduplicación; **portal del huésped también en 7 idiomas** (`i18n-portal.ts`, no solo el motor) y widget con protocolo `postMessage`.

**A medias o inexistente (no vender como cerrado):** ofertas corporativas (solo registro con estados; no se aplican al precio ni se envían), reembolsos Stripe (sin llamada a refund), tasa turística, VERIFACTU, anulación SES desde la UI, y `popupAt` de notas sin lector. Lista completa en EXTRAS-DESCUBIERTOS.
