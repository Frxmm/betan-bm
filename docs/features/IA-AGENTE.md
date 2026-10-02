# Agente IA "Betan" — documentación a fondo

> Complementa la sección 20 de `docs/01-FUNCIONALIDADES.md` (que es el resumen). Aquí se detalla cómo funciona por dentro, qué hace, con qué límites y por qué es un argumento comercial.
> Fuentes: `src/routes/ai.ts` (≈5.500 líneas), `src/routes/voice-brief.ts`, `src/lib/eventsScheduler.ts`, `src/lib/serpapi.ts`, `src/lib/pexels.ts`, `src/lib/log-bus.ts`, `src/db/schema/ai.ts`, `frontend/components/AgentFloat.tsx`, `frontend/lib/speech.ts`, `frontend/views/AgentView.tsx`, `frontend/views/AiDebugView.tsx`, `docs/agent-questions.md`, `scripts/ai-ask.ts`, `scripts/daily-summary-cron.ts`.
> Nota: las rutas de código son relativas a la raíz del repositorio del Hotel Betania (origen del producto).

---

## 1. Qué es, en una frase

Un **gerente virtual** integrado en el PMS: habla español natural, tiene acceso directo (con permisos por rol) a 84 funciones del hotel (reservas, caja, limpieza, precios, mantenimiento, personal), actúa por iniciativa propia (briefing matutino, avisos, tareas programadas) y puede escribir en el sistema, pero siempre pidiendo confirmación y bajo los permisos del usuario que le habla. Se llama **"Betan"** (nombre y wake word) y no es un chatbot de FAQ: lee y escribe en la base de datos real del hotel.

---

## 2. Arquitectura del bucle de agente

### 2.1 Visión general

```
 Panel web (AgentFloat / AgentView)        App Android (wake word "Betan")
        POST /api/ai/chat                       POST /api/voice-brief
              │                                        │
        loadUserCtx(JWT)                       ctxForUser(VOICE_APP_USER_ID)
              └──────────────┬─────────────────────────┘
                             ▼
                runAgentLoop(messages, userCtx, systemExtra, limits)
                             │   selecciona backend por AI_BACKEND
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
 runAgentLoopClaude   runAgentLoopOllama    (RunPod serverless
 (Anthropic SDK)      (Ollama local)         usa el mismo bucle "Ollama")
        │
        ▼  por cada tool_use del modelo
   executeTool(name, args, ctx)  ──►  gate de rol + confirmación ──► SQL/Drizzle, integraciones
        │
        ▼  tool_result (JSON) de vuelta al modelo → siguiente iteración → … → texto final
```

Todas las superficies (chat, voz, briefing, tareas programadas, resumen diario, chequeo proactivo) reutilizan **el mismo bucle y las mismas tools**. Lo único que cambia entre ellas es el `systemExtra` (instrucciones adicionales), los límites y el usuario/rol con el que se ejecutan.

### 2.2 `runAgentLoopClaude` (backend por defecto)

1. **Ensamblado del system prompt** en bloques: (a) `systemPrompt(roles)` con `cache_control: ephemeral`; (b) *snapshot* del hotel (tipos de habitación, tarifas activas, canales, ocupación actual; cacheado en memoria 5 min, `hotelSnapshot()`); (c) `systemExtra` específico de la superficie. Las fechas relativas (hoy, esta semana, semana pasada, mes pasado…) se calculan en hora de Madrid e inyectan en el prompt para que el modelo no tenga que adivinarlas.
2. **Bucle**: llamada a `messages.create` con `CLAUDE_TOOLS` (generadas automáticamente desde la definición única `TOOLS`). Si el modelo devuelve `tool_use`, el servidor ejecuta **todas** las tools de esa vuelta, añade los `tool_result` y vuelve a llamar. Si no hay `tool_use`, devuelve el texto.
3. **Límites**: `maxIterations` = 6 (chat) y 14 (briefing y resumen diario); `maxTokens` = 4.096 por vuelta (8.192 en el resumen diario). Hay hasta **+4 vueltas de reserva** que sirven para:
   - **Forzar respuesta final** (`tool_choice: none`) si se agotan las iteraciones, para que el usuario nunca se quede sin respuesta.
   - **Continuar** si el modelo corta por `max_tokens` (se le pide "continúa exactamente donde lo dejaste" y se concatena).
4. **Errores**: si falla la llamada al modelo (sin crédito, rate limit, red) se devuelve un texto fijo (`AI_UNAVAILABLE_TEXT`); el resumen diario y el briefing lo detectan y **no envían ni guardan** ese texto como si fuera un informe real.
5. **Garantía anti-vacío** (`runAgentLoop`): si el modelo termina sin texto, se sustituye por un mensaje de reintento. Esto existe porque la app de voz reenvía el historial y un turno vacío rompía validaciones posteriores.
6. **Coste real**: en cada llamada se acumulan tokens de entrada, salida, escritura y lectura de caché y se registra `costUsd` en el log (y se devuelve en el resumen diario).

### 2.3 Backends

| `AI_BACKEND` | Qué usa | Notas |
|---|---|---|
| `claude` (por defecto) | API de Anthropic, modelo **`claude-haiku-4-5-20251001`** (SDK `@anthropic-ai/sdk`, cliente perezoso: no falla al arrancar si falta la clave) | Único backend con prompt caching, `tool_choice`, continuación por `max_tokens` y coste contabilizado. Es el de producción. |
| `runpod` | Endpoint serverless RunPod (`RUNPOD_ENDPOINT_ID`, `AI_AGENT_API_KEY`, `RUNPOD_MODEL`; `/runsync?timeout=120`) con formato de tool-calling tipo OpenAI/Ollama | Temperatura 0,2 (para que un modelo pequeño elija tools de forma estable). |
| `ollama` | Ollama local `localhost:11434`, por defecto `llama3.1:8b` | Para ejecución on-premise / sin datos fuera. `num_ctx: 8192`. |

El bucle de los backends no-Claude es más sencillo (6 iteraciones fijas, sin caché, sin forzado final). **Importante**: sólo el backend Claude está plenamente probado en producción; RunPod/Ollama son alternativas por si se quiere soberanía de datos o abaratar, con menor fiabilidad en la elección de tools. El resumen diario fuerza siempre Claude (`runAgentLoopClaude`).

### 2.4 Modelo, coste y optimizaciones

