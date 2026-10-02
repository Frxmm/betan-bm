# 03 · Desacoplamiento del Hotel Betania (property id)

> Documento de análisis. NO se ha modificado código. Fuente: grep sobre `src/`, `index.ts`, `scripts/`, `frontend/`, `frontend-public/`, `deploy/` del repo `betania-booking-manager` (rama `dubai`, 2026-10-02). Los números de línea son aproximados y se mueven con cada commit; re-ejecutar los greps de la sección 6 antes de trabajar.
> Complementa la tarea 0.1 de `~/Documents/betan-pms/PROMPTS.md` (inventario de acoplamientos) y la Fase 0 de `DOSSIER.md`.


> **ESTADO (2026-10-02): decisión tomada, pasamos a multi-tenant real (opción B). Las fases A y B se han FUSIONADAS en una sola.**
> Ya no se plantea "una instancia por cliente con `.env`": hay una instancia que sirve a N tenants (filas de `properties`),
> con el tenant resuelto por request (`src/lib/property.ts`, `src/middleware/tenant.ts`) y migración `0133_multitenant`.
> El inventario de abajo sigue siendo la lista de acoplamientos a eliminar; la arquitectura resultante, el onboarding y la
> operación están en **`04-MULTITENANT.md`**. Los comentarios de "Fase A" (`.env` por instancia, `FEATURES=` en ENV) quedan
> obsoletos: los módulos son `properties.features` y las credenciales `properties.settings.secrets.*`.
> El test de aislamiento (`bbm/tests/tenant-isolation.test.ts`) implementa el "test grep en CI" de la sección de verificación.

---

## 1. Resumen ejecutivo y estrategia

### Diagnóstico

El esquema de datos **ya es multi-propiedad** (40 de ~71 tablas llevan `property_id`, `properties` ya tiene `name, address, city, phone, email, vatNumber, logoUrl, currencyCode, timezone`). Lo que NO es multi-propiedad es el **código**: `propertyId = 1` está literal en unas **~190 ocurrencias** en `src/` y `index.ts` (más ~60 en `scripts/`), el JWT no lleva `propertyId`, no hay middleware que resuelva la propiedad, y los datos de empresa (CIF, dirección, teléfono, logo, dominio) están en strings dentro de plantillas de email, contrato y factura. Además hay integraciones y reglas de negocio (Jumbo, FDM, Dir AL, piscina, competidores, eventos Benalmádena) que son de Betania y están encendidas siempre.

Hay un segundo problema que no es de `property_id`: **12 tablas "singleton" sin `property_id`** que hoy son de facto configuración global (`message_settings`, `message_templates`, `alert_configs`, `cart_recovery_settings`, `cancellation_recovery_settings`, `temporary_discount_settings`, `reservation_field_rules`, etc.). Con instancia por cliente no importan; con multi-tenant real son bloqueantes (sección 4.7).

### Opciones

| | A. Una instancia por cliente, config por instancia | B. Multi-tenant real (property resuelta por request) |
|---|---|---|
| Qué es | Mismo binario, un VPS/BD/.env por hotel. `PROPERTY_ID` y datos del hotel salen de env + fila `properties`. | Una instancia, N hoteles. `property_id` sale del host/cabecera/JWT en cada request. |
| Cambio de código | Sustituir `1` por `getPropertyId()` (constante de proceso) + sacar literales a `properties`/settings + flags. Mecánico, bajo riesgo. | Lo anterior + middleware de resolución, contexto por request (AsyncLocalStorage), schedulers por propiedad, secretos por propiedad, auditar TODAS las queries, singletons con `property_id`, RLS opcional. |
| Aislamiento de datos | Total (BD separada). Cero riesgo de fuga. | Depende de que ninguna query olvide el filtro. Riesgo alto, hay que testearlo. |
| Coste marginal/cliente | 50-90 €/mes (VPS+Postgres) | 2-5 €/mes |
| Actualizar N clientes | Script que recorre instancias | Un solo despliegue |
| Encaja con | Venta de hoteles pequeños con implantación (Fase 1-2 del dossier) | Tier VUT/lite (Fase 4 del dossier) |
| Esfuerzo | ~8-12 días | +20-30 días sobre A |

### Recomendación: camino por fases

**Fase A0 · Preparar (1-2 días).** Congelar este inventario, crear `getPropertyId()` y `getPropertySettings()` como único punto de acceso (sin cambiar comportamiento: devuelven 1 / lo que hay hoy). Test de regresión "Betania sigue igual".

**Fase A1 · Instancia por cliente, bloqueantes (4-5 días).** Sustituir los `1` literales y `PROPERTY_ID` por `getPropertyId()` (env `PROPERTY_ID`, default 1); sacar a `properties`/`property_settings` nombre legal, CIF, dirección, teléfono, RTA, logo, dominio público, emails; parametrizar plantillas de email/contrato/factura, nombres de plantillas WhatsApp, nginx/CSP/CORS y gtag; seed de "hotel nuevo" sin datos Betania.

**Fase A2 · Feature flags e integraciones opcionales (2-3 días).** Tabla `property_features` (o JSON en settings); Jumbo, FDM, Nobeds, ZKTeco, piscina, competidores, eventos, voz/APK pasan a módulos opcionales; sacar de código IDs de FDM/Jumbo, nombres de cuentas/canales y la tarifa raíz.

**Fase A3 · Despliegue repetible (2 días).** Script de alta de instancia (nginx, certbot, BD, migraciones, seed, systemd), checklist de alta (sección 4.9), pruebas de regresión y de "hotel vacío".

> **Total A (recomendado para primeras ventas): ~9-12 días de trabajo efectivo.** Con esto se puede vender e implantar el piloto 1.

**Fase B · Multi-tenant real (cuando haya H4 del dossier, ~20-30 días adicionales).** Resolución por host, `AsyncLocalStorage`, `property_id` en singletons, secretos cifrados por propiedad, schedulers por propiedad, auditoría de queries + tests de aislamiento, (opcional) Row Level Security en Postgres. Si A se hace bien (todo pasa por `getPropertyId()`), B solo cambia la implementación de esa función de "constante de proceso" a "contexto de request".

Clave de diseño: **hacer A de forma que B sea un cambio de una sola función**, no un segundo refactor.

---

## 2. Inventario de acoplamientos

Leyenda de propuesta: **ENV** = variable de entorno · **COL** = columna en `properties` · **SET** = tabla/JSON `property_settings` · **FLAG** = feature flag por propiedad · **PARAM** = parámetro de función/ruta · **TPL** = plantilla parametrizada.

### 2.1 BLOQUEANTE (otro hotel no puede operar o saldrían datos de Betania)

#### 2.1.1 `propertyId` hardcodeado

