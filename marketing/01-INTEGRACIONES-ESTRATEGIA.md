# 01 · Estrategia de integraciones ("super integraciones")

> Fecha: 2026-10-02 · Autor: Fran + Claude · Estado: borrador para decidir
>
> Tesis: un hotel pequeño no compra "otro PMS"; compra **que las cosas que ya tiene
> (cerraduras, TPV, gestoría, channel manager, Policía) dejen de pedirle trabajo manual**.
> Amenitiz, Cloudbeds o Mews integran mucho, pero desde un marketplace y en inglés. Nuestra
> ventaja realista: **integraciones instaladas y probadas en la puerta del cliente por alguien
> de la zona**, empezando por la cerradura. Lo que no es ventaja: competir en número de
> conectores. No vamos a tener 400. Vamos a tener los 15 que usa un hotel de 20 habitaciones
> en la Costa del Sol, y que funcionen.

---

## 1. Lo que YA existe en producción (Betania)

| Área | Integración | Cómo está hecha hoy | Madurez | Comentario honesto |
|---|---|---|---|---|
| Cerraduras | **TTLock** (cloud EU, `euapi.ttlock.com/v3`) | Passcodes con validez por estancia, alta/baja de tarjetas IC por API, borrado al checkout | Alta | En Betania funciona en modo offline/passcode. Para clientes: **gateway G2 siempre** (revocación real y logs) |
| Cerraduras / control de accesos | **ZKTeco** | Bridge propio (HTTP) con: abrir puerta, alta/revocación de tarjetas, sync, eventos | Media | El bridge corre en la LAN del hotel → hay que empaquetarlo (Docker/Raspberry) para replicarlo |
| Channel manager | **Nobeds** (`api.nobeds.com`) | Reservas, disponibilidad, bloqueos de fechas | Alta | Barato (≈10 €/mes) pero menos conocido que SiteMinder; es el canal "por defecto" |
| PMS legacy | **FrontDesk Master** (FDM) | Push de reservas/tarifas + script de migración | Media | Argumento potente: "**coexistimos con tu PMS actual** mientras migras" |
| Distribución B2B | **Jumbo** (precios, disponibilidad, stop sales) | Push | Alta | Específico de Betania → pasarlo a configuración |
| Pagos | **Stripe** (checkout, webhooks, cobro de ampliaciones) | API + webhook | Alta | Cada cliente con SU cuenta Stripe (Connect no necesario al principio) |
| Policía | **SES Hospedajes** (SOAP, XML zip base64, alta/consulta/anulación de lotes) | Directo al Ministerio | Alta | Diferencial real: la mayoría de PMS pequeños lo delegan en Chekin u otro tercero de pago |
| Mensajería | **WhatsApp Cloud API (Meta)** | Plantillas + conversación | Alta | Plantillas `betania_*` → renombrar por instancia |
| Email | SMTP/servicio de email | Confirmaciones, recuperación carritos/cancelaciones | Alta | — |
| Mantenimiento | **Control de piscina** (app Flask propia: cloro, gas, depósitos, agua fría/caliente, incidencias) | API de solo lectura con API key | Media | Es una "integración con sistema interno" ya demostrable en demo |
| Mercado | SerpAPI (precios de competidores) | Scraping vía API | Media | Coste variable por consulta |
| IA | Agente con ~80 tools (chat, voz, app Android), visión para DNI | LLM por API | Alta | El agente es en sí un "integrador": todo lo integrado es accionable por voz |

**Conclusión:** ya tenemos el núcleo que el 90 % de competidores pequeños NO trae de serie:
cerradura + SES directo + WhatsApp + cobro, todo encadenado. El trabajo de integraciones
ahora no es "añadir cosas", es **(a) convertir lo de Betania en adaptadores reutilizables y
(b) cubrir las 3-4 marcas de cerradura y los 2-3 sistemas internos que pidan los primeros
5 clientes.**