- **Modelo**: Claude Haiku 4.5 (el modelo pequeño y rápido). Es una decisión de coste/latencia: el agente consulta datos y los resume; no hace razonamiento largo.
- **Tarifa usada para el cálculo** (en el código): 1 USD / 5 USD por millón de tokens entrada/salida; escritura de caché ×1,25; lectura de caché ×0,1.
- **Prompt caching** en dos puntos: el último tool (cachea el bloque completo de las 84 definiciones) y el bloque de system prompt. El prefijo estático (system prompt ≈ 29.000 caracteres + definiciones de tools ≈ 70.000 caracteres, del orden de 20-25k tokens) se escribe una vez y las vueltas 2…N y las consultas siguientes dentro de la ventana de caché lo leen a ×0,1. El propio código documenta una reducción de coste del 80-90 % en las iteraciones posteriores.
- **Estimación orientativa** (cálculo propio, no medida en producción): una consulta típica de 2-3 vueltas con caché caliente cuesta del orden de **1-3 céntimos de dólar**; una con caché fría, ~3-4 céntimos; el resumen diario (14 iteraciones máx., 8.192 tokens) algo más. El coste exacto de cada ejecución queda en los logs y el resumen diario lo devuelve (`costUsd`) y lo escribe el cron.
- **Otras optimizaciones de gasto**: snapshot del hotel cacheado 5 min; eventos locales cacheados por día (SerpAPI); el chequeo proactivo está limitado en servidor a **1 por usuario y día** (antes sólo lo limitaba `localStorage`, lo que permitía multiplicar llamadas); ocupación del mes, alertas, ropa, cloro AFC, gastos de cambio y reservas nuevas se **precargan por SQL** en el resumen diario en lugar de dejar que el agente gaste vueltas de tools; el historial de la conversación lo manda el cliente (no se relee de BD).
- **Timeouts**: `Bun.serve` está configurado con `idleTimeout` ampliado a 120 s porque un resumen diario o un chequeo proactivo mantienen la conexión abierta 25-35 s+.

---

## 3. Memoria y sesiones

- **Memoria de corto plazo (conversación)**: el cliente envía el array completo de turnos en cada petición (`POST /ai/chat`); el servidor no mantiene estado de conversación entre llamadas. La app Android hace lo mismo (hasta 40 turnos de ≤2.000 caracteres cada uno).
- **Historial persistente** (`ai_chat_messages`): sólo se guardan los **turnos de usuario y de asistente** (sin las llamadas a tools intermedias), con `userId`, `sessionId`, `source` (`chat` | `debug`) y fecha. El guardado es asíncrono y no bloquea la respuesta.
- **Sesiones**: `GET /ai/sessions` devuelve las **5 últimas** sesiones del usuario con fecha, nº de mensajes y vista previa; `GET /ai/sessions/:id` recupera una completa (siempre las propias). En el panel hay botón de historial para retomarlas.
- **Memoria de largo plazo**: no hay memoria "semántica" ni vectorial. El "conocimiento" persistente del agente es el propio sistema (reservas, notas de reserva, `guest_rating`, hilos de feedback, historial de modificaciones) más el system prompt. Las anotaciones relevantes que hace el agente (valoración de huésped, hilo de feedback, nota de reserva) se escriben en tablas de negocio, no en una memoria opaca.
- **Auditoría cruzada**: `get_staff_ai_activity` (sólo dirección) permite a la dirección consultar qué han preguntado y qué ha respondido el asistente a los demás empleados (máx. 300 mensajes, filtrable por empleado y fechas). Se excluyen las sesiones de debug.

---

## 4. System prompt y personalidad

El prompt se genera por petición (`systemPrompt(roles)`, ≈150 líneas) y tiene estas capas:

1. **Identidad**: "Te llamas Betan", asistente del Hotel Betania. Conversa con naturalidad: saludos y charla informal se responden **sin tools**; cuando la pregunta es del hotel, responde siempre con datos concretos y **nunca inventa** (si no hay dato, busca con menos términos o por separado).
2. **Directrices permanentes de dirección** (estrategia del negocio inyectada como política):
   - Objetivo **ocupación al 100 %**; si quedan ≤2 habitaciones libres lo avisa por iniciativa propia y propone: vender bloqueadas (salvo `locked_by_direction`, inamovibles), revisar posibles no-shows, subir precio de las últimas habitaciones en lugar de rebajar, y cerrar huecos de 1 noche. Único límite: no se admite overbooking real.
   - **Modo gerente proactivo**: no se limita a contestar; busca causa raíz de incidencias repetidas, cuestiona cambios de precio ("¿por qué?, ¿con qué dato?, ¿qué efecto tuvo?"), pide la valoración de huéspedes que ya se fueron, y termina con la siguiente acción concreta y quién debería hacerla. Estilo: preguntas cortas de sí/no al director.
   - **Curiosidad de gerente**: hace preguntas breves y de una en una (qué falta, de qué se quejan o qué elogian los huéspedes) y cruza respuestas para detectar patrones.
   - **Hilos de feedback**: todo comentario de huésped (queja, elogio, reseña pegada) abre un hilo con `create_feedback_thread` sin pedir permiso.
   - **Traductor personal**: traduce al español textos de huéspedes/OTAs y propone respuesta en el idioma del remitente, sin tools.
3. **Reglas de negocio específicas**: canal **Agoda** (cobra en el check-out: un saldo pendiente antes del check-out no es impago), numeración de facturas, estados de reserva, métodos de pago.
4. **Reglas de elección de tool** ("estrictas"): `get_today_summary` sólo para hoy; comparar años = una llamada a `get_period_summary` por periodo; auditar facturas = siempre `get_invoice_anomalies`, nunca `get_invoices` (limitada a 50); desayunos servidos ≠ inventario de desayuno.
5. **Flujos obligatorios**: ampliación de estancia en 5 pasos (identificar → noches/tarifa → `calc_extension_price` → presentar total y pedir confirmación → `extend_stay`), valoración 1-10 inmediatamente tras un check-out, acciones de escritura en 3 pasos (describir → pedir confirmación → ejecutar con `confirmed=true`).
6. **Reglas de privacidad**: importes totales de facturación sólo para dirección (el servidor devuelve `null` y el modelo debe omitirlo sin comentarlo); mensajes y fondos sólo a **personal**, nunca a huéspedes; los datos de mantenimiento/piscina nunca se estiman si no hay acceso.
7. **Fechas de referencia** calculadas en servidor (Europe/Madrid).
8. **Permisos**: se añade al prompt la línea "el usuario actual tiene roles [...]", pero **la validación real es del servidor** (ver sección 6).
9. **Sufijos por superficie** (`systemExtra`): voz (respuestas de 1-3 frases leídas en alto), briefing (sólo lectura), tarea programada (actúa con `confirmed=true`), chequeo proactivo (breve, cálido), resumen diario (HTML de 14 secciones).

