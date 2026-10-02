# betan-bm — Betan Booking Manager

PMS / booking manager para hoteles pequeños, potenciado con IA. Origen: sistema en producción del Hotel Betania (Benalmádena).

Este repositorio contiene la **documentación, la web comercial y el plan de venta** del producto. El código fuente del PMS vive (por ahora) en `../` y se desacoplará del hotel siguiendo `docs/03-DESACOPLAMIENTO-HOTEL.md`.

## Qué hace

Betan es un PMS para hoteles pequeños con un agente de IA integrado, nacido en el Hotel Betania (Benalmádena).
Recibe reservas directas sin comisión (motor web, widget y portal del huésped en 7 idiomas) y sincroniza canales.
Su agente "Betan" actúa como gerente proactivo por chat y voz: 84 herramientas, briefing matutino y tareas programadas.
Toda escritura del agente pide confirmación y respeta los permisos por rol del usuario.
Un motor de 8 reglas ajusta precios cada 30 minutos y audita su propio efecto, además de comparar con competidores.
Recupera carritos y cancelaciones con descuento y mide la conversión de Google Ads.
En cumplimiento prepara y valida el parte SES Hospedajes, lee el DNI con IA, firma el contrato y entrega el código de puerta.
Incluye controles de calidad en check-in, conciliación bancaria, housekeeping, caja y alertas por empleado.

## Estructura

| Ruta | Contenido |
|---|---|
| `docs/01-FUNCIONALIDADES.md` | Inventario completo de funcionalidades y capacidades |
| `docs/02-ARQUITECTURA.md` | Stack, componentes, datos, despliegue, variables de entorno |
| `docs/03-DESACOPLAMIENTO-HOTEL.md` | Qué cambiar para ser independiente del hotel (property id, branding…) |
| `docs/features/IA-AGENTE.md` | Agente "Betan": bucle, 84 tools, permisos, briefing, tareas programadas, voz |
| `docs/features/REVENUE-MOTOR-PRECIOS-COMPETIDORES.md` | Motor de precios (8 reglas), Efecto reglas, competidores, canales, recuperación |
| `docs/features/SES-CHECKIN-CUMPLIMIENTO.md` | SES Hospedajes, escaneo de DNI, contrato, check-in online, acceso, RGPD |
| `docs/features/EXTRAS-DESCUBIERTOS.md` | Auditoría de huecos, top 15 a destacar, funcionalidades a medias |
| `docs/user/` | Manual de usuario (recepción, housekeeping, facturación, IA…) |
| `website/` | Web comercial de una página (estática) |
| `marketing/01-INTEGRACIONES-ESTRATEGIA.md` | Cerraduras y sistemas internos: mapa y roadmap |
| `marketing/02-PRECIOS.md` | Precios y oferta de primera venta |
| `marketing/03-PLAN-MARKETING.md` | Posicionamiento, canales, guiones |
| `marketing/04-PLAN-30-DIAS.md` | Plan de acción 30 días |

## Stack

Bun · TypeScript · Hono · React 19 · PostgreSQL · Drizzle ORM · Stripe · TTLock/ZKTeco · WhatsApp Cloud API · SES Hospedajes · Claude (agente IA).