**Constante `PROPERTY_ID = 1`** (declaraciones):

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/routes/public.ts` | 24 (51 usos del identificador) | `const PROPERTY_ID = 1` en todo el booking engine/portal/Stripe | PARAM: `getPropertyId()` (ENV `PROPERTY_ID` en fase A; por host en fase B) |
| `src/routes/laundry.ts` | 13 (6 usos) | idem | idem |
| `src/routes/reservations.ts` | 915 | `current.rate?.propertyId ?? 1` | usar `getPropertyId()` |
| `scripts/*` (10 ficheros) | `seed-sale-items`, `setup-rate-hierarchy`, `seed-financial-accounts`, `seed-rooms`, `fdm-import`, `fix-movimiento-caja`, `create-user`, `import-fdm-prices`... | `const PROPERTY_ID = 1` | PARAM CLI `--property` o ENV `PROPERTY_ID` |

**Literal `propertyId: 1` / `property_id = 1`** (conteo por fichero, grep `(propertyId|property_id)\W{1,6}1\b`):

| Archivo | Nº | Notas |
|---|---|---|
| `src/routes/financial.ts` | 20 | cuentas, métodos de pago, facturas, `invoice_settings`, cobros de caja |
| `src/routes/fdm.ts` | 17 | canales, tarifas, tipos habitación (también FDM, ver 2.1.4) |
| `src/routes/catalog.ts` | 12 | precios, temporadas, reglas, sale_items, SQL crudo `bb.property_id = 1` |
| `src/lib/pricingRulesEngine.ts` | 8 | motor de reglas; SQL crudo `r.property_id = 1` |
| `src/routes/reports.ts` | 8 | informes |
| `src/routes/ai.ts` | 6 | tool-calling del agente |
| `src/lib/invoicing.ts` | 5 | `invoice_settings`, factura automática |
| `src/lib/jumbo-push.ts` | 4 | estado de push Jumbo |
| `src/routes/room-access.ts` | 4 | QR habitación |
| `src/routes/reservations.ts` | 4 | alta de huésped y reserva |
| `src/lib/calendarOccupancy.ts` | 3 | SQL crudo (`WHERE property_id = 1`) |
| `src/lib/occupancyReport.ts` | 3 | |
| `src/lib/stayExtension.ts` | 3 | ampliación de estancia |
| `src/routes/customer.ts` | 3 | portal cliente |
| `src/routes/rooms.ts` | 3 | |
| `src/routes/housekeeping.ts`, `nobeds.ts`, `alerts.ts`, `notifications.ts` | 2 c/u | |
| `src/lib/cancellationRecovery.ts`, `roomAccess.ts`, `dirAlRate.ts` | 1 c/u | |
| `src/routes/guests.ts`, `users.ts`, `id-scan.ts`, `competitors.ts`, `corporate.ts`, `feedback.ts`, `zkteco.ts` | 1 c/u | |
| `src/lib/` + `src/routes/` TOTAL | **~190** (incl. PROPERTY_ID de public/laundry) | |
| `scripts/` (debug, seeds, compare, fdm-sync...) | ~60 | no bloquean producción, sí el alta de hotel (seeds) |

Propuesta general: **sustituir TODOS por `getPropertyId()`** en una sola pasada mecánica (con `bunx tsc --noEmit` + grep final `propertyId\W{1,6}1\b` = 0 como criterio de "hecho"). Para SQL crudo: parametrizar `${getPropertyId()}`.

**Dónde falta `propertyId` también (no es literal pero acopla):**

| Archivo | Qué es | Propuesta |
|---|---|---|
| `src/middleware/auth.ts` | JWT sin `propertyId`; `requireAuth` no fija propiedad | Fase A: no hace falta. Fase B: meter `propertyId` en el JWT y validar contra la resuelta por host |
| `src/routes/public.ts` (todo) | Público sin autenticación: la propiedad solo puede venir del host/cabecera | Fase B: middleware `resolveProperty` por `Host` |
| 12 tablas singleton (ver 2.1.9) | Configuración global sin `property_id` | Fase B: añadir columna |
| `index.ts` 171-177 | 7 schedulers que operan sobre "el hotel" | Fase B: iterar propiedades activas |

#### 2.1.2 Literales "Betania" / "hotelbetania" en emails y documentos (el huésped los ve)

| Archivo | Línea aprox | Qué es | Propuesta |
|---|---|---|---|
| `src/lib/messaging.ts` | 73-320 (27 ocurrencias) | Plantillas HTML de email: confirmación, check-in, código, saldo, carrito, reenganche, agradecimiento. Incluye logo `hotelbetania.es/assets/img/logo.png`, web, dirección, email, enlace Google Maps "Hotel+Betania+Benalmádena" | TPL: variables `{{hotelName}} {{hotelAddress}} {{hotelEmail}} {{hotelWeb}} {{logoUrl}} {{mapsUrl}}` desde `getPropertySettings()` |
| `src/lib/email.ts` | 6, 71-103 | `FROM` default `Hotel Betania <recepcion@hotelbetania.es>`; asunto "Resumen del día — Hotel Betania", "Recuperación de contraseña — Hotel Betania" | ENV `EMAIL_FROM` obligatorio (sin default) + `property.name` en asuntos |
| `src/routes/public.ts` | 26, 545, 687, 1114, 1164, 1222, 1259, 1349, 1672, 1688, 1710, 1720 | `FROM_EMAIL` default Betania; nombre de producto Stripe "Hotel Betania — Reserva..."; **línea 1688 `to: 'recepcion@hotelbetania.es'` hardcodeado** (aviso interno) | `property.name`, `property.email`; 1688 → `HOTEL_EMAIL`/`property.email` |
| `src/routes/customer.ts` | 19-20, 308 | `FROM_EMAIL` default Betania; **`HOTEL_EMAIL ?? 'recepcion@hotelbetania.es'`**; producto Stripe "Hotel Betania — Pago de reserva" | idem: sin default, `property.email` |
| `src/lib/cartRecovery.ts` / `cancellationRecovery.ts` | 17 / 26 | `FROM_EMAIL` default Betania | idem |
| `src/routes/reservations.ts` | 1580, 1613-1614, 1652 | Confirmación imprimible: nombre, dirección "C/ Carril de Contreras 12", email, web | TPL desde `property` |
| `src/lib/contract.ts` | 53, 72-78 | Contrato de admisión: `<title>`, logo, "HOTEL BETANIA — ADMISSION DOCUMENT", **razón social NEW ALAMOS INTERNACIONAL 2015 SL, CIF B-93439339, tel. 952577786, Nº RTA-H/MA/02015** | TPL: `legalName, vatNumber, address, phone, touristRegistryNumber, logoUrl` |
| `frontend/lib/invoicePrint.ts` | 27-41, 92 | Factura impresa: logo, "HOTEL BETANIA **", CIF B93439339, "Urbanización El Faro, Blq Betania", email, web, pie con razón social | Cargar de `GET /api/settings/property`; nada literal |
| `src/lib/invoicing.ts` | 76-77 | `JUMBO_BILLING` (JUMBONLINE ACCOMMODATIONS & SERVICES SL...) | FLAG Jumbo + SET `jumbo.billing` (ver 3) |

**Nota: el contrato PDF embebido** — `public/docs/contrato-admision.pdf` es un PDF estático con las condiciones de Betania, enlazado desde `contract.ts` (`/public/docs/contrato-admision.pdf`, líneas ~90-100). Propuesta: SET `contractPdfUrl` por propiedad (subida desde ajustes, o ruta `/public/docs/{slug}/contrato-admision.pdf`); si no existe, ocultar el enlace. El texto legal bilingüe del HTML (condiciones, derechos y obligaciones) también es de Betania → TPL editable (campo `admissionTermsHtml`).

#### 2.1.3 Plantillas WhatsApp `betania_*`

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/lib/whatsapp.ts` | 7-11 (comentarios) | Catálogo: `betania_checkin, _pago, _codigo, _carrito, _confirmacion` | Constante `waTemplate(key)` → `${property.slug}_${key}` o SET `whatsapp.templates` |
| `src/routes/whatsapp.ts` | 65, 100 | `betania_checkin`, `betania_pago` | idem |
| `src/routes/ttlock.ts` | 354 | `betania_codigo` | idem |
| `src/routes/public.ts` | 1062 | `betania_confirmacion` | idem |
| `src/routes/fdm.ts` | 751 | `betania_confirmacion` | idem |
| `src/lib/cartRecovery.ts` | 158 | `betania_carrito` | idem |
| `src/lib/cancellationRecovery.ts` | 164 | `betania_reenganche` (**no está en el catálogo de whatsapp.ts**) | idem; añadirlo al catálogo |
| `frontend/views/NotificationsView.tsx` | 204-208 | Lista visible de plantillas `betania_*` | Que la UI lea el catálogo del backend |
| `src/lib/whatsapp.ts` env | — | `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID` globales | secretos por propiedad (4.5) |

#### 2.1.4 FDM (Front Desk Master), `property 9713`

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/lib/fdm-push.ts` | 3-4 | `PROPERTY = 9713`, `CURRENCY_ID = 423`, `FDM_BASE` con subdominio `0t6ab-api-premium` propio de Betania | SET `fdm.{propertyId, currencyId, baseUrl, reportsUrl}` |
| `src/lib/fdm-push.ts` | 7-15 | `FDM_ROOM_USES` (4 Cuádruple, 5 Individual, 8 Doble) y `FDM_RATES` (27 → 'Dir AL', 28 → 'Dir HD') | SET `fdm.roomUses`, `fdm.rates` (o tabla de mapeo; ya existe `fdm_*` en pricing.ts:204) |
| `src/routes/fdm.ts` | 44 + 107, 397, 490, 772, 811 | `FDM_PROPERTY = 9713` en 5 URLs | idem |
| `src/routes/fdm.ts` | 31, 36 | cuenta 'Movimiento de caja' | seed/FLAG |
| `scripts/fdm-import.ts`, `fdm-enrich-guests*.ts`, `fdm-probe-guest.ts` | cabecera | `FDM_PROPERTY = 9713` (4+ scripts) | ENV/CLI; son herramientas de migración puntual |
| env `FDM_USERNAME/PASSWORD/CM_TOKEN` | — | credenciales globales | secretos por propiedad; todo el módulo tras FLAG `fdm` |

FDM es **específico de Betania** (era su PMS anterior). En otros hoteles solo sirve como *origen de migración* si usaban FDM.

#### 2.1.5 Nombres de cuentas, canales y tarifa raíz (strings mágicos)

| Archivo | Línea | Literal | Propuesta |
|---|---|---|---|
| `src/routes/public.ts` | 464-473, 1301-1310, 1700 | canal `'Web directa'` (busca por nombre, lo crea si no existe) | SET `bookingEngine.channelId` o `booking_channels.code='web_direct'` (columna `code` ya existe en reservations.ts:16) |
| `src/routes/public.ts` | 747, 803, 878, 1013, 1448 | cuenta `'Stripe online'` buscada por nombre en 5 sitios | SET `bookingEngine.stripeAccountId` o `financial_accounts.systemKey='stripe_online'` (columna nueva) |
| `src/db/seed.ts` | 113 | semilla de `'Stripe online'` | seed parametrizado por hotel |
| `src/routes/fdm.ts` | 31-36 | cuenta `'Movimiento de caja'` | systemKey |
| `src/routes/alerts.ts` | 24 (`EXEMPT_CHANNEL_NAMES = ['jumbo','agoda']`), 101 | canales exentos del aviso "reservas sin cobrar" por nombre | COL/SET `channels.exemptFromUnpaidAlert` (boolean en `booking_channels`) |
| `src/lib/dirAlRate.ts` | 21 | `rates.code = 'Dir AL'` | SET `pricing.rootRateId` (o `rates.isRoot`) |
| `src/routes/catalog.ts` | 461-510 | `rateCode === 'Dir AL'` dispara el motor | idem |
| `src/lib/pricingRulesEngine.ts` | 2, 484-795 (muchos), 795 | "tarifa raíz Dir AL", warning `tarifa "Dir AL" no encontrada` | idem: resolver la raíz desde SET |
| `src/lib/price-resolver.ts` | 72-176 | comentarios y lógica "JUMBO AL derivada de Dir AL" | revisar tras generalizar la raíz |
| `src/lib/fdm-push.ts` | 13-14 | `'Dir AL'`, `'Dir HD'` | ver FDM |
| `src/db/schema/enums.ts` | 37 | método de pago `jumbo_credit` en el enum Postgres | dejar (valor inocuo); ocultar en UI si no hay FLAG `jumbo` |
| `src/routes/ai.ts` | 496 y prompt | ejemplos de canal "Booking, Airbnb, Directo" | cosmético |

#### 2.1.6 Moneda

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/lib/invoicing.ts` | 155 | `reservation.currencyId ?? 1` | `getPropertyCurrencyId()` (de `properties.currencyCode` → `currencies.id`) |
| `src/routes/nobeds.ts` | 135 | `currencyId: 1` al importar reservas | idem |
| `src/lib/fdm-push.ts` | 4 | `CURRENCY_ID = 423` (id FDM de EUR) | SET fdm |
| `src/routes/financial.ts` | 379 | `getEurId()` (resuelve EUR por código, no por id: bien, pero fija EUR) | `property.currencyCode` |
| `frontend` / emails | varios | símbolo `€` literal (p.ej. `contract.ts:~88 "${total} €"`) | `Intl.NumberFormat(locale,{currency})` — IMPORTANTE solo si hay hoteles fuera de zona euro |

#### 2.1.7 Dominios, CORS, CSP, despliegue

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `deploy/nginx.conf` | 1-3, 49, 55-57, 103 | `server_name booking.hotelbetania.online`, `booking-test.hotelbetania.online` | plantilla `nginx.conf.tpl` con `{{BOOKING_DOMAIN}}`, generada por el script de alta |
| `deploy/nginx.conf` | 19, 73 | `Content-Security-Policy: frame-ancestors 'self' https://hotelbetania.es https://www.hotelbetania.es` (dónde se puede incrustar el widget) | `{{WEB_ORIGINS}}` (ENV/SET `property.websiteDomain`) |
| `deploy/nginx.conf` | 39-40, 93-94 | certificado `/etc/letsencrypt/live/hotelbetania.online/` | `certbot -d {{BOOKING_DOMAIN}}` por instancia |
| `deploy/betania-prod.service`, `betania-test.service` | todo | `WorkingDirectory=/srv/hotelbetania.online/bbm/prod`, `User`, `SyslogIdentifier=betania-prod`, binario `betania` | plantilla `{{slug}}-prod.service` |
| `deploy/setup-db.sql` | 5-20 | usuario `betania`, BD `betania_prod`/`betania_test` | plantilla con `{{slug}}` y contraseña generada |
| `deploy/README.md` | 11-48 | rutas y dominios Betania | reescribir como "alta de instancia" |
| `scripts/betania-db-backup.service` | — | backup nombrado Betania | plantilla |
| `index.ts` | 65 | `app.use('/api/*', cors())` **abierto a cualquier origen** | no es acoplamiento, es un riesgo: restringir a `PUBLIC_URL` + `websiteDomain` (SET) |
| `frontend-public/booking-widget.tsx`, `portal-widget.tsx`, `booking.tsx` | varios | `postMessage` con `type: 'betania-widget-*'` y `'betania-portal-*'`, enlaces `https://hotelbetania.es` (`target="_top"`) | prefijo neutro (`bm-widget-*`) + web del hotel desde `/api/public/config`; **ojo**: el JS de la web de Betania (WordPress) escucha esos tipos → mantener alias o migrar ambos lados a la vez |
| `src/lib/env.ts` | 5-30 | `PUBLIC_URL` ya es ENV (bien). No hay `PROPERTY_ID` ni `HOTEL_*` | añadir `PROPERTY_ID`, `HOTEL_SLUG`, `EMAIL_FROM` obligatorio |
| `frontend-public/gtag.ts` | 25 | `linker: { domains: ['hotelbetania.es','hotelbetania.online'] }` | dominios desde `/api/public/config` |
| `src/routes/public.ts` | 50-53 | `GOOGLE_ADS_ID/LABEL` ya por ENV (bien); servir también `websiteDomain`, nombre, logo | ampliar `/config` |

#### 2.1.8 Seeds y alta de hotel

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/db/seed.ts` | 38-55 | `name: 'Hotel Betania'`, `info@hotelbetania.es`, usuario `admin@hotelbetania.es` / apellido 'Betania' | seed lee `HOTEL_NAME`, `ADMIN_EMAIL`... o CLI interactivo |
| `src/db/seed.ts` | 113 y siguientes | cuentas financieras (Stripe online, etc.), rooms/tarifas de ejemplo | "seed mínimo" (moneda, cuentas base, canal Web directa, admin) vs "seed demo" |
| `scripts/seed-users.ts`, `seed-rooms.ts`, `seed-financial-accounts.ts`, `seed-sale-items.ts`, `setup-rate-hierarchy.ts`, `create-user.ts` | cabecera | `PROPERTY_ID=1` + datos reales de Betania (habitaciones, tipos, catálogo de desayuno...) | Convertir en plantillas JSON por hotel, o dejar solo `create-user` genérico |

#### 2.1.9 Tablas sin `property_id` (auditoría)

Resultado del escaneo de `src/db/schema/*.ts` (31 de 71 tablas sin la columna). Clasificación:

**Singletons de configuración (bloqueantes solo en multi-tenant; con instancia por cliente son correctos):**
`alert_configs`, `message_settings`, `message_templates`, `cart_recovery_settings`, `cancellation_recovery_settings`, `temporary_discount_settings`, `reservation_field_rules`.

**Hijas de tablas con `property_id` (aislamiento heredado por FK, seguras si la query padre filtra; riesgo si se consultan por id directo):**
`reservation_nights`, `reservation_notes`, `reservation_sale_items`, `payment_date_corrections`, `laundry_process_items`, `pricing_rule_applications`, `feedback_comments`, `competitor_prices`, `breakfast_service_ratings`, `breakfast_no_service`, `user_roles`, `user_preferences`, `alert_seen_marks`, `password_reset_tokens`.

**Tablas de contexto de cliente final, aisladas por token (necesitan revisar):**
`abandoned_carts`, `cancellation_recoveries`, `customer_tokens`, `booking_discount_timers` (sin `property_id`; en multi-tenant mezclarían huéspedes de hoteles distintos con el mismo email), `ai_chat_messages`, `ai_scheduled_tasks`, `staff_messages` (por `user_id`, ok si el usuario ya está atado a propiedad).

**Catálogos globales (correctas sin `property_id`):** `properties`, `currencies`, `countries`.

Además: `users.email` es `UNIQUE` global (`core.ts`): en multi-tenant el mismo email no puede existir en dos hoteles → decidir si es único por propiedad.

### 2.2 IMPORTANTE (funciona, pero el hotel nuevo ve/pierde cosas de Betania o falla un módulo)

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/lib/jumbo-push.ts` | 15 `JUMBO_AVAILABILITY_BUFFER = 8`; 20-30 `BASE`, `BUILDING_ID '7783'`, `HANDLER_ID '6'`, `PC_ID '988538'`, `RATE_IDS 'BAR:M00,...'`, `ROOM_IDS 'RX8,8QOI,SGL'`, `BOARD_IDS 'RO,BB'` | **Defaults reales de Betania en Jumbo** (ya son ENV, pero el default es Betania) | quitar defaults; SET `jumbo.*`; buffer = SET |
| `src/routes/jumbo.ts`, `src/lib/invoicing.ts` 76-155 | — | rutas Jumbo + facturación a JUMBONLINE (razón social y CIF de Jumbo en código) | FLAG `jumbo` |
| `src/lib/competitorPricing.ts` | 46, 78 | User-Agent `BetaniaPriceCheck/1.0`; hoteles competidores van en BD (`competitor_hotels`, bien) | UA neutro. Datos: ver 3 |
| `src/lib/serpapi.ts` | ~46 | búsqueda `'eventos Benalmádena'` hardcodeada | SET `events.locationQueries[]` |
| `src/lib/eventsScheduler.ts` | 1, 79 | "eventos locales en Benalmádena/Málaga", 09:00 Madrid | SET `events.*` + FLAG `events` |
| `src/routes/ai.ts` | 237, 340 y bloques de prompt (~270-340, 1433-1467) | Prompt de sistema: "Te llamas Betan", "asistente del Hotel Betania", eventos "Benalmádena y Málaga", piscina/mantenimiento, `get_breakfast_inventory`, `get_water_tank_status` | prompt generado con `property.name/city` + secciones condicionadas por FLAG (`pool`, `events`, `competitors`) |
| `src/lib/poolControl.ts`, `src/lib/externalStaffActivity.ts`, `src/routes/engagement.ts` | 1-3, 2, 65-95 | Integración con app Flask externa de piscina/personal `personal.hotelbetania.online` (`POOL_API_URL/KEY`) | FLAG `pool`; ENV ya existe |
| `src/lib/env.ts`, `src/routes/voice-brief.ts` | 13, 2 | App Android wake word "Betania" (`/home/bob/Documents/betania-apk`), `VOICE_APP_TOKEN` | FLAG `voice`; wake word configurable (en la APK, no aquí) |
| `src/lib/ses.ts` | 19, 262 | `SES_APLICACION` default `'Betania PMS'`; credenciales SES por ENV | default = nombre del producto; secretos por propiedad (SES es **por establecimiento**: código establecimiento/arrendador distinto en cada hotel) |
| `src/lib/zkteco.ts`, `src/routes/zkteco.ts` | 52, 161 | Bridge ZKTeco local (C3-400) de Betania: `ZKTECO_BRIDGE_URL/KEY`, `ZKTECO_ENROLLER_SECRET` | FLAG `zkteco` |
| `src/lib/ttlock.ts`, `src/routes/ttlock.ts` | — | Cuenta TTLock global (`TTLOCK_USERNAME/PASSWORD/CLIENT_ID/SECRET`) | secretos por propiedad; FLAG `ttlock` (dossier: cuenta TTLock del cliente) |
| `src/lib/nobeds.ts`, `src/routes/nobeds.ts` | — | `NOBEDS_API_TOKEN` global; mapeo de tarifas | secretos por propiedad; FLAG `nobeds` |
| `frontend/contexts/PropertyContext.tsx` | 17-24 | `DEFAULT_PROPERTY = { id: 1, name: 'Hotel Betania', slug: 'betania', ...}` y nunca se actualiza desde el backend | cargar de `GET /api/settings/property` al login; sin default Betania. `property.id` en frontend no debe usarse para consultas |
| `frontend/views/NotificationsView.tsx` | 204-208 | plantillas `betania_*` | catálogo desde backend |
| `frontend-public/i18n.ts` | 3, 35, 85-289 (9 ocurrencias) | `pageSub: 'Hotel Betania · Benalmádena Costa, Málaga'` en cada idioma (es, en, fr, de, it, uk, zh...); mensaje `betania-widget-lang` | interpolar `{{hotelName}} · {{city}}` desde `/config` |
| `frontend-public/i18n-portal.ts` | 14 ocurrencias | idem (bienvenida, textos de portal) | idem |
| `frontend-public/contract.tsx`, `contract.html`, `portal.html`, `portal-widget.html`, `room.html`, `booking.html`, `booking-widget.html`, `portal.tsx`, `room.tsx`, `booking.tsx` | `<title>`, `pub-logo` "Hotel <span>Betania</span>" | Títulos y logotipo textual | `document.title` y logo desde `/config` (los `<title>` estáticos del HTML cambiarlos a genérico) |
| `frontend/index.html`, `SettingsView.tsx` | 10 / 36 | clave `localStorage 'betania-prefs'` | cosmético si hay un solo hotel por dominio; renombrar con migración de la clave |
| `src/routes/public.ts` | 1688 | email interno `recepcion@hotelbetania.es` fijo | `property.email` |
| `deploy/*` y `scripts/*` | — | ver 2.1.7 | plantillas |

### 2.3 COSMÉTICO

| Archivo | Línea | Qué es | Propuesta |
|---|---|---|---|
| `src/db/schema/core.ts` | 26 | comentario con "Betania" en `blockedGuestNames` (el valor por defecto es `[]`, bien) | ninguna |
| `src/routes/guests.ts`, `frontend/views/ReservationsView.tsx` | 32 / 190 | comentario/texto "Recepción", "Hotel" o "Betania" como nombres bloqueados | texto genérico |
| claves `sessionStorage/localStorage`: `betania_customer_token`, `betania_customer_email`, `betania_pending_booking`, `betania_discount_timer`, `betania_room_session_*`, `betania-conv-*` (`portal.tsx`, `portal-widget.tsx`, `booking*.tsx`, `room.tsx`, `gtag.ts`) | varios | Prefijos con "betania" | prefijo neutro `bm_`; cambia la sesión de los usuarios actuales una vez |
| `src/lib/competitorPricing.ts` | 46, 78 | User-Agent | `BetanBM/1.0` |
| `src/lib/pricingRulesEngine.ts`, `src/lib/*` | varios | `'Europe/Madrid'` hardcodeado (~12 sitios: pricingRulesEngine 154, 203, 831-836; jumbo-push 75; serpapi 30; eventsScheduler 62; contract 42; pricingEffects 45; externalStaffActivity 97) aunque `properties.timezone` existe | helper `propertyTimezone()`; IMPORTANTE solo para hoteles fuera de España/Canarias |
| `src/lib/ses.ts` | todo | SES (Hospedajes) es un requisito **legal español**; para hoteles fuera de España debe ser FLAG `ses` | FLAG |
| comentarios `// .../home/bob/Documents/betania-apk`, `~/Desktop/hotelbetania-online` | `env.ts`, `poolControl.ts` | rutas locales en comentarios | limpiar |
| `src/lib/postal-es.json` | — | códigos postales de España | solo ES; si se vende fuera, pluggable |
| `src/routes/ai.ts` | 237 | nombre del asistente "Betan" | SET `ai.assistantName` (opcional) |
| `package.json`, binario `dist/betania`, `src/routes/betania-booking-manager.code-workspace` (aparece suelto en `src/routes/`, no debería estar ahí) | — | nombre de proyecto/binario | renombrar a `betan-bm` al final |

---

## 3. Integraciones específicas de Betania = módulos opcionales (feature flags por propiedad)

Regla: cada módulo declara `featureKey`, sus secretos y sus ajustes. Con el flag apagado: la ruta responde 404/403, el scheduler no arranca, la tool de IA no se registra, el menú no aparece y los textos del prompt desaparecen.

| featureKey | Módulo / ficheros | Por qué es de Betania | Secretos/ajustes por propiedad | Default hotel nuevo |
|---|---|---|---|---|
| `jumbo` | `lib/jumbo-push.ts`, `routes/jumbo.ts`, `invoicing.ts` (JUMBO_BILLING), `enums.jumbo_credit`, `alerts.ts` exención | Contrato de venta con JUMBONLINE: IDs 7783/6/988538, buffer 8, razón social de Jumbo (la razón social de Jumbo es la misma para todos, el resto no) | `JUMBO_LOGIN/PASSWORD`, buildingId, handlerId, pcId, rate/room/board ids, buffer | OFF |
| `fdm` | `lib/fdm-push.ts`, `routes/fdm.ts`, scripts `fdm-*`, canal/cuenta 'Movimiento de caja' | PMS anterior de Betania (property 9713, subdominio API propio, ids 27/28, 4/5/8) | credenciales, `propertyId`, `currencyId`, mapeos | OFF (ON solo si el cliente migra desde FDM) |
| `nobeds` | `lib/nobeds.ts`, `routes/nobeds.ts` | Channel manager que usa Betania; otros pueden usar otro (SiteMinder, Cloudbeds...). Dossier lo lista como "Nobeds del cliente" | `NOBEDS_API_TOKEN`, mapeo tarifas | OFF (módulo "channel manager" genérico en el futuro) |
| `zkteco` | `lib/zkteco.ts`, `routes/zkteco.ts`, tarjetas BE | Bridge local C3-400 instalado en Betania | `ZKTECO_BRIDGE_URL/KEY/ENROLLER_SECRET` | OFF |
| `ttlock` | `lib/ttlock.ts`, `routes/ttlock.ts`, `room-access` | Producto diferencial del dossier: ON para quien lo contrate, con SU cuenta TTLock | `TTLOCK_*` | OFF (ON en paquete cerraduras) |
| `pool` | `lib/poolControl.ts`, `lib/externalStaffActivity.ts`, `routes/engagement.ts` (partes), tools IA de desayuno/depósitos | App Flask externa propia (`personal.hotelbetania.online`) | `POOL_API_URL/KEY` | OFF |
| `competitors` | `lib/competitorPricing.ts`, `serpapi.ts`, `routes/competitors.ts`, reglas de precio que usan competidores | Los hoteles rivales son datos (BD) pero SerpApi es de pago y la lista es de Benalmádena | `SERPAPI_API_KEY`, lista `competitor_hotels` | OFF |
| `events` | `lib/eventsScheduler.ts`, `serpapi.ts` (`search_local_events`) | Query fija "eventos Benalmádena/Málaga" | consulta/ciudad por propiedad | OFF |
| `pricing_rules` | `lib/pricingRulesEngine.ts`, `dirAlRate.ts`, `catalog.ts` reglas | Motor de reglas dinámicas sobre una tarifa raíz "Dir AL"; reglas con horas fijas (20:00 Madrid) | `pricing.rootRateId`, horarios | OFF hasta que el hotel tenga tarifa raíz definida |
| `ses` | `lib/ses.ts`, `routes/ses.ts` | Registro de viajeros España (Hospedajes) | `SES_*` por establecimiento | ON en España, OFF fuera |
| `voice` | `routes/voice-brief.ts`, APK wake word "Betania" | App nativa propia | `VOICE_APP_TOKEN`, `VOICE_APP_USER_ID` | OFF |
| `ai_agent` | `routes/ai.ts`, `lib/email.ts` resumen diario, `ai_scheduled_tasks` | Coste por uso (Anthropic/RunPod) y prompt con Betania | `ANTHROPIC_API_KEY` o compartida; nombre del asistente | OFF/opcional (ver con el dossier si el agente IA es parte del paquete) |
| `whatsapp` | `lib/whatsapp.ts`, `routes/whatsapp.ts`, recuperaciones | Cuenta Meta/WABA por hotel y plantillas aprobadas por hotel | `WHATSAPP_TOKEN/PHONE_ID`, prefijo de plantillas | OFF hasta tener plantillas aprobadas |
| `cart_recovery` / `cancellation_recovery` | `cartRecovery.ts`, `cancellationRecovery.ts` | Dependen de `whatsapp`/email y de plantillas | dentro de sus tablas `*_settings` | ON si hay email |
| `laundry`, `housekeeping_common_areas`, `cashdrawer`, `corporate` | rutas varias | Funciones operativas de Betania; no son integraciones pero no todos las querrán | — | ON/OFF por plan |
| `stripe` | `lib/stripe.ts`, webhook | Cuenta Stripe del cliente (no la tuya) | `STRIPE_SECRET_KEY/PUBLIC/WEBHOOK_SECRET` | ON |

Mínimo viable fase A2: `jumbo, fdm, nobeds, zkteco, pool, competitors, events, voice, pricing_rules`. El resto puede esperar.

---

## 4. Diseño propuesto (sin implementar)

### 4.1 Columnas nuevas en `properties` (identidad y datos fiscales)

`properties` ya tiene `name, address, city, countryCode, phone, email, vatNumber, logoUrl, currencyCode, timezone`. **No duplicar** (la tarea 0.2 del dossier sugería `cif`/`phone`/`logoUrl`: ya existen como `vatNumber`/`phone`/`logoUrl`; reutilizar).

Añadir:

| Columna | Tipo | Uso |
|---|---|---|
| `slug` | text unique not null | `betania`; prefijo de plantillas WhatsApp, nombre de binario, claves de storage |
| `legal_name` | text | "NEW ALAMOS INTERNACIONAL 2015 SL" (contrato, factura) |
| `tourist_registry_number` | text | "RTA-H/MA/02015" |
| `postal_code`, `region` | text | dirección completa en factura/contrato |
| `website_url` | text | `https://hotelbetania.es` (enlaces "volver", CSP `frame-ancestors`, gtag linker) |
| `public_domain` | text | `booking.hotelbetania.online` (resolución por host en fase B; nginx) |
| `reception_email`, `from_email` | text | `recepcion@...`, remitente de emails |
| `maps_url` | text | enlace de reseña/mapa en email "gracias por tu estancia" |
| `locale_default` | text | `es` (idioma por defecto del portal) |
| `star_label` | text | "**" de la cabecera de factura |
| `admission_terms_html`, `admission_pdf_url` | text | contrato de admisión y su PDF |

### 4.2 Tabla `property_settings` (clave/valor tipado) y `property_features`

```
property_settings(property_id, key text, value jsonb, updated_at, updated_by, PRIMARY KEY (property_id, key))
property_features(property_id, feature_key text, enabled bool, config jsonb, PRIMARY KEY (property_id, feature_key))
```

Claves previstas: `bookingEngine.channelId`, `bookingEngine.stripeAccountId`, `pricing.rootRateId`, `pricing.rootRateCode`, `jumbo.*`, `fdm.*`, `whatsapp.templatePrefix`, `whatsapp.templates`, `events.queries`, `ai.assistantName`, `channels.exemptFromUnpaidAlert`. Las que dependen de ids de otras tablas: usar siempre ids, nunca nombres.

Tras esto, migrar los 7 singletons (`message_settings`, etc.) a `property_id` (fase B) o dejarlos y envolverlos en `property_settings` (fase A, sin tocar).

Ya existe en `properties` configuración operativa (`defaultCalendar*`, `ttlockCardEnrollEnabled`, `blockedGuestNames`, `ttlockBalanceExemptChannelIds`): es el patrón actual de "columna por ajuste". Para no inflar `properties`, a partir de ahora ajustes nuevos → `property_settings`.

### 4.3 Resolución de propiedad

**Fase A (instancia por cliente):** `env.PROPERTY_ID` (zod, `z.coerce.number().default(1)`), validado al arrancar contra `properties` (si no existe → abort). `getPropertyId()` lee de ahí. Cache en memoria de `getPropertySettings()` con invalidación al editar ajustes.

**Fase B (multi-tenant):** orden de resolución en un middleware único `resolveProperty` montado antes de todo:
1. Públicas (`/api/public/*`, portal, widget, QR de habitación): por `Host` (tabla `property_domains(host → property_id)`); el QR de habitación ya lleva `qrToken` → propiedad por token. Cabecera `X-Property` solo si viene de widget embebido en la web del hotel y se valida contra `websiteDomain`/CORS.
2. Autenticadas: `propertyId` del JWT (añadirlo al firmar en `routes/auth.ts`); si la request además trae host de otra propiedad → 403.
3. Webhooks (Stripe, WhatsApp, Nobeds): por `metadata.property_id` del evento o por ruta `/webhooks/:slug/stripe`.
4. Schedulers: iterar `properties` activas con `featureEnabled`.

Contexto por request con `AsyncLocalStorage<{ propertyId, settings }>`: `getPropertyId()` lee del store, así las ~190 llamadas no cambian de firma. **Fuera de request/scheduler lanza error** (nunca devolver 1 por defecto en modo multi-tenant).

### 4.4 `getPropertyId()` como única puerta (cambio mecánico de A1)

- `src/lib/property.ts` (nuevo, futuro): `getPropertyId()`, `getProperty()`, `getPropertySettings(key)`, `hasFeature(key)`, `getSecret(key)`.
- Regla de lint/CI: grep prohibido `propertyId\W{1,6}1\b|property_id\s*=\s*1|PROPERTY_ID\s*=` en `src/`; test que falle si reaparece.
- SQL crudo: `sql\`... property_id = ${getPropertyId()}\``.
- Cuidado con la regla del proyecto: en `sql` de drizzle, no interpolar columnas en subconsultas; sí valen parámetros.

### 4.5 Secretos por propiedad

Hoy todo en `.env` global (`STRIPE_*`, `RESEND_API_KEY`, `WHATSAPP_*`, `TTLOCK_*`, `SES_*`, `NOBEDS_*`, `FDM_*`, `JUMBO_*`, `ZKTECO_*`, `POOL_*`, `GOOGLE_ADS_*`, `ANTHROPIC_API_KEY`...). 
- **Fase A:** un `.env` por instancia (ya funciona; el módulo se activa si la variable existe). Añadir `FEATURES=jumbo,ttlock,...` en ENV como alternativa mínima a `property_features`.
- **Fase B:** tabla `property_secrets(property_id, key, value_encrypted, key_version)` cifrada con una `MASTER_KEY` en ENV (AES-GCM); `getSecret(key)` con fallback a ENV solo en modo single-tenant; nunca loguear ni devolver al frontend. Los webhooks necesitan resolver la propiedad *antes* de verificar la firma.
- Compartidas legítimas (no por hotel): `RESEND_API_KEY` (si el remitente es del producto), `ANTHROPIC_API_KEY`, `SERPAPI_API_KEY`, `PEXELS_API_KEY`, `GOOGLE_PLACES_API_KEY`: decidir quién paga (coste en el precio).

### 4.6 Plantillas WhatsApp `{slug}_*`

- Función `waTemplateName(key)` → `${slug}_${key}` (`checkin, pago, codigo, carrito, confirmacion, reenganche`). Un catálogo único en `whatsapp.ts` del que lean backend y `NotificationsView`.
- Meta exige una WABA y plantillas aprobadas por cliente: incluir en el checklist 2-4 días de espera de aprobación; el flag `whatsapp` no se enciende hasta que las 6 estén aprobadas.
- Betania mantiene su prefijo `betania_*` (slug `betania`), cero migración en Meta.
- Alternativa: nombres genéricos (`bm_checkin`) con variables `{{hotel}}` — requiere re-aprobar para Betania; no recomendado.

### 4.7 Plan de migración de datos (instancia Betania actual)

Todo SQL lo escribe el agente y **lo aplica el usuario manualmente**.
1. Migración `ALTER TABLE properties ADD COLUMN IF NOT EXISTS ...` (4.1) + `CREATE TABLE property_settings, property_features`.
2. Script de backfill idempotente para Betania: rellenar `slug='betania'`, `legal_name`, `vat_number='B93439339'`, `tourist_registry_number`, `website_url`, `public_domain`, `reception_email`, `maps_url`, etc. con los literales de 2.1.2.
3. Backfill de settings: `pricing.rootRateId` = id de la tarifa con code 'Dir AL'; `bookingEngine.channelId` = id del canal 'Web directa'; `bookingEngine.stripeAccountId` = id de 'Stripe online'; `fdm.*` = 9713/423/27,28/4,5,8; `jumbo.*` = valores actuales.
4. `property_features` de Betania: todo ON (comportamiento actual idéntico).
5. Añadir `financial_accounts.system_key` y `booking_channels.exempt_from_unpaid_alert` (o setting equivalente) y rellenar.
6. Fase B: `ALTER TABLE ... ADD COLUMN property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id)` en los singletons y 4 tablas de cliente final; `DEFAULT 1` se quita después; índices `(property_id, ...)`.
7. Desplegar con código "dual": primero leer de settings con fallback al literal actual; cuando Betania verifique, borrar fallbacks (rollback trivial).

### 4.8 Auditoría de aislamiento (riesgos multi-tenant)

**Riesgos principales:**
1. **Query sin filtro por propiedad** — ~190 sitios con `1` literal hoy "filtran por casualidad". En multi-tenant, cada `findFirst`/`update`/`delete` por `id` sin `AND property_id` permite acceso cruzado (IDOR entre hoteles). Hay muchos `where(eq(x.id, id))` sin propiedad (p.ej. `financial.ts` solo la mezcla en algunos, como 174/188). Auditoría necesaria: todas las rutas `:id`.
2. **Tablas sin `property_id`** (2.1.9): 7 singletons + 4 de cliente final + hijas. Mitigación: columna en singletons; hijas siempre por JOIN al padre.
3. **Unicidad global**: `users.email` UNIQUE, `customer_tokens` por email, `guests` por documento; revisar `unique()` que omiten `property_id` (el patrón correcto aparece p.ej. en `pricing.ts:210`).
4. **Schedulers** (`index.ts` 171-177) asumen un hotel: bucles por propiedad, con aislamiento de errores (un hotel que falla no para a los otros).
5. **Caches en memoria** de settings/resolución (token FDM, JWT TTLock...) a nivel módulo: clave por propiedad.
6. **Logs y IA**: el agente (`ai.ts`) recibe tools con datos de una propiedad; las tools no deben aceptar `propertyId` del modelo. Prompt injection no debe poder cruzar propiedades.
7. **CORS abierto** (`index.ts:65`) y rate limiting inexistente en públicas (ya en dossier).
8. **Backups/RGPD**: en multi-tenant, restaurar un hotel exige export por `property_id`; contrato de encargado del tratamiento (dossier).
9. **Sesiones**: `auth_token` en cookie sin `Domain` por propiedad; con subdominios compartidos el JWT debe llevar `propertyId`.
Mitigaciones: (a) helpers `byProperty(table)` que añaden siempre el filtro, (b) test automatizado que recorre todas las rutas con dos propiedades en BD y comprueba que A no ve datos de B, (c) opcional RLS de Postgres con `SET app.property_id`, (d) la fase A (BD por cliente) elimina 1-9 hasta que se decida B.

### 4.9 Checklist de alta de hotel nuevo (fase A, objetivo < 1 hora técnica + esperas externas)

1. Dominio/subdominio del motor (`{{BOOKING_DOMAIN}}`) y DNS; dominio web del cliente (para CSP).
2. VPS + Postgres (plantilla `setup-db.sql` con `{{slug}}`), usuario/BD, backups con copia externa.
3. Variables `.env`: `DATABASE_URL, JWT_SECRET, PUBLIC_URL, PROPERTY_ID, EMAIL_FROM, HOTEL_EMAIL, FEATURES`, Stripe (cuenta del cliente + webhook), Resend/SES-email, etc.
4. Ejecutar migraciones (manual) + `seed:hotel` (propiedad con slug, fiscal, moneda, timezone; cuentas base; canal Web directa; admin).
5. Datos del establecimiento en Ajustes (nombre legal, CIF, RTA, logo, dirección, emails, web, mapas, PDF de contrato).
6. Habitaciones, tipos, tarifas (cadena de derivación), tarifa raíz (`pricing.rootRateId`), temporadas.
7. Cuentas financieras y métodos de pago; serie de facturas (`invoice_settings`).
8. nginx + certbot + systemd desde plantilla; `frame-ancestors` con la web del cliente.
9. Módulos: SES (credenciales del cliente), TTLock (cuenta del cliente), WhatsApp (WABA + 6 plantillas `{slug}_*` aprobadas), Nobeds, Google Ads/gtag, otros según contrato.
10. Embeber el widget en la web del cliente (script con `postMessage` neutro).
11. Prueba extremo a extremo: reserva web → Stripe test → email → check-in → contrato → código/WhatsApp → factura.
12. Formación a recepción, 2 semanas de acompañamiento, monitorización y alertas.

### 4.10 Tests de regresión (para no romper Betania)

- **Snapshot "Betania igual"**: antes de empezar, capturar con la BD actual: HTML de los 7 emails (`messaging.ts`), contrato, confirmación imprimible, factura impresa, `/api/public/config`, prompt de sistema del agente. Tras el refactor, con la config de Betania, deben ser idénticos (diff = 0).
- **Test grep en CI**: cero `propertyId: 1`, `property_id = 1`, `PROPERTY_ID =`, `9713`, `B-?93439339`, `hotelbetania`, `'Stripe online'`, `'Web directa'`, `'Dir AL'`, `betania_` fuera de `seed betania` y fixtures.
- **Test "hotel vacío"**: BD nueva, `PROPERTY_ID=2`, sin ningún flag → arranca; ninguna ruta/scheduler de módulos opcionales; ningún string "Betania" en las respuestas (grep sobre respuestas de `/api/public/*` y emails renderizados).
- **Test de dos propiedades (fase B)**: A y B en la misma BD, recorrer todas las rutas con el token de A y comprobar que no aparece ningún id de B (incluido acceso por `:id` ajeno).
- Tests existentes a mantener verdes: `pricingRulesEngine.test.ts`, `pricingEffects.test.ts`, `corporateDetection.test.ts`, `textValidation.test.ts` (parametrizar `propertyId` en fixtures).
- `bunx tsc --noEmit` sin errores nuevos (hay ~10 preexistentes).

---

## 5. Esfuerzo estimado (días de trabajo efectivo)

| Fase | Contenido | Días |
|---|---|---|
| A0 | `property.ts`, snapshots de regresión, congelar inventario | 1-2 |
| A1 | Sustitución mecánica de `1` (~190+60), datos de empresa a `properties`, emails/contrato/factura, WhatsApp prefijo, nginx/CSP/CORS/gtag, `PropertyContext`, i18n/portal, seeds neutros | 4-5 |
| A2 | `property_features` + 9 flags mínimos, IDs Jumbo/FDM fuera de código, cuentas/canales/raíz por id, prompt IA condicionado | 2-3 |
| A3 | Plantillas de despliegue, script de alta, checklist, test "hotel vacío" | 2 |
| **Total A** | | **~9-12** |
| B | Resolución por host/JWT, `AsyncLocalStorage`, schedulers por propiedad, singletons con `property_id`, secretos cifrados, auditoría de queries y tests de aislamiento, (RLS) | +20-30 |

---

## 6. Comandos para reproducir el inventario

```bash
cd ~/Documents/betania-booking-manager
# propertyId literal
grep -rcE "(propertyId|property_id)[^a-zA-Z]{1,6}1\b" src index.ts scripts | grep -v ':0$'
grep -rnE "(const|let) +PROPERTY_ID\b *=" src scripts
# Betania / dominio
grep -rniE "betania|hotelbetania" src index.ts frontend frontend-public deploy scripts --include=*.ts --include=*.tsx --include=*.html --include=*.conf --include=*.service
# fiscal / FDM / strings mágicos
grep -rnE "B-?93439339|Carril de Contreras|952577786|9713|Stripe online|Web directa|Dir AL|betania_" src frontend frontend-public scripts
# tablas sin property_id: script python sobre src/db/schema/*.ts (ver sección 2.1.9)
```

---

## 7. Resumen de 10 líneas

1. El esquema ya es multi-propiedad (40/71 tablas con `property_id`); el código no: ~190 `propertyId: 1`/`PROPERTY_ID` en `src/` (+~60 en `scripts/`), JWT y middleware sin propiedad.
2. Los datos del hotel (razón social, CIF B-93439339, dirección, tel., RTA, logo, web, emails) están incrustados en `messaging.ts`, `email.ts`, `contract.ts`, `reservations.ts`, `public.ts` y `invoicePrint.ts`; `properties` ya tiene casi todas las columnas, faltan `slug, legal_name, RTA, website, domain`.
3. Strings mágicos por nombre ('Stripe online' x5, 'Web directa' x2, 'Dir AL' en motor de precios, canales 'jumbo'/'agoda' en alertas) deben pasar a ids/claves de sistema en settings.
4. Integraciones propias de Betania a convertir en módulos con flag: Jumbo (IDs 7783/6/988538), FDM (property 9713, ids 27/28), Nobeds, ZKTeco, piscina, competidores, eventos Benalmádena, voz/APK, reglas Dir AL.
5. WhatsApp: 6 plantillas `betania_*` (incl. `betania_reenganche`, fuera del catálogo) → `{slug}_*`, y WABA por cliente (días de espera de Meta).
6. Deploy: nginx/CSP/certbot/systemd/setup-db atados a `hotelbetania.online/.es`; CORS global abierto (`cors()`) a corregir.
7. Auditoría: 31 tablas sin `property_id`; 7 singletons de configuración (message_*, alert_configs, *_recovery_settings, field_rules) bloquean el multi-tenant; `users.email` único global.
8. Recomendación: Fase A (instancia por cliente + `getPropertyId()` + settings + flags) en ~9-12 días; Fase B (multi-tenant real) +20-30 días solo tras 4-5 hoteles estables.
9. Hacer A pasando todo por `getPropertyId()`/`getPropertySettings()`/`hasFeature()` para que B sea cambiar una función (ALS por request).
10. Red de seguridad: snapshots de emails/contrato/factura de Betania, grep-test sin literales, test "hotel vacío", y migraciones SQL siempre aplicadas a mano por el usuario.