---

## 2. Cerraduras: mapa de proveedores

Leyenda de dificultad: Fácil = 1-3 días · Media = 4-8 días · Difícil = > 2 semanas o requiere acuerdo comercial/certificación.

| Marca | Segmento | Tipo de integración | Qué permite por API | Requisitos / certificación | Coste hardware orientativo | Dificultad | Prioridad |
|---|---|---|---|---|---|---|---|
| **TTLock / TTHotel** (fabricantes OEM chinos) | Pequeño hotel, hostal, VUT | Open Platform cloud (REST OAuth) + SDK BLE | Passcodes (temporales, periódicos, offline algorítmicos), tarjetas IC, huella, apertura remota (con gateway), logs | Registro gratuito en open platform; sin certificación | Cerradura hotel RFID 60-150 € · gateway G2 30-50 € · tarjetas ~1,5 € | Fácil (hecho) | **1 — ya está; empaquetar** |
| **ZKTeco** | Control de accesos, tornos, lectores de pared, algunas cerraduras hotel | SDK/PULL SDK en LAN + bridge propio | Tarjetas, apertura, eventos | Sin certificación; requiere bridge local | Lector/controladora 80-300 € | Media (hecho, falta empaquetar) | **2 — puertas comunes/garaje** |
| **Nuki** | VUT, apartamentos, puerta de calle | Web API (REST) + Smart Hosting Service | Autorizaciones con ventana temporal (keypad/app), apertura, logs, webhooks | Smart Hosting **69 €/año por cerradura**; Smart Lock Pro ≈269 € (Wi-Fi integrado) | 230-300 € + keypad 60-80 € | Fácil | **3 — aparthoteles y VUT (fase 4)** |
| **igloohome** | VUT, candados/cajas de llaves, puertas | REST API (iglooaccess) | **algoPIN**: PIN offline generado por algoritmo (sin gateway), PIN por rango de fechas, Bluetooth keys | API ≈ **2 $/cerradura activa/mes** (iglooworks enterprise ≈5 $) | 150-300 € | Fácil | 4 |
| **Tedee** | Retrofit sobre cilindro europeo, VUT | Cloud API (REST, OAuth/PAT) | Accesos temporales, PIN en Keypad, apertura, logs | Sin cuota obligatoria | Lock 250-300 € + Keypad Pro ≈129 € + bridge | Fácil | 5 |
| **Yale** (Linus/Conexis, ecosistema ASSA ABLOY / August) | Doméstico, VUT | Vía partners/Seam; API pública limitada | PIN temporales, apertura | Acceso API directo restringido → usar agregador | 200-350 € | Media | 7 (vía Seam) |
| **Akuvox** | Portero/intercom IP en puerta principal | HTTP API local + Akuvox Cloud/SmartPlus; SIP | Alta de PIN/tarjeta temporal, apertura de puerta, videollamada a recepción o al móvil | Sin certificación para API local | Intercom 150-600 € | Media | **6 — "llega fuera de horario, llama al portero, la IA contesta"** |
| **Salto** (KS cloud / Space on-prem / Homelok) | Hotel medio-alto, cadenas | **KS Connect API** (cloud) / Space PMS interface (protocolo propio) | Llaves móviles, tarjetas, accesos | Acceso a la API **por plan de integración acordado con Salto** (partner); hardware por instalador Salto | 250-600 $/puerta + suscripción KS | Difícil | 8 — solo si un cliente ya tiene Salto |
| **dormakaba** (Ambiance / Saflok / Quantum) | Hotel medio-alto | Ambiance: LGS REST API, Web Services/TCP/Serial; requiere certificado de seguridad por instalación | Codificación de tarjetas, llaves móviles | Alta como partner (partner.lgs@dormakaba.com) + certificado por hotel | 300-600 €/puerta | Difícil | 9 — bajo demanda |
| **ASSA ABLOY Vostio / Visionline** | Hotel medio-alto, cadenas | Vostio Guest API (cloud) + **PMS Converter 4020** (traduce protocolos PMS legacy a la API) | Tarjetas, llaves móviles | Certificados de la CA de ASSA ABLOY; acuerdo con distribuidor | 300-600 €/puerta | Difícil | 10 — bajo demanda |
| **Onity** (Honeywell → HT22/HT24/HT28, DirectKey) | Hoteles 90-2000 con sistema antiguo | Protocolo PMS por serie/TCP (manual "PMS Communications Protocol") | Codificar tarjeta al check-in | Encoder + PC del hotel; documentación vía distribuidor | Ya instalado (no se vende) | Difícil | 11 — **oportunidad**: hoteles viejos con Onity que no quieren cambiar puertas |
| **RFID genéricos chinos** (Hune, Be-Tech, Orbita, "hotel lock system") | Hostales low-cost | DLL de codificador USB en Windows (sin cloud) | Codificar tarjeta | Pedir SDK/DLL al fabricante | 40-90 €/puerta | Media (agente Windows local) | 12 — solo si hay volumen |

