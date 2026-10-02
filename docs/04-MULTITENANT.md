# 04 · Arquitectura multi-tenant

> Estado: implementada en `bbm/` (fases A+B de `03-DESACOPLAMIENTO-HOTEL.md` fusionadas). Un **tenant = una fila de `properties`**.
> Una instancia (binario + BD por entorno) sirve a todos los hoteles.

## 1. Resolución del tenant

El código nunca recibe ni escribe un id de propiedad: lee el contexto con `getPropertyId()` (`src/lib/property.ts`,
AsyncLocalStorage). Fuera de contexto **lanza error**; no existe fallback a 1.

| Origen de la ejecución | Cómo se fija el contexto |
|---|---|
| Rutas de staff (`/api/*` tras `requireAuth`) | `tenantFromJwt`: `propertyId` del JWT. El cliente no puede elegirlo. |
| Rutas públicas (`/api/public/*`, `/booking`, portal, QR, contrato) | `tenantFromRequest`: dominio (`properties.public_domain`, vía `X-Forwarded-Host`) → `?tenant=<slug>` / cabecera `X-Tenant` → si solo hay un tenant activo, ese. Si no resuelve: 404. |
| Schedulers | `forEachActiveProperty(label, fn, { feature })`: una pasada por tenant activo con el módulo encendido; el error de un tenant no corta a los demás. |
| Scripts | `--tenant=<slug>` o env `TENANT`, ejecutados con `withTenant()` (`scripts/lib/tenant.ts`). |
| Agente IA | El `propertyId` sale del contexto de la petición; nunca de lo que dice el modelo o el cliente. |

Gestión de tenants: `requirePlatformAdmin` (`users.is_platform_admin`, claim `isPlatformAdmin` en el JWT).

## 2. Aislamiento de datos

- ~40 tablas llevan `property_id`; toda consulta filtra por `getPropertyId()`.
- **Regla IDOR:** cualquier lectura/escritura/borrado por `:id` incluye también `property_id = getPropertyId()`; en tablas
  hijas sin `property_id` (p. ej. `reservation_nights`) se comprueba por JOIN al padre.
- Los singletons antiguos (`message_settings`, `message_templates`, `alert_configs`…) pasan a tener `property_id`.
- Caches en memoria (tokens FDM, JWT TTLock, propiedad) se indexan por tenant; `invalidateProperty(id)` al editar.
- Defensa en profundidad pendiente (no implementada): Row Level Security en Postgres con `SET app.property_id`.
- Verificación: `bbm/tests/tenant-isolation.test.ts` (análisis estático que rechaza `propertyId = 1`, `PROPERTY_ID`, nombres/CIF del
  primer cliente, nombres mágicos…) y, si hay `DATABASE_URL_TEST`, prueba de integración con dos tenants.

## 3. Identidad, branding y localización

Todo dato del hotel viene de `getBranding()` / `brandingOf(row)`: nombre, razón social, CIF, RTA, dirección, teléfono, emails
(recepción y remitente), web, dominio, mapa, logo, estrellas, idioma, moneda y zona horaria. Las plantillas síncronas reciben
`branding` por parámetro. Moneda = `properties.currency_code`; zona horaria = `properties.timezone` (nada de `'Europe/Madrid'` fijo).
El prefijo de plantillas WhatsApp es el `slug` (`<slug>_checkin`), sobreescribible con `settings['whatsapp.templates']`.

## 4. Módulos (features)

`properties.features` (jsonb módulo → boolean). Módulos: `ttlock, zkteco, ses, whatsapp, stripe, nobeds, fdm, jumbo, pool,
competitors, events, pricingRules, ai, voice, bookingEngine, portal, laundry, cashDrawer`.
Un tenant nuevo recibe `DEFAULT_ON` (`bookingEngine, portal, ses, ai, laundry, cashDrawer, pricingRules`); el resto, apagado.
Módulo apagado = la ruta responde 404/403 claro y el scheduler se salta ese tenant (`hasFeature`, `forEachActiveProperty`).

## 5. Ajustes (settings) y secretos

`properties.settings` (jsonb). Se referencian **ids, nunca nombres**:

| Clave | Contenido |
|---|---|
| `pricing.rootRateId` | tarifa raíz del motor de reglas (antes 'Dir AL') |
| `bookingEngine.channelId` / `.stripeAccountId` | canal "web" y cuenta de cobro online |
| `channels.exemptFromUnpaidAlert` | ids de canales exentos del aviso de impagados |
| `fdm.*` | `propertyId, currencyId, baseUrl, reportsUrl, rates, roomUses, accountMap` |
| `jumbo.*` | `buildingId, handlerId, pcId, rateIds, roomIds, boardIds, availabilityBuffer, rateId, roomTypeId, invoiceTo` |
| `whatsapp.templates`, `events.queries`, `ai.assistantName`, `email.policyHtml`… | personalización |
| `secrets.<NOMBRE_ENV>` | credenciales de integraciones (Stripe, TTLock, SES, WhatsApp, FDM, Jumbo, Nobeds, SerpAPI, ZKTeco, piscina) |

`getSecret(NAME)` lee `settings.secrets.NAME`; solo cae al `.env` si `ALLOW_ENV_SECRET_FALLBACK=1` (modo un-solo-hotel).
Los secretos **nunca se devuelven al frontend** y se redactan en `export-tenant`. Limitación actual: se guardan en claro en la BD
(el backup es sensible); cifrado en reposo con una clave maestra del `.env` es mejora pendiente.

## 6. Onboarding de un tenant nuevo

1. `bun scripts/create-tenant.ts --slug=hotel-sol --name="Hotel Sol" --admin-email=dir@hotelsol.com [--domain=… --features=ttlock,stripe …]`
   crea la propiedad, el usuario primario (rol dirección) y llama a `seedTenant()` (`src/lib/tenantSeed.ts`: tarifas, canal web,
   cuentas financieras, catálogos base) dejando fijados `pricing.rootRateId` y `bookingEngine.*`.
2. Entrar como admin y completar: razón social, CIF, RTA, dirección, logo, tipos de habitación y habitaciones, tarifas y temporadas.
3. Cargar credenciales de los módulos contratados (UI de plataforma → `settings.secrets.*`) y activarlos.
4. Dominio propio (opcional): DNS → servidor, `public_domain`, `deploy/add-domain.sh <dominio>` (nginx + certbot).
5. Widget en la web del cliente: `<iframe src="https://<dominio-plataforma>/booking?tenant=<slug>">` (o su dominio propio).
6. Más usuarios: `bun scripts/create-user.ts --tenant=<slug> --email=… --first=… --roles=recepcion`.

El primer cliente se migró con `scripts/tenant-betania-backfill.sql` (a mano, tras la migración 0133).

## 7. Operación

- **Despliegue:** una instancia por entorno (`prod`, `test`); `bun run deploy:<env>` con `DEPLOY_HOST`/`DEPLOY_PATH`. Una migración
  afecta a todos los tenants a la vez: backup antes, siempre. Detalle en `bbm/deploy/README.md`.
- **Nginx:** servidor de plataforma + un `server` por dominio de cliente (`deploy/nginx-tenant.conf.tpl`) + `default_server` que
  devuelve 444 a hosts desconocidos. Certbot por dominio.
- **frame-ancestors:** lo emite la app por tenant en las páginas públicas (`'self'` + `website_url` + `public_domain`); nginx no lo fija
  en `/booking*`. Razón: nginx no conoce la lista por tenant y editarla ahí exigiría recarga en cada alta.
- **Backups:** `scripts/backup-db.sh` (pg_dump -Fc de toda la BD, timer diario, 14 días). Export por tenant:
  `bun scripts/export-tenant.ts --tenant=<slug>` (NDJSON por tabla; sin secretos ni hashes salvo `--include-secrets`).
- **Baja de un tenant:** `properties.active=false` (deja de resolver y de correr schedulers); el borrado físico se hace tras entregar el export.
- **Observabilidad:** los logs de scheduler llevan `[label] tenant <id> (<slug>)`.

## 8. Límites conocidos

- Sin Row Level Security: el aislamiento depende de que cada consulta filtre por `property_id` (de ahí el test estático y la regla IDOR).
- Una sola BD para todos los tenants: un tenant ruidoso afecta a los demás; sin cuotas ni rate limit por tenant.
- Secretos en claro en `properties.settings` (ver 5).
- Restaurar **un** tenant sobre una BD viva no está automatizado (el export es solo de lectura/entrega).
- Dominios de clientes: certificado individual por dominio (sin wildcard); el alta requiere ejecutar `add-domain.sh` en el servidor.
- Los ids de `fdm.*`/`jumbo.*` son datos del contrato de cada cliente y se configuran a mano.
- `frame-ancestors` por tenant depende de que cada ruta pública emita la cabecera; una ruta olvidada sería embebible por cualquiera.
- Cuentas de usuario con email único global: un mismo email no puede existir en dos tenants.
