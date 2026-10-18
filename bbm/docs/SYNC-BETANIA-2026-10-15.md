# Sincronización con el repo original (betania-booking-manager) — 2026-10-15

Punto de fork: commit `dbafab8` (2026-10-03). Traído: `dbafab8..7315fcd` + cambios sin commitear del 2026-10-15
(merge a tres bandas fichero a fichero; lo específico de Betania se reconvirtió a configuración por tenant).

## Qué entra
| Novedad | Módulo / ajuste del tenant |
|---|---|
| Reserva multi-habitación en el motor público y widget (`lib/roomAssignment.ts`) | `bookingEngine` |
| Integración Jumbo por API (`routes/jumbo-integration.ts`), stop-sales por tarifa cerrada | `jumbo`; secreto `JUMBO_INTEGRATION_TOKEN` (identifica al tenant), setting `jumbo.channelId` (si falta, canal con "jumbo" en el nombre) |
| Vista "Tiempo Real" (plano con limpieza/ocupación) | `liveMap`; planos en `data/floorplans/<slug>/<planta>.{svg,json}` (o `FLOORPLANS_DIR`) |
| Resumen de fin de turno + tools de IA (turnos, vacaciones, resúmenes) | `pool` (lee turnos del sistema de piscina/mantenimiento); penaliza SES/ZKTeco solo si el tenant tiene esos módulos |
| Aviso diario de responsabilidad en recepción | setting `ui.dailyReminder = { enabled, title?, body? }` (apagado por defecto) |
| Escaneo de IDs con cámara, lista "Ya realizados hoy" | — |
| Tarjetas ZKTeco extra por reserva; el enroller también acepta JWT de admin | `zkteco` |
| Ampliación de estancia pendiente de cobro (alerta `extension-unpaid`), recuperación de contraseña, cierre de sesión forzado (`session_version`), líneas de factura libres, QR de habitación por noches restantes, bloqueo de habitaciones en reservas multi-habitación | — |
| Voz continua del asistente en el navegador | `voice`/`ai` |

## Migraciones nuevas (aplicar a mano, en orden; son idempotentes)
`0138_locked_room_ids`, `0139_id_doc_scanned`, `0140_users_session_version`, `0141_shift_end_reports`,
`0142_alert_events_resolved_by`, `0143_pending_extension`, `0144_zkteco_extra_cards`, `0145_invoice_line_items`.
(En el repo original se llaman 0133–0140; aquí se renumeraron porque 0133–0137 ya eran del multi-tenant.)
Haz backup antes (`deploy/README.md`).

## Reconversiones hechas durante el merge
- `madridMs` → `propertyMs(fecha, hora)` (`lib/dates.ts`, zona = `properties.timezone`); sin `Europe/Madrid` literal en lo nuevo.
- `PROPERTY_ID = 1` / `propertyId: 1` → `getPropertyId()` y filtros `property_id` en consultas nuevas (informe QR, resúmenes de turno, id-scan, jumbo, alertas, zkteco).
- Nombre del hotel en Stripe → `getBranding().name`; símbolo de moneda por tenant en alertas/notas/factura.
- Datos fiscales de Jumbo (`JUMBO_BILLING`) → setting `jumbo.invoiceTo` (ya existente).
- Regla "añadir habitación extra": recepción puede en cualquier canal con motivo de ≥5 palabras (cambio de Betania, ahora común).
- Scripts propios de Betania (`scripts/jumbo/`, `scripts/dwg/`, debug de turnos) → `scripts/legacy-betania/` (ignorado por git). Planos de las 5 plantas → `scripts/legacy-betania/floorplans/`.
- Sidebar: los enlaces de módulos (`liveMap`, `laundry`, `cashDrawer`, `nobeds`, `ses`, `zkteco`) solo se muestran si el tenant tiene el módulo.

## Para dar de alta Betania como tenant con todo esto
1. `scripts/tenant-betania-backfill.sql` y activar features: `liveMap, jumbo, pool, zkteco, ttlock, ses…`.
2. Copiar `scripts/legacy-betania/floorplans/*` a `data/floorplans/betania/` en el servidor.
3. Secretos `secrets.JUMBO_INTEGRATION_TOKEN` y apuntar el proceso de correo de Jumbo a `/api/jumbo-integration`.
4. `ui.dailyReminder.enabled = true` si se quiere mantener el aviso diario.

## Pendiente / a revisar
- No se ha ejecutado contra una BD real: `tsc` sin errores nuevos y `bun test` verde, pero falta una pasada manual
  (multi-habitación, resumen de turno, zkteco enroller con admin).
- `public/index.html`, `public/debug.html`, `public/js/*` (UI vanilla antigua) siguen con "Betania": no vienen de esta sincronización.