### Atajo a valorar: agregadores (Seam y similares)
- **Seam** unifica >30 marcas (Nuki, igloohome, Yale, August, Salto KS, dormakaba Ambiance, TTLock, etc.) con una sola API.
- Precio publicado: **≈5 $/dispositivo/mes** (plan "Unit Access", 5 acciones/día) — 50 $ en alto tráfico.
- Para 20 puertas = ~100 $/mes → **se come casi toda la mensualidad**. Úsalo solo como puente para marcas
  "difíciles" (Salto KS, dormakaba, Yale) cuando un cliente ya las tenga y pague el sobrecoste (repercutir 6-8 €/puerta/mes).
- Regla: **marca que vendemos nosotros = integración directa** (TTLock, Nuki, igloohome). **Marca que ya tiene el cliente = Seam primero, directa si hay 3+ clientes.**

### Orden recomendado (cerraduras)
1. **TTLock con gateway** — es lo que instalamos. Hardware barato, sin cuotas, API abierta. Producto estándar del "pack cerradura".
2. **ZKTeco empaquetado** (bridge en Raspberry/mini-PC con Docker) — puertas comunes, garaje, gimnasio.
3. **Akuvox** — portero de la puerta principal con PIN de estancia: cierra el ciclo "check-in autónomo" en edificios con portal.
4. **Nuki** y **igloohome** — para aparthoteles/VUT y para quien no quiere RFID.
5. **Tedee** — retrofit sin cambiar cerradura.
6. **Seam como comodín** para Salto KS / dormakaba / Yale.
7. **Onity / Vostio / Saflok legacy** solo con un cliente pagando el desarrollo (≥ 2.000 € de setup extra).

### Producto "pack cerradura" (lo que se vende)
- Cerradura RFID/teclado TTLock + **gateway G2 por planta/zona** + 10 tarjetas por puerta + instalación en puerta europea estándar.
- Flujo vendido: reserva → pago Stripe → SES enviado → WhatsApp con PIN válido check-in 15:00 a checkout 12:00 → PIN revocado → housekeeping avisado.
- Instalación física: **con un cerrajero/instalador partner** (tú no eres cerrajero ni tienes seguro de obra). Tú das alta, pruebas y formación.

---

## 3. Sistemas internos del hotel: mapa