---

## 5. Las 84 tools

Cada tool tiene definición (descripción + JSON schema) en `TOOLS` y un `case` en `executeTool`. Las descripciones están escritas para guiar al modelo (cuándo sí, cuándo no). **Permisos** = lo que valida el servidor. "Conf." = exige `confirmed=true` tras la confirmación explícita del usuario.

### 5.1 Resúmenes y KPIs (12) — lectura
| Tool | Para qué sirve |
|---|---|
| `get_today_summary` | Resumen **sólo de hoy**: llegadas, salidas, en casa; pasos de check-in incompletos (contrato, tarjeta ZKTeco, SES) y tiempos/omisiones de check-in por empleado. Para dirección añade `finances`: cobrado hoy por método y caja, facturación del mes, % cobrado y reservas con saldo pendiente. |
| `get_period_summary` | Resumen operativo de un rango cualquiera (llegadas, salidas, noches vendidas, ocupación media, ingresos cobrados, canal principal). Importes sólo dirección. |
| `get_occupancy_report` | Mismos números que Informes → Ocupación: ocupación %, ingresos, ADR, RevPAR por día/semana/mes. |
| `get_occupancy_rate` | Tasa de ocupación de un periodo (% noches ocupadas). |
| `get_revenue` | Dinero **cobrado** (transacciones reales) con desglose por forma de pago. Dirección. |
| `get_revenue_forecast` | Ingresos previstos de reservas confirmadas/tentativas. Dirección. |
| `get_channel_stats` | Reservas e ingresos por canal. |
| `get_channel_comparison` | Cuota de mercado por canal (% reservas / % ingresos), precio medio, noches medias, tasa de cancelación. |
| `get_stay_stats` | Noches medias, precio medio por reserva y por noche. |
| `get_booking_patterns` | Patrones dentro de un rango: día de semana, mes, lead time, duración, canales. |
| `get_repeat_guests` | Ranking de huéspedes recurrentes. |
| `get_new_bookings` | Reservas **creadas** en un rango (por `bookedAt`, no por fecha de entrada). |

### 5.2 Reservas — lectura (12)
| Tool | Para qué sirve |
|---|---|
| `search_reservations` | Busca por nombre, email, teléfono, DNI, código, habitación o grupo; devuelve también todos los ocupantes. |
| `search_reservations_by_guest_profile` | Busca estancias por perfil de **todas** las personas alojadas (edad/sexo): "mayores de 70", "menores de 12". |
| `query_reservations` | Cuenta o lista con filtros combinados (estado, canal, habitación, rangos). Para estadística. |
| `get_reservation` | Ficha completa: huésped, habitación, fechas, canal, total, pendiente, ocupantes. |
| `get_reservation_history` | Línea de tiempo auditable: cambios de estado, modificaciones de campos (con autor y hora) y notas. Sirve para detectar anomalías (cambios de habitación sin nota, reversiones de check-in, precios cambiados). |
| `get_arrivals` | Llegadas de un día (incluso pasado) con hora y empleado del check-in. |
| `get_departures` | Salidas de un día. |
| `get_in_house` | Huéspedes en casa ahora. |
| `get_no_shows` | No-shows marcados y posibles no-shows sin marcar. |
| `get_unassigned_reservations` | Confirmadas/tentativas sin habitación. |
| `get_pending_payments` | Saldos pendientes; excluye automáticamente Agoda hasta su check-out. |
| `get_abandoned_carts` | Carritos web abandonados, descuento ofrecido (10-25 % escalonado), email/WhatsApp de recuperación enviado y recuperación. |

### 5.3 Reservas — escritura (9, todas con Conf.)
| Tool | Roles | Descripción |
|---|---|---|
| `create_reservation` | dirección, recepción | Crea UNA reserva en estado tentative (sin habitación; se asigna luego). |
| `update_reservation` | dirección, recepción | Fechas, personas o precio total de UNA reserva. |
| `cancel_reservation` | dirección, recepción | Cancela UNA reserva (jamás en masa). |
| `check_in` | dirección, recepción | Check-in; falla si faltan datos obligatorios SES del titular o acompañantes. |
| `check_out` | dirección, recepción | Check-out; el agente pide inmediatamente la valoración 1-10. |
| `assign_room` | dirección, recepción | Asigna habitación verificando disponibilidad. |
| `extend_stay` | dirección, recepción | Cambia el check-out y el total tras `calc_extension_price`. |
| `add_reservation_note` | dirección, recepción, conserje | Nota interna. |
| `add_payment` | dirección, recepción | Registra UN pago. |

### 5.4 Disponibilidad y precio (7)
| Tool | Descripción |
|---|---|
| `get_availability` | Habitaciones libres entre dos fechas. |
| `search_rooms` | Catálogo de habitaciones con características físicas (baño, terraza, vista, cama, AC…) y filtros. |
| `get_room_stats` | Ranking de habitaciones por reservas/noches. |
| `calc_rate_quote` | Presupuesto de una estancia para tarifa y tipo concretos, sin reserva existente ("20 dobles del 3 al 5"). |
| `calc_extension_price` | Coste de ampliar una reserva con desglose por noche. |
| `get_price_recommendation` | Ocupación prevista vs. precio listado vs. ADR **real**, por día o por semana; se cruza con eventos y patrones. Menciona que el ADR real es el suelo de la regla "Parada de reservas". |
| `set_sale_price` | **Sólo dirección, Conf.** Cambia el precio de la tarifa "Dir AL", habitación doble, para una fecha o rango. |

> Observación de implementación: `calc_extension_price` está incluida en la tabla de roles de escritura (dirección, recepción), por lo que el servidor le aplica el gate de rol y también el de `confirmed`, aunque es de cálculo. Está documentado aquí como curiosidad; no afecta a la seguridad.

### 5.5 Huéspedes (4)
`search_guests` (por nombre, email, teléfono o documento; con edad y resumen de estancias), `get_guest_history` (todas las estancias, importes, notas), `update_guest` (contacto/documento; dirección y recepción, Conf.), `update_guest_rating` (**nuestra** valoración 1-5 del huésped; dirección y recepción, Conf. en el servidor aunque el prompt indica que basta con la puntuación del usuario).