| Sistema | Proveedores típicos en hotel pequeño ES | Cómo se integra | Valor para el hotel | Dificultad | Prioridad |
|---|---|---|---|---|---|
| **Pasarela de pago** | Stripe (hecho), **Redsys** (TPV virtual del banco: CaixaBank, Santander, BBVA, Unicaja…) | Redsys: REST/redirección con firma HMAC-SHA256; tokenización (pago por referencia) para cargos posteriores | Muchos hoteleros andaluces **tienen ya Redsys con comisión negociada** y no quieren Stripe | Media 3-5 d | **ALTA** |
| **Facturación electrónica / Verifactu** | Propio o vía API (B2Brouter, Verifacti, etc.) | Registro de facturación encadenado (hash), QR, envío AEAT; o delegar en ERP | **Obligatorio**: sociedades 1-ene-2027, autónomos/resto 1-jul-2027. Si el PMS emite facturas, **es SIF y su productor debe firmar declaración responsable** | Media/Difícil 8-12 d (vía API de tercero) | **CRÍTICA** |
| TicketBAI / Navarra | Solo País Vasco/Navarra | API foral | Fuera del ICP | Difícil | Ninguna |
| Factura electrónica B2B (Ley Crea y Crece) | Facturae/UBL vía plataforma | Reglamento aún con calendario escalonado | Agencias/empresas que facturan al hotel | Media | Media (2027) |
| **Contabilidad / ERP** | **Holded**, Sage 50/200, **A3 (Wolters Kluwer, lo usan las gestorías)**, Contasol, Quipu | Holded: REST API + webhooks · A3/Sage: export de asientos (fichero) | La gestoría deja de picar facturas → **argumento para entrar vía gestorías** | Fácil Holded 2-3 d · Fácil export A3/Sage 2 d | ALTA |
| **TPV / POS** | **Revo XEF** (muy usado en España; ya integra con Mews/Sihot), **Lightspeed K-Series** (REST+OAuth), Ágora, ICG, Glop | Cargo a habitación (room posting), consulta de huésped, cierre diario | Desayunos, bar, piscina → cargar a la habitación y cobrar al checkout | Media 4-6 d por TPV | Media-Alta (si hay restaurante) |
| **Channel managers** | Nobeds (hecho), **Beds24** (API abierta, barato), **SiteMinder** (pmsXchange, requiere aprobación + certificación), **Cloudbeds** (API marketplace), Channex (white-label) | Disponibilidad/tarifas/reservas | El cliente que ya tiene SiteMinder no quiere cambiarlo | Beds24 Media 4-6 d · SiteMinder Difícil (proceso de partner: meses) · Channex Media | Beds24 ALTA · SiteMinder baja hasta 5 clientes |
| iCal | Airbnb, Booking (VUT) | Feeds iCal import/export | Tier VUT barato sin channel manager | Fácil 1-2 d | Media (fase 4) |
| **SES Hospedajes** | Ministerio del Interior | SOAP (hecho) | Obligatorio desde dic-2024, 24 h | Hecho | — |
| **Mossos d'Esquadra / Ertzaintza** | Cataluña / País Vasco (sistemas propios) | Fichero/servicio propio | Fuera de la zona | Media | Baja (solo si cliente fuera de Andalucía) |
| **PMS legacy** | **FrontDesk Master** (hecho), Hotelogix, Ulyses Cloud, Avirato, Hotelgest, Opera/Protel (no ICP) | API si existe; si no, export CSV/Excel de reservas futuras y clientes | **Migración sin dolor** + modo coexistencia temporal | Media 2-5 d por PMS (migración) | ALTA (migración, no sync permanente) |
| **Domótica / energía** | Shelly, Tuya/Smart Life, Home Assistant, termostatos Netatmo/Tado, control HVAC (Daikin, Mitsubishi vía Intesis) | REST cloud (Shelly/Tuya) o MQTT local vía Home Assistant | **Apagar clima de habitaciones no vendidas / tras checkout** → ahorro medible en factura | Fácil Shelly/HA 2-3 d | **ALTA en verano** (argumento de ahorro con números) |
| **Centralita VoIP** | 3CX, Yeastar P-Series (ya integra Akuvox), Grandstream UCM | API/CTI: pop-up de huésped en llamada, room status desde teléfono, despertador, llamadas → agente IA de voz | Recepción virtual nocturna | Media 4-6 d | Media |
| **TV del hotel** | Samsung LYNK/HBrowser, LG Pro:Centric, Chromecast | Mensaje de bienvenida con nombre, info del hotel | "Wow" barato pero no decide la compra | Media | Baja |
| **Control de piscina / mantenimiento** | App propia de Betania; sondas de cloro/pH | REST (hecho, solo lectura) | Registro sanitario (obligatorio en piscinas de uso colectivo) | Hecho para Betania; generalizar = Media | Media |
| **Minibar** | Manual / bandeja con hoja | QR de habitación (ya existe) → cargo en estancia | Captura de consumos olvidados | Fácil 1-2 d (sobre lo existente) | Media |
| **Parking** | Barreras con relé, cámaras ANPR (Hikvision, Dahua) | Shelly/relé o ZKTeco para barrera; ANPR por webhook | Acceso por matrícula durante la estancia | Media 3-5 d | Baja-Media |
| **Wi-Fi / portal cautivo** | UniFi, Mikrotik, Ruckus | Vouchers por estancia vía API | Clave Wi-Fi en el WhatsApp de bienvenida | Fácil 2 d (UniFi) | Media |
| **Protocolo FIAS (Oracle)** | Estándar de interfaces de hotel (PBX, TV, minibar, cerraduras legacy) | Servidor TCP FIAS | **Un único desarrollo abre decenas de sistemas legacy** | Difícil 10-15 d | Futuro (fase 3+) |