### 5.6 Pricing dinámico y mercado (4) — dirección
| Tool | Descripción |
|---|---|
| `get_pricing_rules_status` | ¿Está vivo el motor de reglas? ¿Cuándo corrió? ¿Por qué no se aplicó la regla X el día Y? |
| `get_pricing_effects` | Para cada cambio de precio pasado: reservas de esa noche 72 h antes vs. 72 h después, agrupado por regla o "manual". Señala reglas que "regalan ingreso" o que se podían subir más. |
| `get_competitor_comparison` | Nuestro precio "Dir AL" (reglas ya aplicadas) frente a competidores, día a día (hasta 60 días), con precio efectivo ajustado por el divisor de Booking; `null` = competidor agotado = señal de demanda. Dirección y recepción. |
| `search_local_events` | Eventos de Benalmádena/Málaga (SerpAPI Google Events) con nivel de impacto. |

### 5.7 Caja y facturación (5)
`get_transactions` (pagos entre fechas con filtros), `get_daily_cash` (cierre de caja por método y cuenta, sin fianzas), `get_invoices` (últimas 50), `get_invoice` (por id o número), `get_invoice_anomalies` (duplicados, huecos de numeración y facturas a 0 € sobre **todo** el histórico). Todas las de importes: sólo dirección.

### 5.8 Housekeeping y lavandería (6)
`get_housekeeping_status`, `get_breakfast_summary` (desayunos a servir/servidos), `get_laundry_status` (prendas por estado), y las de escritura `set_housekeeping_done` (dirección, recepción, limpieza), `assign_housekeeping_task` (dirección, recepción), `create_housekeeping_task` (dirección, recepción, limpieza); todas con Conf.

### 5.9 Mantenimiento y piscina (6) — sólo dirección, lectura
Datos de una app externa de control (solo lectura, `X-API-Key`): `get_breakfast_inventory` (existencias con diff/gasto vs. inventario anterior), `get_breakfast_inventory_catalog` (unidades y conversión a peso/volumen real), `get_room_incidents` (averías por prioridad/estado), `get_pool_supplies_level` (gas/cloro con días restantes), `get_pool_water_readings` (cloro/pH y AFC/ACS para legionela), `get_water_tank_status` (aljibe: litros, consumo/h, evolución). Si la integración no está configurada, el agente lo dice ("no es un problema de permisos"); nunca estima.

### 5.10 Feedback y personal (8)
| Tool | Roles | Descripción |
|---|---|---|
| `create_feedback_thread` | dirección, recepción, conserje, limpieza | Abre hilo de feedback de huésped (queja/elogio/sugerencia); el agente lo hace solo, sin pedir permiso. |
| `list_feedback_threads` | dirección, recepción, conserje | Hilos con estado; permite detectar patrones. |
| `adjust_engagement_rating` | dirección | Suma/resta −30..+30 puntos, con motivo obligatorio, al rating de implicación de UN empleado; sin parámetros consulta el rating de todos. |
| `get_staff_ai_activity` | dirección | Qué han hablado los demás con el asistente. |
| `get_staff_list` | todos | Usuarios, roles y activos (sin contraseñas ni sueldos). |
| `get_online_users` | todos | Quién está conectado (presencia de los últimos 90 s). |
| `send_staff_message` | dirección | Mensaje interno a UN miembro del personal; **no** pide confirmación (bajo riesgo; sólo personal). Parámetro `important` para el aviso bloqueante. |
| `broadcast_staff_message` | dirección | Igual, a todo el personal activo. |

### 5.11 Tareas programadas (4) — dirección, Conf.
`create_scheduled_task`, `list_scheduled_tasks`, `set_scheduled_task_active`, `delete_scheduled_task` (ver sección 7).

### 5.12 Alertas (2) — dirección
`get_alert_configs` (25 tipos de alerta con estado) y `set_alert_enabled` (activa/desactiva; Conf.). Tipos: `breakfast-unconfirmed`, `stale-room-incident`, `hk-unassigned`, `drawer-mismatch`, `unpaid-reservation`, `checkout-pending`, `no-show-booking`, `high-occupancy`, `pricing-engine-health`, `feedback-complaint-open`, etc.

### 5.13 Control físico (1) y UI (4)
`open_access_door` (ZKTeco, puertas 1-4; sólo dirección; Conf.), `navigate` (lleva al usuario a una vista: dashboard, planning, llegadas, salidas, facturación, reservas, huéspedes, habitaciones; con id de reserva), `set_dashboard_background`, `clear_dashboard_background`, `set_user_dashboard_background` (dirección). Los fondos no piden confirmación (son estéticos).

> Recuento: 12 + 12 + 9 + 7 + 4 + 4 + 5 + 6 + 6 + 8 + 4 + 2 + 1 + 4 = 84 (agrupación propia de este documento, que difiere ligeramente de la de `docs/01-FUNCIONALIDADES.md`; el total en `TOOLS` es 84).

---

## 6. Permisos por rol y confirmaciones

**Cómo se determina el contexto**: `loadUserCtx` lee el `sub` del JWT, carga los roles de `user_roles` y añade `direccion` si el usuario es `isPrimary`. Sin usuario identificable (por ejemplo, un JWT sin `sub`) los roles son `[]`: el agente no ve datos financieros ni puede ejecutar acciones con rol. Es lo que usa `scripts/ai-ask.ts` sin `--user`.

**Tres capas de defensa**, ninguna depende de que el modelo "se porte bien":

1. **Gate de escritura en servidor** (`WRITE_TOOL_ROLES` en `executeTool`): antes de ejecutar cualquier tool de escritura se comprueba que alguno de los roles del usuario esté permitido; si no, el modelo recibe `Permiso denegado…` y se lo comunica al usuario.
2. **Gate de confirmación**: si falta `confirmed=true` la tool **no se ejecuta** y devuelve `needs_confirmation` con la instrucción de describir la acción y pedir confirmación. El prompt obliga a que `confirmed=true` se envíe sólo tras una respuesta afirmativa del usuario en su siguiente mensaje. Excepción deliberada: `send_staff_message` y `broadcast_staff_message` (sólo texto a personal).
3. **Una acción = una entidad**: todas las tools de escritura operan sobre UNA reserva/tarea/huésped; el diseño impide operaciones masivas (el prompt ordena rechazar "cancela todas las de mañana").
4. **Gate de datos**: los importes totales (caja, ingresos, totales de facturas) comprueban `ctx.roles.includes('direccion')` dentro de cada tool; las 6 tools de mantenimiento/piscina, `get_staff_ai_activity`, las de tareas programadas, `set_user_dashboard_background` y `get_invoice_anomalies` también.

**Matriz resumida** (rol → qué puede hacer vía agente):