---

## 4. Arquitectura propuesta: "Integration Hub"

### Principios
1. **El núcleo no conoce marcas.** Habla con *capacidades*: `LockProvider`, `ChannelProvider`, `PaymentProvider`, `InvoiceSink`, `PoliceReporter`, `PosProvider`, `EnergyProvider`.
2. **Todo es un evento.** El dominio emite eventos; los adaptadores se suscriben.
3. **Configuración por instancia** (tabla `integrations`: `provider`, `enabled`, `credentials` cifradas, `settings` JSON, `last_ok_at`, `last_error`).
4. **Idempotencia + reintentos** (outbox en Postgres; no colas externas hasta que haga falta).
5. **Observabilidad**: cada llamada externa a `integration_log` (proveedor, operación, latencia, resultado). Panel "Salud de integraciones" en dirección. Esto es lo que vende confianza.

### Esquema

```
                ┌───────────────────────────── betan-bm (instancia por cliente) ─────────────────────────────┐
                │                                                                                            │
 Reservas web ─▶│  Dominio (reservas, estancias, facturas, housekeeping)                                     │
 Agente IA    ─▶│         │ emite eventos                                                                    │
 Recepción    ─▶│         ▼                                                                                  │
                │  ┌──────────────┐   outbox (Postgres)   ┌────────────────── Integration Hub ───────────┐   │
                │  │ Event bus    │ ────────────────────▶ │ Router de eventos → Adaptadores por capacidad │   │
                │  └──────────────┘                       │                                               │   │
                │                                         │ LockProvider:  ttlock | zkteco | nuki |      │──▶ Cerraduras
                │                                         │                igloo | tedee | seam | akuvox │   │
                │                                         │ ChannelProvider: nobeds | beds24 | ical |    │──▶ OTAs
                │                                         │                  siteminder* | jumbo         │   │
                │                                         │ PaymentProvider: stripe | redsys            │──▶ Pagos
                │                                         │ InvoiceSink:  verifactu-api | holded |       │──▶ AEAT / gestoría
                │                                         │               a3-export | sage-export        │   │
                │                                         │ PoliceReporter: ses | mossos* | ertzaintza*  │──▶ Interior
                │                                         │ PosProvider: revo | lightspeed               │──▶ TPV
                │                                         │ EnergyProvider: shelly | homeassistant       │──▶ Clima/luz
                │                                         │ Messaging: whatsapp | email | sms            │──▶ Huésped
                │                                         └───────────────┬──────────────────────────────┘   │
                │                                                         │                                  │
                │  API pública REST /api/v1 (OpenAPI 3.1) ◀── API keys por partner, scopes, rate limit        │
                │  Webhooks salientes (firma HMAC, reintentos exponenciales, panel de entregas)               │
                └────────────────────────────────────────────────────────────────────────────────────────────┘
       * = bajo demanda
```