| Rol | Lectura | Escritura |
|---|---|---|
| **Dirección** (y usuario primario) | Todo: finanzas, pricing, competidores, mantenimiento/piscina, actividad del staff, alertas | Todo lo de recepción + `set_sale_price`, `open_access_door`, mensajes y avisos al personal, tareas programadas, alertas, ajuste de rating de implicación, fondos de otros |
| **Recepción** | Operativa de reservas, huéspedes, llegadas, disponibilidad, competidores, housekeeping, feedback; **sin** importes totales de facturación | `check_in`, `check_out`, `create/update/cancel_reservation`, `assign_room`, `extend_stay`, `add_payment`, `update_guest`, `update_guest_rating`, notas, tareas de limpieza |
| **Conserje** | Operativa básica y feedback | `add_reservation_note`; abrir hilos de feedback |
| **Limpieza** | Housekeeping, desayunos, lavandería | `set_housekeeping_done`, `create_housekeeping_task`; abrir hilos de feedback |
| **Sin rol / script sin `--user`** | Sólo datos no financieros | Ninguna |

**Qué pide confirmación**: las 9 de reservas, las 3 de housekeeping, `update_guest`, `update_guest_rating`, `adjust_engagement_rating`, las 3 mutaciones de tareas programadas, `set_alert_enabled`, `set_sale_price` y `open_access_door`. **No** la piden: mensajes al personal, fondos de pantalla, `create_feedback_thread`, `navigate` y todas las de lectura.

---

## 7. Tareas programadas (`ai_scheduled_tasks`)

Dirección dice por chat algo como *"cada dos días manda un chiste de hoteles a todo el personal, a horas aleatorias"*; el agente:

1. Redacta él mismo un `prompt` **autocontenido** (con qué tool actuar) que le servirá en el futuro sin contexto.
2. Resume y confirma: qué hará, cada cuántos días, ventana horaria (por defecto 09:00-20:00).
3. Con `confirmed=true` crea la fila.

Tabla `ai_scheduled_tasks`: `prompt`, `interval_days`, `time_window_start/end` (hora Europe/Madrid), `active`, `next_run_at`, `last_run_at`, `last_result` (hasta 2.000 caracteres), `last_error`, `created_by`.

**Ejecución**: `startAiScheduledTasksScheduler` hace un barrido cada **5 min**; para cada tarea activa vencida construye el contexto con los roles de **quien la creó** (los permisos no se escalan), ejecuta el prompt por el mismo `runAgentLoop` con un `systemExtra` que dice "no hay humano: actúa con `confirmed=true`, la autorización ya la dio dirección al crearla", guarda el resultado o el error y **sortea la siguiente ejecución** a un minuto aleatorio dentro de la ventana, `intervalDays` días después. Dirección puede listar, pausar o borrar con el propio chat.

**Límites**: sólo dirección puede crear/pausar/borrar; si el modelo falla se registra `lastError = "El modelo no respondió"` y se reprograma igualmente; una tarea puede ejecutar cualquier escritura que la autorización de su creador permita, por lo que conviene revisar `list_scheduled_tasks` periódicamente.

---

## 8. Mensajes proactivos y bandeja

### 8.1 Chequeo proactivo (`POST /ai/proactive`)
El panel dispara al entrar (cooldown local de 20 h) un `kind: 'checkin'`: el agente **inicia la conversación** sin que nadie pregunte. Saluda según la hora y elige **una** cosa concreta: (a) algo pendiente y llamativo con cifras reales (pago sin cobrar, caja sin cerrar, limpieza sin asignar); (b) si no hay nada urgente, pregunta cómo han sido los huéspedes de hoy y, si el usuario confirma algo de uno concreto, anota con `update_guest_rating`; (c) un dato breve y pregunta abierta. 2-3 frases. **Límite en servidor: 1 por usuario y día** (Madrid).

`kind: 'background'`: una vez al día, a una hora aleatoria entre 09:00 y 20:00, pregunta "¿dónde te gustaría estar ahora mismo?" y pone la foto como fondo (ver sección 12).

### 8.2 Bandeja de mensajes del equipo (`GET /ai/inbox`)
Mensajes internos de dirección (`staff_messages`), nunca de/para huéspedes. El panel consulta cada 2 min; los no entregados salen como burbujas "📩 *Nombre* te dice: …" y se marcan `delivered`. Entre ellos están los avisos de eventos locales (sección 11).

### 8.3 Mensajes "Importante Ahora" con acuse de recibo
Si dirección dice "es importante / que no lo pueda ignorar", el agente marca `important=true`. Estos mensajes **no** salen en la burbuja, sino en un **popup bloqueante a pantalla completa** (`ImportantStaffMessagePopup.tsx`) con un mínimo de **10 s** antes de poder confirmar. `GET /ai/important-messages` los lista; `POST /ai/important-messages/:id/ack` guarda `acknowledged_at` (validando que el mensaje sea del propio usuario). Queda constancia de **quién lo leyó y cuándo** — diferencia entre "mostrado" (`delivered`) y "confirmado" (acción explícita).

### 8.4 Briefing matutino automático
Una vez al día, entre las **08:00 y 13:00 (Madrid)**, y para cada usuario activo con rol dirección que aún no lo tenga, el agente prepara un briefing de ~12 líneas **de sólo lectura** y lo deja como sesión `briefing-YYYY-MM-DD` en su historial. Revisa por su cuenta: estado del motor de reglas, efecto de las reglas dinámicas, comparación con competidores (14 días), ocupación de hoy y próximos 14 días frente al año anterior, hilos de feedback abiertos y alertas activas. Estructura: *Lo más importante hoy (con impacto en €) · Precios · Feedback de huéspedes · Preguntas para ti (máx. 4, de sí/no)*. Los mensajes al personal que propone van como **BORRADOR**: no los envía. Excepción: puede abrir un hilo de feedback si detecta un comentario sin hilo. Usa hasta 14 iteraciones.

---

## 9. Resumen diario por email (`POST /ai/daily-summary`)