### Contratos mínimos (TypeScript)

```ts
interface LockProvider {
  id: 'ttlock' | 'zkteco' | 'nuki' | 'igloo' | 'tedee' | 'seam' | 'akuvox'
  capabilities: Array<'pin' | 'card' | 'remote_open' | 'offline_pin' | 'logs'>
  grantAccess(i: { lockRef: string; guestName: string; from: Date; to: Date; kind: 'pin' | 'card' }): Promise<{ credentialRef: string; pin?: string }>
  revokeAccess(i: { lockRef: string; credentialRef: string }): Promise<void>
  health(): Promise<{ ok: boolean; battery?: number; online?: boolean }>
}

interface InvoiceSink {
  id: 'verifactu-api' | 'holded' | 'a3-export' | 'sage-export'
  pushInvoice(inv: InvoiceDTO): Promise<{ externalRef: string; qr?: string }>
  pushCreditNote(cn: CreditNoteDTO): Promise<{ externalRef: string }>
}
```

### Eventos del dominio (catálogo inicial = también webhooks públicos)
`reservation.created` · `reservation.modified` · `reservation.cancelled` · `payment.succeeded` · `payment.refunded` ·
`guest.checked_in` · `guest.checked_out` · `police_report.sent` · `police_report.failed` · `access.granted` · `access.revoked` ·
`room.status_changed` (sucia/limpia/inspeccionada/fuera de servicio) · `invoice.issued` · `folio.charge_posted` · `lock.battery_low` · `integration.failed`

### API pública / OpenAPI para terceros
- `GET/POST /api/v1/reservations`, `/availability`, `/rates`, `/guests`, `/rooms/status`, `/folios/{id}/charges` (para TPV), `/webhooks`.
- Auth: API key por partner + scopes (`reservations:read`, `folio:write`…). Rate limit por key.
- Generar `openapi.json` desde los esquemas (zod → OpenAPI) y publicar documentación (Scalar/Redoc) en `docs.betan-bm.*`.
- Esto permite decir: "**si tu proveedor de X quiere integrarse, aquí está la API**" — y que el instalador/partner haga el trabajo, no tú.

---

## 5. Roadmap de integraciones — 90 días (oct-dic 2026)

Supuesto: 1-2 h/día entre semana + 4-6 h en finde ≈ **12-15 h/semana ≈ 2 "días-dev" por semana**. 90 días ≈ 25 días-dev reales. No cabe todo: esto es lo que cabe, priorizado.

| # | Semana | Entregable | Esfuerzo (días-dev) | Por qué ahora |
|---|---|---|---|---|
| 1 | S1-S2 | **Hub mínimo**: interfaces `LockProvider`/`ChannelProvider`/`PaymentProvider`, tabla `integrations` por instancia, `integration_log`, mover TTLock/ZKTeco/Nobeds/Stripe/SES detrás de adaptadores (sin cambiar comportamiento) | 4 | Sin esto cada cliente = fork. Va en paralelo al desacoplamiento de `PROPERTY_ID` |
| 2 | S2 | **TTLock con gateway** para clientes: apertura remota, batería, logs, alerta `lock.battery_low` | 1,5 | Producto del pack cerradura |
| 3 | S3 | **Bridge ZKTeco empaquetado** (Docker en mini-PC/RPi + túnel saliente; nada de abrir puertos del router del cliente) | 2 | Replicable en otro hotel |
| 4 | S3-S4 | **Panel "Salud de integraciones"** (último OK, último error, reintentar) | 1,5 | Lo enseñas en la demo; reduce soporte |
| 5 | S4-S5 | **Redsys** (redirección + tokenización para cobro de extras) | 3 | Objeción nº1 de hotel andaluz: "yo ya tengo TPV del banco" |
| 6 | S5-S7 | **Verifactu vía API de tercero** (registro, QR en factura, rectificativas) + export A3/Sage | 6 | Obligatorio 2027. Si el primer cliente factura desde betan-bm, no es opcional |
| 7 | S7 | **Holded** (facturas + contactos) | 2 | Entrada por gestorías |
| 8 | S8 | **Webhooks salientes firmados + OpenAPI v1 (lectura)** | 3 | Partners e instaladores |
| 9 | S9 | **Nuki** (o igloohome, el que pida el primer aparthotel) | 2 | Abre aparthoteles/VUT |
| 10 | S10 | **Shelly / Home Assistant: clima off en habitación libre** + informe de ahorro | 2,5 | Argumento de ROI en euros |
| 11 | S11-S12 | **Beds24** como channel manager alternativo | 4 | Cliente que no quiere Nobeds |
| 12 | S12-S13 | Migrador genérico CSV/Excel desde PMS legacy (Ulyses, Avirato, Hotelgest, Hotelogix) | 2 | Quita la barrera de cambio |
| | | **Total** | **≈ 34 días-dev** | Excede 25 → **recortar 9-12 si el piloto no lo pide** |

**Regla de recorte:** lo que no haya pedido un prospecto real en una demo, se mueve al trimestre siguiente.
Las únicas no negociables son 1, 2, 4 y 6 (Hub, TTLock gateway, salud, Verifactu).

### Integraciones que NO hacer en 90 días (y por qué)
- **SiteMinder certificado**: proceso de partner con aprobación previa, formularios y certificación — meses. Con < 5 clientes no compensa. Si un cliente lo tiene: que siga con SiteMinder conectado a Nobeds/Beds24 o migre.
- **Salto / dormakaba / Vostio / Onity directos**: requieren acuerdos y certificados por hotel. Vía Seam bajo demanda, cobrado aparte.
- **FIAS**: potente pero 2-3 semanas; solo con un cliente con PBX/TV legacy que lo pague.
- **TV, minibar automático, parking ANPR**: "nice to have", no deciden la compra.

---

## 6. Cómo venderlo (mensaje)

- "**Tu cerradura, tu TPV, tu gestoría y la Policía hablan solas con tu PMS.** Te lo instalo yo, aquí, y si algo falla me ves la cara."
- Demostración en vivo: crear reserva → pago → SES enviado → WhatsApp con PIN → abrir la cerradura de la mesa de demo (llevar **una TTLock + gateway montada en un tablero** a cada demo; coste ~150 €, vale oro).
- Panel de salud de integraciones en pantalla: transmite control.

---

## Fuentes