- **Disparo**: `scripts/daily-summary-cron.ts` (cron externo, 23:00 Madrid) firma un JWT de sistema de 2 minutos (`isPrimary`, rol dirección) y llama al endpoint. Sólo admin puede llamarlo (también a mano, para pruebas).
- **Precarga SQL** (para no gastar vueltas del agente ni depender de que se acuerde): ocupación día a día del mes completo (mismo cálculo que Informes), ocupación de hoy, reservas hechas hoy, llegadas de hoy con saldo pendiente, gastos de caja de cambio, alertas activas (llamada interna a `/api/alerts/urgent`), ropa por estado y última lectura de cloro de agua fría (AFC).
- **Redacción**: el agente (Claude, 14 iteraciones, 8.192 tokens) completa 14 secciones en HTML en un orden fijo: ocupación del día (con gráfico), reservas nuevas (tabla), llegadas pendientes de cobro, pagos por método (`get_daily_cash`), gastos de caja, alertas, consumo de agua del día, cloro AFC, piscina, existencias a cero en desayunos, ropa rota/limpia/sucia, etc.
- **Gráfico**: PNG de la ocupación del mes generado en servidor y adjunto inline (`cid:`).
- **Envío**: a todos los usuarios con rol dirección con email, vía Resend. Si el modelo no responde, **no se envía** nada y el cron registra el fallo (502). El cron escribe en su log los destinatarios y el **coste en USD** de cada informe.

---

## 10. Voz

### 10.1 En el panel (navegador, sin servicios de pago)
`frontend/lib/speech.ts` usa la **Web Speech API nativa**: no hay backend de voz ni claves.
- **Reconocimiento**: `SpeechRecognition`/`webkitSpeechRecognition`, `es-ES`, resultados intermedios y modo no continuo (dictado de una frase). Soporte según navegador (el botón de dictado sólo aparece si existe la API, p. ej. Chrome).
- **Síntesis**: `speechSynthesis` `es-ES`, velocidad 1,3. `stripForSpeech` limpia emojis, markdown y símbolos (convierte `%` en "por ciento", mantiene fechas legibles) para que el motor no deletree "asterisco" o "guión". La voz está **apagada por defecto** y se activa por dispositivo (`localStorage`).
- Se usa en el asistente flotante (`AgentFloat`) y en el chat del Resumen rápido de dirección (`AdminQuickStats`).

### 10.2 App Android "Betan" (`POST /api/voice-brief`)
- **Wake word "Betan"** (Picovoice Porcupine, en segundo plano), el reconocedor de voz de Android transcribe la petición y la envía como texto.
- El backend reutiliza **`runAgentLoop`** con un `VOICE_SYSTEM_EXTRA`: respuesta de **1-3 frases**, sin listas ni pasos intermedios, salvo que el usuario pida detalle. El móvil la lee con su TTS.
- **Autenticación**: token estático (`VOICE_APP_TOKEN`) por cabecera, sin login; actúa como el usuario `VOICE_APP_USER_ID` (con sus roles reales) o, si no se define, como `direccion`. Si el token no está configurado el endpoint responde 503. Montada antes de `requireAuth`.
- **Conversación**: la app mantiene el historial en memoria (unas horas) y lo reenvía entero (hasta 40 turnos).
- **`GET /api/voice-brief/dashboard`**: cifras de la pantalla principal (ocupación %, cobrado hoy y por método, reservas nuevas de hoy, llegadas con saldo pendiente), con los mismos criterios que el panel.

---

## 11. Búsqueda de eventos locales y recomendación de precios

### 11.1 Eventos (`serpapi.ts`, `eventsScheduler.ts`)
- 4 consultas a Google Events vía SerpAPI (`eventos Benalmádena`, `eventos Málaga`, `conciertos Málaga`, `festivales Málaga`), idioma/país ES, deduplicadas por título, **caché diaria** (6 h).
- **Clasificación de impacto** por palabras clave del título: **high** (festival, concierto, feria, maratón, triatlón, copa del rey, final, liga, circo solar…) / **medium** (exposición, mercadillo, teatro, torneo, congreso…) / low. Es heurística, no un modelo de demanda; conviene tratarla como señal.
- **Scheduler 09:00 Madrid**: si hay eventos high/medium a ~30 días, manda un mensaje interno (`staff_messages`, remitente el usuario primario) a todos los usuarios de dirección con los 10 primeros y "considera revisar tarifas". Si no hay `SERPAPI_API_KEY`, el scheduler se desactiva sin romper nada.
- La tool `search_local_events` permite consultar a demanda con filtro de impacto.

### 11.2 Recomendación de precios
No es una caja negra: el agente **combina tools** y razona sobre ellas, guiado por el system prompt:
`get_price_recommendation` (ocupación prevista, precio listado y ADR real por día/semana) + `get_occupancy_report` (mismo periodo del año anterior) + `get_competitor_comparison` (precio vs. competidores y competidores agotados) + `search_local_events` + `get_pricing_effects` (¿funcionan las reglas?) + `get_pricing_rules_status`. Con ello propone subir/bajar y **cuestiona** cambios previos. Aplicar el cambio es una acción separada, sólo dirección, con confirmación (`set_sale_price`, que además sólo toca la tarifa "Dir AL" de la doble). Regla del prompt: no bajar de ADR real sin decirlo, y nunca rebajar en fechas casi llenas.

---

## 12. Cambios de fondo del dashboard (Pexels)

- `set_dashboard_background(place)`: `searchPlacePhoto` consulta Pexels (1 foto horizontal, `large2x`) y guarda URL y crédito del fotógrafo en `user_preferences` (`dashboardBgUrl/Credit`); el frontend recibe el evento `dashboard-bg-changed` y repinta. **Atribución obligatoria** ("Foto de X en Pexels") conservada y mostrada.
- `clear_dashboard_background`; y `set_user_dashboard_background` para que dirección ponga el fondo a otro usuario ("ponle a Marta una playa de Cádiz").
- Pregunta diaria a hora aleatoria "¿dónde te gustaría estar?" — una función de **retención y cultura de equipo**: no es solo decoración, hace que el personal abra y converse con el asistente.
- Sin confirmación (puramente estético). Requiere `PEXELS_API_KEY`; si no está, el agente informa de que no está configurado.

---

## 13. Detección de anomalías de facturas

`get_invoice_anomalies` (sólo dirección) examina **todas** las facturas de la BD y devuelve tres bloques independientes:
- **Duplicados**: número repetido en varias facturas, con id, fecha, importe y reserva para decidir cuál es la buena.
- **Huecos**: números ausentes en la secuencia (numeración continua, no se reinicia por año), con la factura/fecha anterior y posterior y el campo `in_requested_period`.
- **Facturas a 0 €**.
Cada bloque trae su `*_count` real; las listas se recortan a 50 y el agente debe avisar ("hay 73 huecos, muestro los 50 primeros"). El prompt prohíbe usar `get_invoices` para auditar (limitada a 50). El agente **no supone la causa** del hueco, sólo lo reporta. Complementa el control de auditoría de reservas (`get_reservation_history`).

---

## 14. Actividad del staff y engagement

- `get_staff_ai_activity`: dirección ve qué preguntaron y qué se respondió a cada empleado (excluye debug). Útil para detectar formación necesaria o uso indebido, y también un tema de **transparencia laboral**: conviene informar al personal de que dirección puede revisarlo (aspecto RGPD/laboral a cuidar por el cliente).
- `get_today_summary` incluye **tiempos de check-in por empleado** (media, franja más habitual) y las **omisiones** de contrato / tarjeta ZKTeco / SES hospedajes, con la instrucción de destacar a quien acumule más de 2 fallos.
- `adjust_engagement_rating`: ajuste ±30 con motivo del rating de implicación (media ponderada de 3 meses de actividad registrada en la plataforma + puntos; máx. 100; el empleado ve el suyo y, por encima de 80, se le muestra semanalmente). Permite compensar trabajo no reflejado en la plataforma.
- `get_online_users` y `get_staff_list` para saber quién está conectado y qué roles tiene.

---

## 15. Auditoría, logs y vista de debug

- **Logs**: `log-bus.ts` es un bus en memoria con **buffer circular de 500 entradas**; el agente registra cada iteración, cada tool call (con argumentos), errores y el **coste por consulta**. `GET /ai/logs` los expone por **SSE** (con ping cada 15 s) y el historial al conectarse.
- **AI Debug** (`AiDebugView`, sólo admin): chat de pruebas que elige backend (`ollama` o `claude`) y muestra, por iteración, la **traza completa**: backend, milisegundos, HTTP status, respuesta cruda (hasta 8.000 caracteres), error de JSON, mensaje normalizado, tools llamadas con argumentos y resultados. Panel de logs en vivo debajo. Sesiones guardadas con `source='debug'`, separadas del historial real. Sirve para afinar prompts, depurar por qué se eligió una tool y comparar modelos.
- **Auditoría de acciones**: toda escritura del agente pasa por `executeTool` y deja huella en los mismos mecanismos que las acciones manuales (historial de reserva con autor, transacciones, etc.). El historial de chat guarda quién preguntó qué.
- **CLI `scripts/ai-ask.ts`**: REPL o pregunta única contra `/api/ai/chat`, con `--user <id>` para simular los permisos reales de un usuario y `--verbose` para ver las tools. Ideal para pruebas rápidas y regresión de preguntas (hay un catálogo en `docs/agent-questions.md` de 24 preguntas tipo de recepción).

---

## 16. Límites y seguridad

**Controles existentes**
- Permisos validados en servidor por rol y por tool (sección 6); el modelo no puede saltarse el gate ni auto-otorgarse un rol.
- Confirmación obligatoria en escrituras, una entidad por acción, imposible la operación masiva.
- Mensajería sólo a personal: **no existe ninguna tool para escribir a huéspedes** (ni email, WhatsApp ni SMS); es una decisión de diseño explícita, que elimina el riesgo de que el agente contacte a un cliente.
- Datos financieros devueltos como `null`/error por el servidor, no sólo ocultos por prompt.
- Credenciales: API keys en variables de entorno; la app de voz usa un token propio de menor alcance; JWT de sistema de 1-2 minutos para los cron.
- Control de coste: tope de iteraciones y tokens, caché, 1 chequeo proactivo/día/usuario, caché de eventos.
- Tolerancia a fallos: texto de indisponibilidad, no se envían informes de error, forzado de respuesta final.

**Prompt injection (tratamiento honesto)**: el texto de huéspedes (notas de reserva, nombres, comentarios, reseñas pegadas) llega al modelo como resultado de tools o como mensaje del usuario, y **no hay un filtro explícito anti-injection** en el código. La mitigación es **estructural**: aunque un texto malicioso engañara al modelo, el servidor sólo ejecuta lo que el rol del usuario permite, exige `confirmed=true` y limita cada acción a una entidad; no hay tool que envíe datos a terceros ni exfiltre masivamente fuera del chat. El riesgo residual real: un texto manipulado en una nota podría inducir una respuesta engañosa o proponer una acción que el usuario acabara confirmando sin leer. Se recomienda a futuro: etiquetar los campos de texto libre como "datos no fiables" en los resultados de tools y mostrar al usuario el detalle exacto de la acción antes de confirmar en la UI.

**Escritura**: sólo las 24 tools de `WRITE_TOOL_ROLES` más las de feedback, fondos y navegación. Las tareas programadas y el chequeo en segundo plano actúan sin humano; la tarea programada ejecuta escrituras con `confirmed=true` automático (autorizado al crearla).

**Limitaciones**: ver sección 18.

---

## 17. 25 ejemplos de uso reales por rol

### Dirección (10)
1. *"Buenos días Betan, ¿cómo estamos hoy?"* → `get_today_summary`: llegadas, salidas, en casa, cobrado por método (alerta si un método supera el 60 %), facturación del mes y % cobrado, pendientes por deuda; avisa de check-ins con pasos incompletos.
2. *"Compara marzo de 2024, 2025 y 2026"* → tres llamadas a `get_period_summary` (una por periodo) y tabla comparativa.
3. *"¿Por qué estamos 30 € sobre el más barato con ocupación baja el sábado?"* → `get_competitor_comparison` + `get_occupancy_report` + `get_pricing_effects`; propone bajar o mantener con el dato del ADR real.
4. *"Pon el precio del 15 a 90 €"* → entiende "Dir AL, doble", confirma fecha y precio y ejecuta `set_sale_price`.
5. *"Revisa las facturas del trimestre por si hay duplicados"* → `get_invoice_anomalies`; informa de duplicados, huecos y facturas a 0 € con recuento real.
6. *"Cada lunes manda al equipo un recordatorio de revisar las incidencias, entre las 9 y las 11"* → `create_scheduled_task` tras confirmar el prompt autocontenido y la ventana horaria.
7. *"Dile ahora mismo a recepción que suba a la 12, es importante"* → `send_staff_message` con `important=true`: popup bloqueante con acuse de lectura.
8. *"¿De qué han hablado hoy con el asistente en recepción?"* → `get_staff_ai_activity`.
9. *"¿Cuánto cloro queda en la piscina y cuánto ha consumido el aljibe esta semana?"* → `get_pool_supplies_level` + `get_water_tank_status`; avisa si quedan menos de 5 días de cloro.
10. *"Abre la puerta 2"* → confirma y ejecuta `open_access_door` (ZKTeco).