- TTLock integraciones / TTHotel: https://ttlock.eu/integrations/ · https://ttlock.eu/tthotel/ · https://github.com/ttlock · https://www.cloudbeds.com/integrations/ttlock/
- Seam pricing: https://www.seam.co/pricing · https://www.seam.co/solutions/hospitality
- Salto KS: https://hoteltechinsight.com/smart-locks/salto/ · https://develop--saltoks.netlify.app/integrations/
- Nuki API y Smart Hosting: https://nuki.io/en/b2b/short-term-rentals/api/ · https://nuki.io/en-se/discover-nuki/for-your-vacation-rental/pricing · https://guestintro.com/blog/best-smart-locks-for-european-holiday-rentals-2026
- igloohome API: https://www.igloohome.co/developers · https://igloocompany.stoplight.io/docs/igloohome-api/d9683e9f1bb3c-igloohome-api
- Tedee: https://tedee.com/product/tedee-keypad-pro-black/ · https://tedee.com/shop/
- ASSA ABLOY Vostio / PMS Converter: https://docs.vostio.assaabloy.com/setup_user_guide/ · https://docs.dev.vostio.assaabloy.com/_astro/pms_manual.Bu0a2nvq.pdf
- dormakaba Ambiance: https://www.sabeeapp.com/knowledge-base/dormakaba-connection-guide · https://docs.seam.co/device-and-system-integration-guides/dormakaba-ambiance-access-control-system/dormakaba-ambiance-setup-guide
- Onity: https://www.stayntouch.com/integrations/onity
- Akuvox: https://help.yeastar.com/en/p-series-cloud-edition/integrations/akuvox/akuvox-ip-intercom-integration-overview.html · https://www.minut.com/integrations/akuvox
- SiteMinder API/certificación: https://developer.siteminder.com/siteminder-apis/welcome/integration-process · https://developer.siteminder.com/siteminder-apis/pms-rms/introduction
- Holded API: https://www.holded.com/es/desarrolladores
- Revo XEF + PMS: https://www.mews.com/products/marketplace/revo · https://finder.sihot.com/products/REVO
- Lightspeed Restaurant API: https://supergood.ai/docs/lightspeed-restaurant-api
- Verifactu calendario 2027: https://www.infobae.com/espana/2025/12/02/hacienda-aplaza-hasta-2027-la-obligacion-de-facturar-con-verifactu-para-autonomos-y-pymes/ · https://www.verifactu.com/el-nuevo-calendario-de-verifactu-guia-tras-el-aplazamiento-a-2027/
- SES Hospedajes / Mossos / Ertzaintza: https://chekin.com/blog/todo-lo-que-necesitas-saber-sobre-ses-hospedajes/ · https://layla.eco/es/blog/real-decreto-933-2021-y-ses-hospedajes-guia-2026-layla
- Integraciones PMS 2026 (panorama): https://hoteltechinsight.com/2026/04/23/hotel-pms-integration-guide-2026/ · https://www.stayntouch.com/articles/hotel-pms-open-api-2026
- Código propio revisado: `src/lib/ttlock.ts`, `zkteco.ts`, `nobeds.ts`, `ses.ts`, `whatsapp.ts`, `poolControl.ts`, `fdm-push.ts`, `jumbo-push.ts`

> Nota: precios de hardware son orientativos (rangos de mercado/distribuidor) — pedir presupuesto a 2 distribuidores TTLock en España antes de fijar el precio del pack.

---

## Resumen (10 líneas)

1. Ya tenemos lo que más vende: TTLock + ZKTeco + SES directo + WhatsApp + Stripe, encadenados.
2. Pack cerradura TTLock: hardware 60-150 €/puerta + gateway 30-50 € → se vende a 250-350 €/puerta instalada.
3. Nuki: ~269 € + 69 €/año Smart Hosting; igloohome API ~2 $/cerradura/mes; Tedee sin cuota.
4. Seam (agregador) ~5 $/puerta/mes: solo como comodín para Salto/dormakaba/Yale, repercutido 6-8 €/puerta/mes.
5. Salto, dormakaba, Vostio, Onity: requieren acuerdo/certificado → bajo demanda, setup extra ≥ 2.000 €.
6. Verifactu obligatorio 1-ene-2027 (sociedades) y 1-jul-2027 (resto): 6 días-dev vía API de tercero, prioridad crítica.
7. Redsys (3 d) y Holded/A3 (4 d) son las integraciones "internas" que más objeciones quitan.
8. Integration Hub: adaptadores por capacidad + outbox + webhooks firmados + OpenAPI v1.
9. Roadmap 90 días ≈ 34 días-dev para ~25 disponibles → recortar lo que no pida un prospecto real.
10. No hacer todavía: SiteMinder certificado, FIAS, TV, parking ANPR.