### Recepción (8)
11. *"¿Qué llegadas tenemos mañana y cuáles no han pagado?"* → `get_arrivals` + `get_pending_payments` (Agoda excluido hasta su check-out).
12. *"Haz el check-in de la reserva 42"* → describe la acción, espera "sí", `check_in` con `confirmed=true`; falla con aviso si falta un dato SES del huésped.
13. *"Haz el check-out de Juan García"* → `search_reservations` → confirma → `check_out` → pregunta la valoración 1-10 → `update_guest_rating`.
14. *"Quiere ampliar dos noches, tarifa web"* → flujo de 5 pasos: `calc_extension_price`, presenta el total, confirma, `extend_stay`.
15. *"Hay una señora de más de 70 en la 8, ¿qué reserva es?"* → `search_reservations_by_guest_profile`.
16. *"¿Quién hizo el check-in de la reserva de ayer y a qué hora?"* → `get_arrivals` con fecha pasada (hora y empleado).
17. *"Dame un presupuesto para 20 dobles del 3 al 5 de mayo con tarifa grupos"* → `calc_rate_quote`.
18. *"Traduce esto"* (pega un email de un huésped en alemán) → traducción y borrador de respuesta, sin tools.

### Conserje (3)
19. *"Añade a la reserva de la 5: pide cuna para la llegada"* → confirma y `add_reservation_note`.
20. *"El huésped de la 9 se queja del ruido"* → abre hilo con `create_feedback_thread`, sin pedir permiso.
21. *"Muéstrame la planilla de habitaciones"* → `navigate` a la vista de habitaciones.

### Limpieza (3)
22. *"¿Qué me toca limpiar hoy?"* → `get_housekeeping_status` (tareas, no molestar, cambios de lencería).
23. *"Marca la 14 como hecha"* → confirma y `set_housekeeping_done`.
24. *"Crea una tarea extra: revisar mancha en alfombra de la 21"* → confirma y `create_housekeeping_task`.

### Cualquier rol / voz (1)
25. En el móvil: *"Betan, ¿ha entrado alguna reserva nueva en las últimas 2 horas?"* → `get_new_bookings`; respuesta de 1-2 frases, leída en voz alta por el teléfono.

---

## 18. Qué lo hace diferencial frente a la competencia (5 argumentos de venta)

1. **Es un agente que actúa, no un chat que contesta.** Lee y escribe sobre 84 funciones reales del PMS (check-in, pagos, ampliaciones, limpieza, precios, puertas) con confirmación y por rol; la competencia suele ofrecer "asistentes" que sólo redactan textos o responden FAQ sin tocar el sistema.
2. **Seguridad por diseño, sin fiarse del modelo.** Permisos validados en el servidor, confirmación obligatoria, una entidad por acción, imposibilidad de contactar a huéspedes, datos financieros devueltos como `null` a quien no corresponde. Es la respuesta a "¿y si la IA se equivoca o la engañan?": el daño posible está acotado por arquitectura.
3. **Gerente proactivo con estrategia del negocio incorporada.** Briefing matutino, chequeo diario, mensajes "importantes" con acuse de lectura, tareas programadas en lenguaje natural, resumen diario por email con gráfico, avisos de eventos de alto impacto: trabaja aunque nadie le pregunte, y la política comercial del hotel (ocupación, precios, bloqueos) vive en su prompt y es editable.
4. **Pricing con contexto real de mercado.** Cruza ocupación, ADR real, competidores (incluyendo "agotado"), eventos locales y el **efecto medido** de cada regla dinámica (72 h antes/después) y cuestiona los cambios de precio. Esto convierte la IA en palanca directa de ingresos (RevPAR), no en un adorno.
5. **Multicanal, barato y auditable.** Chat, voz en el navegador (sin coste), app Android con wake word, bandeja interna de mensajes; Haiku 4.5 con prompt caching mantiene el coste en céntimos por consulta (con coste registrado por llamada), cambiable a RunPod/Ollama para soberanía de datos; consola de debug con traza completa, logs en vivo, historial por sesión y revisión de la actividad del staff.

---

## 19. Limitaciones (a tener en cuenta antes de venderlo)

- **Un solo modelo en producción** (Haiku 4.5): rápido y barato, pero puede equivocarse en razonamientos largos o comparativas complejas; los backends RunPod/Ollama son menos fiables eligiendo tools. Dependencia de un proveedor externo (Anthropic) y de su disponibilidad: sin crédito o con rate limit, el agente responde con un mensaje de indisponibilidad.
- **Sin memoria semántica a largo plazo**: sólo historial reciente (5 sesiones listadas) y los datos del sistema. No "aprende" preferencias de forma autónoma.
- **Conversación en cliente**: el servidor no conserva el hilo; si el cliente pierde el historial se pierde el contexto de esa conversación (el historial persistente sólo guarda turnos finales).
- **Acoplamiento al hotel de origen**: parte del system prompt contiene reglas y nombres específicos del Hotel Betania (tarifa "Dir AL", canal Agoda, ciudad Benalmádena/Málaga en eventos, hoteles competidores, app de piscina externa, `set_sale_price` fijo a una tarifa/tipo). Para otro cliente hay que **parametrizarlos** (ver `docs/03-DESACOPLAMIENTO-HOTEL.md`).
- **Un único tool de cambio de precio, limitado** a una tarifa y tipo de habitación; no hay edición masiva de precios por voz (decisión de seguridad, pero limita).
- **Clasificación de eventos por palabras clave**, no por aforo ni histórico de demanda; SerpAPI tiene cuota de pago.
- **Prompt injection**: sin filtro específico (ver sección 16); mitigado por permisos y confirmación, no eliminado.
- **Alcance de voz**: la voz del panel depende del navegador (los que implementan la API, p. ej. Chrome); la app Android es un proyecto aparte (`betania-apk`) y usa token estático (si se filtra, equivale al rol configurado; conviene rotarlo y limitar el rol de `VOICE_APP_USER_ID`).
- **Las respuestas de voz son deliberadamente breves**, lo que obliga a pedir detalle expresamente.
- **Escrituras desatendidas**: las tareas programadas ejecutan con `confirmed=true` automático; un prompt mal redactado puede enviar mensajes al personal repetidamente (sólo personal, no huéspedes).
- **No hay tool de mensajería a huéspedes** (intencionado): el agente no sustituye la comunicación guest-facing, sólo ayuda a redactarla.
- **Los datos de piscina/mantenimiento** dependen de una app externa de terceros; si no está configurada el agente lo dice, pero no puede suplirlos.
- **Revisión legal/RGPD**: el historial de chat y `get_staff_ai_activity` implican tratamiento de conversaciones del personal; informar a los empleados y fijar política de retención.
