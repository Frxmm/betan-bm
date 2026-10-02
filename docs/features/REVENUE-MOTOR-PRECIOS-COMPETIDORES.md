# Revenue management: motor de precios dinámicos y competidores

Documento de profundización de las secciones 6 (Tarifas y reglas dinámicas), 7 (Competidores), 8 (Recuperación y descuento temporal) y 22 (Informes) de `01-FUNCIONALIDADES.md`. Describe qué hace realmente el código (leído en `src/lib/`, `src/routes/` y `frontend/views/`), con ejemplos numéricos ilustrativos. Los números de los ejemplos son inventados para explicar la mecánica; no son datos reales del Hotel Betania.

Convenciones: "Dir AL" es la tarifa raíz del hotel (código `Dir AL`, localizada por código en `dirAlRate.ts`); "Doble" es el tipo de habitación base (id 1); "pasada" es una ejecución del motor de reglas.

---

## 1. Modelo de tarifas y precios

### 1.1 Entidades

| Concepto | Tabla / campo | Qué hace |
|---|---|---|
| Tarifa | `rates` | Código, título, `activeForBookingEngine` (visible en la web), `locked` (bloqueada contra edición), `userEditable`, operador asociado, `roomTypeId` opcional (tarifa de un solo tipo), política de cancelación, `minStay` (def. 1) y `maxStay`. |
| Derivación de tarifa | `rates.baseRateId` + `adjustType` + `adjustValue` | La tarifa deriva de otra y su precio es el de la base más un ajuste. Cadena de hasta 6 niveles con protección anti-ciclos (`buildDerivationChain`). |
| Tipo de habitación | `room_types` | Un tipo puede derivar de otro (`baseRoomTypeId`) con su propio ajuste (p. ej. "Doble Superior" = Doble + X). |
| Precio diario | `rate_daily_prices` | Una fila por tarifa × fecha × tipo de habitación (o `roomTypeId` nulo = precio genérico de la tarifa). Campos clave: `basePrice` (precio puesto a mano), `price` (precio vigente tras reglas), `closed` (cierre de venta), `manualOverrideAt` (marca de edición manual reciente). |
| Temporada | `seasons` | Rango de fechas con nombre, color y `minPrice`. |
| Disponibilidad forzada | `room_avail_overrides` | Fija a mano las unidades disponibles de un tipo en una fecha (sustituye al cálculo, no es un tope). |

Tipos de ajuste (`applyPriceAdjust`, en `price-resolver.ts`):
- `percentage`: base × (1 + v/100).
- `amount`: base + v (euros).
- `per_person`: base + v × ocupación del tipo de habitación.
- `fixed`: el resultado es v, independiente de la base. Una tarifa sin base con ajuste `fixed` es una tarifa de precio fijo propio.

### 1.2 Precios raíz, derivados y por tipo

Sólo hay un lugar con precio "de verdad" editable: la fila de la tarifa raíz para el tipo de habitación base. Todo lo demás se calcula:
- Un tipo de habitación derivado ignora cualquier fila propia que tenga en `rate_daily_prices` (puede haber quedado de antes o por error): siempre se calcula desde su tipo base. Por eso el calendario marca esas celdas como sólo lectura y el motor de reglas no las toca.
- Una tarifa derivada sin fila propia para una fecha hereda de su base con el ajuste. Si tiene fila propia (override en esa tarifa), manda la fila.

### 1.3 `resolvePrice` (el resolutor común)

`resolvePrice(tarifas, tipos, filas, rateId, roomTypeId, fecha, ocupación)` es la única función que calcula "cuánto cuesta" y la usan todos: calendario, motor de reservas web, panel interno, comparativa de competidores, push a canales y la regla de competidores. Así nunca hay dos cifras distintas para lo mismo (hubo un bug histórico por duplicar esta lógica, documentado en la cabecera del fichero).

Orden de resolución:
1. Si el tipo de habitación es derivado: resolver recursivamente el tipo base para la misma tarifa y aplicar el ajuste del tipo.
2. Si no, resolver la cadena de tarifa: tarifa con precio `fixed` y sin base → ese valor; si hay fila directa (tipo específico primero, luego genérica `roomTypeId` nulo) → esa fila; si no, subir a la tarifa base y aplicar el ajuste de la tarifa.

Ejemplo (ilustrativo, Doble 2026-10-10, ocupación 2):
- Dir AL, Doble: fila directa 80,00 EUR.
- JUMBO AL = Dir AL +31 % (cadena de tarifa): 80 × 1,31 = 104,80 EUR.
- Doble Superior = Doble +15 EUR (cadena de tipo): en Dir AL 95,00 EUR; en JUMBO AL 104,80 + 15 = 119,80 EUR.

Cuidado con el orden: primero se resuelve el tipo (base) y luego se aplica el ajuste del tipo sobre el resultado ya resuelto de la tarifa, no al revés.

Funciones auxiliares:
- `cheapestForRate`: el "desde X EUR" más barato de una tarifa entre sus tipos (misma cifra que ve un cliente nuevo en la web). La usan la comparativa de competidores y el motor.
- `invertRateChainToRoot` / `invertRoomTypeChainToBase`: la operación inversa. Dado el precio final deseado en una tarifa/tipo derivado, calculan qué precio hay que poner en la raíz para lograrlo. Devuelven `null` si algún eslabón es `fixed` (no depende de la base, no invertible). Son la pieza que permite a `competitor_undercut` y `sold_out_upsell` actuar sólo sobre Dir AL y que todo lo demás se propague solo.

### 1.4 Temporadas

`seasons`: nombre, `dateFrom`/`dateTo`, color y `minPrice`. Efecto real, verificado en `catalog.ts`:
- Al editar a mano el precio de una tarifa raíz (sin `baseRateId`), la API rechaza con 422 un precio inferior al `minPrice` de la temporada que cubre esa fecha (edición simple y bulk).
- El motor de reglas no consulta las temporadas: una regla de bajada puede dejar el precio por debajo del mínimo de temporada. El suelo real del motor es el ADR semanal (en `demand_pulse_dip`/`evening_clearance_dip`), no la temporada (ver limitaciones).

### 1.5 Estancia mínima/máxima

`minStay` y `maxStay` viven en la tarifa. En el motor de reservas web (`public.ts`) la tarifa se descarta como opción si las noches pedidas son menores que `minStay`, y se informa del mínimo al cliente. Se configuran en Tarifas > Tarifas (badge "≥Nn / ≤Nn" en la lista).

### 1.6 Overrides manuales

Todo lo que se edita a mano pasa por `upsertDailyPrice` (`catalog.ts`), con estos efectos:
- El precio editado pasa a ser `basePrice` (la nueva base del motor) y `price`.
- Se marca `manualOverrideAt = ahora`: las reglas respetan esa edición (ver sección 3.4).
- Si la tarifa es Dir AL, se borra el estado de `demand_pulse_state` de esa fecha, para que la "parada de reservas" no vuelva a aplicar el descuento acumulado antes de la edición manual sobre el precio nuevo.
- Se escribe `price_change_log` con `source = 'manual'` y el usuario.
- Cierre de venta (`closed`) por celda; edición en bloque por rango y tipo (`POST /rates/:id/prices/bulk`, máx. 365 entradas); borrado de override (vuelve al precio derivado/calculado, queda en el historial con `newPrice` nulo).
- Disponibilidad manual por tipo y fecha (`PUT /avail/:roomTypeId/:date`), que sustituye al cálculo y se respeta en calendario, Jumbo y FDM.
- Bloqueo/desbloqueo de tarifa completa (`/lock`, `/unlock`).

---

## 2. El calendario de precios (`PriceCalendarView.tsx`)

Cuatro pestañas: Calendario, Competidores, Historial y Configuración (admin: tarifas y tipos visibles por defecto y número de días).

Filas del calendario: una "Resumen propiedad" arriba, y por tipo de habitación su fila de disponibilidad y una fila por tarifa.

### 2.1 Fila resumen (ocupación y lead time)

Por día: unidades libres de toda la propiedad (sin aplicar los filtros visibles), % de ocupación coloreado y marcas de lead time.

Colores de ocupación (`occColor`, igual en el calendario, en el informe de Ocupación y en el PNG del email diario `occupancyChart.ts`):

| Ocupación | Color |
|---|---|
| >= 80 % | verde `#22c55e` |
| >= 60 % | azul `#3b82f6` |
| >= 40 % | ámbar `#f59e0b` |
| < 40 % | gris `#94a3b8` |

Marcas L6 / L28 / L64: el lead time medio de Booking.com (reservas hechas en los últimos 6, 28 o 64 días, filtradas al canal Booking) proyectado desde hoy. La marca "L28" cae exactamente en el día que apunta la regla `lead_time_dip` (con ventana de 28 días): el usuario ve en el calendario dónde está actuando esa regla.

### 2.2 Colores de las celdas de precio

Fondo/estado de la celda:
- Naranja: override puntual (con punto "●") sobre una fila propia.
- Azul: precio base (tarifa raíz sin override).
- Gris: precio derivado (de una tarifa base).
- "CERR": cerrada a la venta.
- Fin de semana y "hoy" con marcadores propios.
- "Sólo admin": tarifa bloqueada, no editable por el usuario o tipo derivado.

Color del propio número según el ADR semanal real (`adrClassFor`, CSS `pcal-adr-above/below`):
- Verde y negrita: precio listado por encima del ADR real de la semana ISO de esa fecha.
- Rojo y negrita: por debajo.
- Sin color: celda cerrada, sin precio, o semana sin ninguna noche ocupada todavía (el ADR es `null`, no 0, para no pintar "por encima" semanas futuras vacías).
El tooltip muestra "ADR real de la semana: X EUR".

### 2.3 ADR semanal real (`weeklyAdrByDate`)

Definición: ingresos ÷ noches ocupadas, agrupado por semana ISO. Los ingresos de una reserva se reparten a partes iguales entre sus noches (`total / nights`), cuentan los estados `confirmed`, `arriving`, `checked_in`, `checking_out`, `checked_out` (no `tentative`) y una reserva con habitaciones extra cuenta tantas noches-habitación como habitaciones. Es el ADR "en libros" (incluye reservas futuras de esa semana), no el ADR histórico cerrado.

Matiz importante (según la lectura del código): `weeklyAdrByDate(from, to)` sólo suma las noches comprendidas dentro de `[from, to]`. En el calendario eso es el rango visible; en `demand_pulse_dip` es hoy..hoy+3; en `evening_clearance_dip` el motor pide explícitamente de lunes a domingo para que sea de verdad semanal. Es decir, el suelo de ADR de `demand_pulse_dip` se calcula con las 4 noches de la ventana, no con la semana completa (ver limitaciones).

---

## 3. Motor de reglas dinámicas (`pricingRulesEngine.ts`)

### 3.1 Cómo funciona

- Frecuencia: arranca con el servidor (`startPricingRulesScheduler`, una pasada inmediata) y repite cada 30 minutos (`setInterval`). Si una pasada sigue en curso cuando toca la siguiente, ésta se omite (`omitida_por_solape`).
- Qué ajusta: sólo la tarifa raíz Dir AL (sólo su tipo base y, a efectos prácticos, "Doble"). Todo lo derivado (otras tarifas y tipos) se mueve solo por `resolvePrice`.
- Siempre parte de `basePrice` (el precio puesto a mano) y nunca del `price` ya ajustado: el ajuste no se acumula sobre sí mismo ni "se contagia" de una pasada a otra (salvo `demand_pulse_dip`, la única con memoria).
- Horizonte: 30 días (60 si `local_min_dip` está activa). "Hoy" y la hora son de `Europe/Madrid`.
- Ocupación: la de calendario (`computeCalendarOccupancyPct`): habitaciones físicas distintas (principal + `extra_room_ids`) + bloqueadas (`blocked_beds`) frente al total de activas, todos los estados salvo cancelled/no_show (incluye tentative del motor web) y respetando los overrides de disponibilidad (sustituyen al cálculo). Es el mismo número que ve el usuario en la fila resumen, no el del informe de Ocupación.
- Una regla activa por tipo: el código toma la primera regla activa de cada `ruleType` (`find`); una segunda regla del mismo tipo no se ejecuta.
- Tras la pasada, el motor empuja a Jumbo todo el horizonte (precio y disponibilidad, ver sección 7).

Pasos de una pasada: calcular ocupación → calcular, para cada regla activa, las fechas/precios objetivo → decidir una regla ganadora por fecha → recorrer las celdas de Dir AL del horizonte (omitiendo tipos derivados y celdas sin `basePrice`) → aplicar el objetivo (o revertir a la base si ninguna regla aplica) → registrar cambios → push a Jumbo.

### 3.2 Las 8 reglas

Campos de configuración comunes: `name`, `ruleType`, `thresholdPct` (umbral; en `booking_surge` son minutos), `adjustType` (`percentage` o `fixed`), `adjustValue`, `priority`, `active`. Campos específicos: `minAdrFloorPct`, `pulseSilenceMinutes`, `clearanceStartHour`, `clearanceOverrideMinutes`, `referenceRateId`, `sourceRoomTypeId`, `targetRoomTypeId`. `applyAdjust` redondea a céntimos y nunca baja de 0.

Hotel de ejemplo: 40 habitaciones; Doble en Dir AL a 80 EUR salvo indicación.

**1. `low_availability` (sube precio por escasez)**
- Condición: disponibilidad (100 − ocupación) < umbral, en cualquier día de hoy..hoy+30.
- Efecto: sube `adjustValue` (% o EUR) sobre la base.
- Ejemplo: umbral 15 %, +10 %. El día D tiene 36/40 habitaciones ocupadas, es decir 10 % libre: 10 < 15 → 80 × 1,10 = 88,00 EUR. Si sube a 38/40 sigue en 88 EUR (no escala: es todo o nada). Con `fixed` +8 EUR daría 88 EUR también.

**2. `lead_time_dip` (baja en el día del lead time medio)**
- Calcula el lead time medio de Booking.com: media de (check-in − fecha de reserva) de las reservas **hechas** (`bookedAt`) en los últimos 28 días. Lo redondea y actúa sólo sobre el día hoy + ese lead time.
- Condición: ocupación de ese día concreto < umbral.
- Ejemplo: lead medio 9,4 días → redondea a 9. Hoy es 2 oct → actúa el 11 oct. Umbral 60 %, −10 %. Si el 11 oct está al 35 % → 80 × 0,90 = 72,00 EUR. Si está al 62 % no actúa.
- Razonamiento de negocio: es el día en que "debería" estar entrando la mayor parte de las reservas de Booking; si ahí aún hay huecos, es el momento de estimular.

**3. `local_min_dip` (baja en los valles de ocupación)**
- Ventana hoy+3..hoy+60. Detecta mínimos locales discretos de ocupación, incluyendo mesetas completas (varios días seguidos con el mismo valor mínimo se marcan todos), con ocupación < umbral. Compara cada meseta con un día de margen a cada lado (por eso pide datos de hoy+2 a hoy+61; si falta algún dato, no marca nada para no inventar valles).
- Ejemplo: ocupación en días consecutivos 70, 55, 40, 40, 62, 75 con umbral 50 %. Los dos días al 40 % forman una meseta menor que 55 y que 62 → ambos son mínimo local; con −8 % pasan a 80 × 0,92 = 73,60 EUR. Una meseta plana entera (todos iguales) no cuenta como valle, y un valle al 55 % con umbral 50 % tampoco.
- Si el mínimo local coincide con el día de `lead_time_dip`, manda la más específica (`lead_time_dip`) por prioridad.

**4. `demand_pulse_dip` ("Parada de reservas", baja progresiva con memoria)**
- Ventana hoy..hoy+3. Cuenta, por noche, las reservas activas cuya estancia pasa por esa noche (check_in <= noche < check_out); una reserva de varias noches es demanda para todas las que ocupa.
- Cada `pulseSilenceMinutes` (def. 240) sin reservas nuevas con la ocupación de esa noche por debajo de `thresholdPct`, suma un escalón de bajada de −`adjustValue` % (sobre la base).
- Cada `PULSE_BOOKINGS_PER_STEP` = 2 reservas nuevas, sube medio escalón (`adjustValue / 2`) de vuelta, hasta recuperar el precio original.
- Retirada total inmediata: cuando la ocupación de esa fecha vuelve a superar el umbral, o cuando `booking_surge` detecta un repunte en vivo para esa fecha.
- Suelo: el precio nunca baja de `minAdrFloorPct` % (def. 90) del ADR real semanal; sin ADR real todavía, tope de seguridad del 30 % de descuento. El % acumulado se capa al que permite el suelo, para que la recuperación se note desde la primera reserva.
- Memoria (`demand_pulse_state`): por fecha guarda el % de descuento acumulado, el inicio del silencio (`silenceStartAt`), las reservas vistas y las que van hacia el siguiente escalón. La primera vez que se ve una fecha sólo se guarda la foto de partida, sin disparar nada (para no contar las reservas ya existentes como "nuevas").
- Ejemplo: Dir AL a 100 EUR para mañana, ocupación 45 % (umbral 60 %), escalón 5 %, silencio 240 min, suelo 90 % de un ADR semanal de 92 EUR → suelo 82,80 EUR (equivale a un 17,2 % de descuento máximo). Última reserva a las 10:00:
  - 14:00: 1 escalón → −5 % → 95,00 EUR.
  - 18:00: −10 % → 90,00 EUR.
  - 22:00: −15 % → 85,00 EUR.
  - 02:00: el objetivo sería −20 %, pero se capa en 17,2 % → 82,80 EUR (el suelo).
  - Entran 2 reservas: medio escalón (2,5 %) de vuelta → descuento 14,7 % → 85,30 EUR. Entran 2 más → 87,80 EUR. Si la ocupación sube por encima del 60 %, vuelve a 100 EUR en la pasada siguiente.
- Caso a vigilar (ver limitaciones): tras una recuperación parcial, `silenceStartAt` no se reinicia; en la primera pasada posterior sin reservas nuevas el código vuelve a calcular los escalones desde el ancla original y puede devolver el descuento al máximo que permita el suelo.

**5. `booking_surge` ("Reservas seguidas", sube precio)**
- Condición: 2 o más reservas hechas (`bookedAt`) en los últimos `thresholdPct` minutos (aquí `thresholdPct` es la ventana en minutos, def. 60, máx. 1440) cuya estancia pasa por esa noche.
- Efecto: sube `adjustValue` % sobre la base. Sin memoria: se recalcula en vivo y se apaga solo cuando las reservas salen de la ventana móvil.
- Ejemplo: ventana 60 min, +8 %. Entran una reserva a las 12:10 y otra a las 12:35 que incluyen la noche del viernes 16. En la pasada de las 13:00 hay 2 en ventana → 80 × 1,08 = 86,40 EUR. En la pasada de las 13:30 la de las 12:10 ya está fuera (más de 60 min) → vuelve a 80 EUR. Como corre cada 30 min, la granularidad real es de esa magnitud.
- Interacción: si `demand_pulse_dip` tenía un descuento acumulado en esa fecha, se retira del todo al detectar el repunte.

**6. `competitor_undercut` (más baratos que el competidor más barato)**
- Ventana hoy+3..hoy+21. Compara el precio resuelto de la tarifa de referencia (`referenceRateId`) para "Doble" (id 1, base de la comparativa) contra el precio más barato entre los competidores activos de esa noche (precio ya dividido por su divisor Booking y filtrado a baño privado, ver sección 5).
- Condición: nuestro precio > competidor más barato y ocupación < umbral.
- Objetivo: `competidor_min × (1 − adjustValue/100)`, que se traduce con las funciones de inversión al precio que hay que dejar en Dir AL. Nunca sube: `precio = min(objetivo, precio vigente)`.
- Ejemplo: el competidor más barato muestra 120 EUR en su web; con divisor 1,38 el precio efectivo guardado es 86,96 EUR. Nuestra referencia es Dir AL Doble a 95 EUR, ocupación 40 % (umbral 70 %), descuento 3 %: objetivo = 86,96 × 0,97 = 84,35 EUR → Dir AL baja de 95 a 84,35 EUR. Si la referencia fuese Dir HD = Dir AL +10 %, habría que poner 84,35 / 1,10 = 76,68 EUR en Dir AL para que Dir HD cueste 84,35.
- Si algún eslabón de la cadena es `fixed` o la referencia no llega a Dir AL, la fecha se ignora con un aviso.
- Crea una fila "semilla" en Dir AL para la fecha/tipo si aún no tenía fila propia.

**7. `sold_out_upsell` ("Venta de superiores")**
- Configuración: `sourceRoomTypeId` (tipo que se agota, p. ej. Doble) y `targetRoomTypeId` (tipo superior derivado de él, p. ej. Doble Superior). Condición binaria: 0 unidades libres del origen ese día (en 30 días; cuenta reserva principal, extras y bloqueos; `thresholdPct` no se usa).
- Efecto: baja el precio del origen (que está agotado, así que no pierde ventas) para que el destino cueste el precio original del origen + `adjustValue` EUR. Sólo baja; si el cálculo dejara el origen por encima de su precio, no hace nada.
- Ejemplo: Doble a 80 EUR agotada; Doble Superior = Doble +25 EUR (normalmente 105 EUR); regla +10 EUR → destino deseado 80 + 10 = 90 EUR; inversión del ajuste del destino: origen = 90 − 25 = 65 EUR. Doble queda a 65 EUR (agotada, nadie la compra) y Doble Superior a 90 EUR en lugar de 105 EUR: casi se regala el salto de categoría. Con un ajuste de tipo +30 %: origen = 90 / 1,30 = 69,23 EUR.
- Efecto colateral documentado en el código: arrastra a los demás tipos derivados del origen y a las tarifas derivadas.

**8. `evening_clearance_dip` ("Liquidación nocturna")**
- Sólo hoy y sólo desde `clearanceStartHour` (def. 20:00, hora Madrid). Condición: el precio base de la celda > ADR real semanal (lunes a domingo) y ocupación de hoy < `thresholdPct` (normalmente 100 %).
- Efecto: −`adjustValue` % por cada hora completa desde la de inicio, siempre sobre `basePrice` (no acumulativo), sin bajar de `minAdrFloorPct` % (normalmente 100) del ADR semanal. Sin ADR real esa semana, no actúa.
- Retraso por demanda: cada reserva nueva de hoy retrasa una hora el siguiente escalón (se acumula en `bookingsTowardStep` de `demand_pulse_state`, reutilizando la tabla); nunca "sube" el precio de vuelta.
- Ejemplo: base 100 EUR, ADR semanal 88 EUR, escalón 5 %, suelo 100 %, hoy al 85 %: 20:30 → 95 EUR; 21:30 → 90 EUR; 22:30 → 85 EUR, pero el suelo es 88 EUR → se queda en 88,00 EUR. Si a las 21:15 entran 2 reservas para hoy, el escalón de las 22:00 se retrasa 2 horas y a las 22:30 sigue en 1 escalón (95 EUR).
- Se autocorrige: calcula desde la hora real, no desde cuántas veces pasó el motor.

### 3.3 Prioridades y conflictos

- Una sola regla por fecha: entre las reglas activas cuya condición se cumple ese día gana la de menor `priority` (empate: menor `id`, la más antigua). Esa regla decide el precio de todas las celdas de esa fecha; las demás quedan en suspenso ese día.
- Prioridades iniciales (migración 0113):

| Prioridad | Regla |
|---|---|
| 10 | `demand_pulse_dip` (parada de reservas) |
| 20 | `evening_clearance_dip` |
| 30 | `sold_out_upsell` |
| 40 | `lead_time_dip` |
| 50 | `local_min_dip` |
| 60 | `low_availability` |
| 70 | `competitor_undercut` |
| 100 | resto (incluye `booking_surge` y cualquier regla nueva, por el valor por defecto de la columna) |

- Consecuencia práctica: `booking_surge` por defecto pierde contra todas las demás si coinciden; para que gane hay que bajarle el número (p. ej. por debajo de 10) desde Tarifas > Reglas. Idéntico para reglas nuevas.
- `competitor_undercut` nunca sube el precio: si otra regla de mayor prioridad tenía la fecha más rebajada, esta se queda con el precio vivo (`min(objetivo, precio actual)`).
- Si la ganadora es `sold_out_upsell` o `competitor_undercut` pero la celda concreta no tiene objetivo (otro tipo de habitación), esa celda revierte a la base.
- Si ninguna regla aplica, la celda vuelve a `basePrice` (reverso silencioso, queda en el historial pero no genera alerta).

### 3.4 Overrides temporales y descartar reglas

- Respeto del override manual: si el precio de una celda se edita a mano mientras una regla se está disparando sobre ella, esa regla no vuelve a tocarla aunque la condición se siga cumpliendo, hasta que la condición se resuelva del todo (episodio nuevo). La marca `manualOverrideAt` se limpia cuando ninguna regla se dispara ya sobre esa celda.
- Caducidad temporal (por regla, configurable): `demand_pulse_dip` respeta el override mientras sea más reciente que su `pulseSilenceMinutes`; `booking_surge` mientras sea más reciente que su ventana (`thresholdPct` minutos); `evening_clearance_dip` mientras sea más reciente que `clearanceOverrideMinutes` (def. 60). Pasado ese tiempo, la regla vuelve a mandar. Las otras reglas respetan el override sin límite de tiempo.
- Desactivar o borrar una regla: `active = false` (o `DELETE /catalog/pricing-rules/:id`). En la siguiente pasada deja de ganar fechas y las celdas vuelven a `basePrice` por el mecanismo de reverso. No hay un "descartar sólo para una fecha": se hace con un override manual de ese día o desactivando la regla.
- "Descartar" también existe en la alerta morada: el botón "Entendido" marca `dismissed_at` en todas las aplicaciones mostradas (`POST /alerts/pricing-rule-dismiss`), sin afectar a los precios.
- Diagnóstico por fecha (`getPricingDateDiagnosis`, tool `get_pricing_rules_status`): para cada fecha del horizonte dice qué regla ganó y, de cada una, si se cumplía y por qué sí o no, y cuántas celdas cambiaron o quedaron suprimidas por override. Se guarda en memoria y se recompone en la siguiente pasada.

### 3.5 Historial y auditoría

| Tabla | Contenido | Para qué |
|---|---|---|
| `price_change_log` | Todo cambio real de precio, manual o automático: tarifa, tipo, fecha, precio anterior y nuevo, `closed`, `source` (`manual`/`auto`), usuario, `ruleId`, `batchId`, fecha/hora. Permanente. | Auditoría completa y pestaña Historial. Incluye los reversos silenciosos del motor. |
| `pricing_rule_applications` | Sólo las veces que una regla se dispara de verdad (no reversos): regla, fecha, tipo, precio anterior/nuevo, `batchId`, `dismissedAt`. | Alerta morada "Reglas automáticas de precio aplicadas" a recepción/dirección. |
| `demand_pulse_state` | Memoria de `demand_pulse_dip` y `evening_clearance_dip` por fecha. | Estado entre pasadas. |

- `batchId` agrupa lo escrito por una misma acción (una edición, un bulk-edit, una pasada del motor) para mostrar "N fechas afectadas" en una línea del historial.
- Pestaña Historial (`GET /catalog/rates/price-history`): filtro por fechas y tarifa, límite hasta 2000 filas; muestra quién, cuándo, regla y viejo → nuevo precio; si el cambio es uniforme muestra un solo par. Oculta las filas automáticas de tipos de habitación derivados (ruido, nunca leídas por `resolvePrice`).
- Estado de la última pasada (`getPricingEngineStatus`): resultado (`ok`, `error`, `sin_reglas_activas`, `sin_dir_al`, `omitida_por_solape`), nº aplicadas, celdas procesadas, avisos de configuración y detección de "motor parado" (más de 2 intervalos sin arrancar). Lo consulta el agente de IA.

---

## 4. "Efectos de precio": qué impacto tiene cada regla (`pricingEffects.ts`)

Informe Informes > Efecto reglas (`GET /api/pricing-effects?days=30`, sólo dirección; días 3-120) y herramienta del agente `get_pricing_effects`.

Qué mide exactamente (ojo: son reservas, no euros):
1. Toma cada cambio de precio de `price_change_log` con más de 72 h de antigüedad, para una fecha de estancia aún no pasada en el momento del cambio, deduplicado por lote y fecha.
2. Para cada cambio cuenta las reservas activas cuya estancia pasa por esa noche hechas en las 72 h anteriores y en las 72 h posteriores al cambio.
3. Agrupa por regla (o "Manual", más el origen) y suma: nº de cambios, variación media %, reservas antes, reservas después y `liftPct = (después − antes) / antes`.
4. Emite un veredicto (`judge`):
   - Menos de 8 cambios: `pocos_datos`.
   - Si la regla es de bajada (variación media negativa): después > 120 % de antes → `funciona`; entre el 90 % y el 120 % → `sin_efecto` ("se está regalando precio"); menos del 90 % → `perjudica`.
   - Si es de subida: después >= 80 % de antes → `funciona` (hay margen para subir más); menos → `perjudica`.
   - Cada veredicto incluye un consejo en texto (reducir descuento, hacerla más selectiva, suavizar la subida, desactivarla...).

Es explícitamente indicativo, no causal (estacionalidad, otros factores, sesgo de selección: las reglas de bajada se disparan precisamente cuando el "antes" fue flojo). No calcula ingreso ni ADR incremental; para eso el agente cruza con `get_occupancy_report` y `get_price_recommendation`. La vista `EfectoReglasReport` en `ReportsView.tsx` muestra gráfico antes/después por regla y los veredictos con iconos.

Tests: `pricingEffects.test.ts` cubre el veredicto (pocos datos, rebaja que funciona/sin efecto/perjudica, subida, sin reservas antes). `pricingRulesEngine.test.ts` cubre `applyAdjust` (porcentaje, fijo, redondeo y suelo en 0) y `findLocalMinimaDates` (valle claro, valle sobre umbral, datos incompletos, meseta plana). No hay tests automáticos de las reglas con estado (`demand_pulse_dip`, `evening_clearance_dip`), de la resolución de prioridades ni de `competitor_undercut`/`sold_out_upsell`.

---

## 5. Análisis de competidores

### 5.1 Qué motores soporta y cómo obtiene el precio (`competitorPricing.ts`)

No scrapea Booking.com u otras OTAs (frágil e incumple sus términos). Lee la API pública que el propio motor de reservas de cada competidor usa para pintar su calendario. Cada motor soportado requiere su parser; hoy hay dos (`platform` en `competitor_hotels`: `paraty` | `cloudbeds`).

| Motor | Cómo lo lee | Detalle |
|---|---|---|
| Paraty (appspot "online-secure-booking") | Una llamada por mes a `calendar-handler-endpoint?action=retreive_month_prices` (2 adultos, 1 habitación). `apiBaseUrl` configurable (dominio genérico de Paraty o proxy inverso del hotel). | Precio agregado diario; 0 se trata como "sin disponibilidad". Se asume que ese precio ya es el de baño privado en estos hoteles. Config: `namespace`, `websiteUrl`, `apiBaseUrl` opcional. |
| Cloudbeds (API que expone la web del hotel) | Una llamada por noche a `/api/cloudbeds/rates?checkin=...&guests=2`, con pausa de 300 ms. | Filtra las habitaciones disponibles de baño privado (`roomId/roomName` contiene "privado" y no "compartido") y toma el mínimo `pricePerNight`. Config: `baseUrl`. |

Otros datos:
- Refresco: al arrancar el servidor y luego cada día a las 06:00 (hora del servidor), y manual por competidor (`POST /competitors/:id/refresh`, sólo admin). Horizonte por defecto 365 días. Guardado por upsert en `competitor_prices (competitor_id, date)` único: un precio por competidor y noche, nulo si no hay disponibilidad.
- Un Cloudbeds a 365 noches con 300 ms de pausa supone del orden de 2 minutos por hotel y refresco (más el tiempo de las respuestas).
- Errores por hotel en `last_error` y `last_fetched_at`; un fallo de un hotel no detiene a los demás. Si un día concreto de Cloudbeds falla, ese día no se actualiza (mantiene el dato anterior).
- Alta/edición/borrado de competidores: sólo admin; lectura para recepción (`canUseFdm`).

### 5.2 Divisor Booking / Genius

El precio de mostrador de la web del competidor suele ser más caro que lo que un cliente realmente paga en Booking.com (tarifas Genius y rebaja adicional). Para compararse contra un precio que de verdad compite, se guarda ya dividido: `precio_efectivo = round(precio_web / divisor, 2)`.
- `competitor_hotels.booking_effective_divisor`, configurable por hotel (numeric(4,2), def. 1,38 ≈ Genius + 10 %; 1 = sin ajuste). Migración 0110 (antes era una constante global).
- Ejemplo: web 120 EUR ÷ 1,38 = 86,96 EUR. Con divisor 1 se guardaría 120 EUR.
- Riesgo de negocio: el divisor es una estimación manual por hotel; si está mal calibrado, `competitor_undercut` baja precios contra una referencia incorrecta. No se contrasta contra el precio real de Booking.

### 5.3 Comparativa (`GET /api/competitors/prices`, pestaña Competidores)

Devuelve, para un rango, una serie diaria con nuestro precio (`ours`) y el de cada competidor activo (`c_<id>`).
- "Nuestro precio" = el más barato entre las tarifas activas del motor de reservas (o la tarifa elegida) y los tipos de habitación (o el tipo elegido), con celdas cerradas excluidas: el mismo "desde X EUR" que ve un cliente nuevo en la web.
- Nota: el comentario del endpoint dice "sin reglas dinámicas", pero la consulta usa `rate_daily_prices.price` (precio vigente tras reglas); la herramienta del agente `get_competitor_comparison` lo describe como "con las reglas dinámicas ya aplicadas", que es lo que hace el código.
- La vista (`CompetitorsPanel`) permite elegir periodo (por defecto 45 días, hasta 365), tarifa y tipo (por defecto rate id 10 y tipo 1, valores fijos del hotel actual), añadir competidores con su configuración y refrescar a mano.
- El agente tiene `get_competitor_comparison` (por fecha: nuestro precio, el competidor más barato y cuál, la media, la diferencia, y resumen de días en que somos más caros; máx. 60 días) y lo incluye en el briefing matutino.

### 5.4 Undercut (la regla)

Descrita en la sección 3.2 (regla 6). Resumen de diferencias con la comparativa: la regla compara siempre "Doble" con la tarifa de referencia, sólo usa competidores activos con precio > 0, ignora días sin ocupación calculada y sólo actúa de hoy+3 a hoy+21.

---

## 6. Eventos locales (`serpapi.ts`, `eventsScheduler.ts`)

- Fuente: SerpAPI, motor `google_events`. Consultas por defecto: "eventos Benalmádena", "eventos Málaga", "conciertos Málaga", "festivales Málaga". Requiere `SERPAPI_API_KEY`; sin ella devuelve vacío.
- Caché en memoria por día (clave: fecha Madrid) con vigencia de 6 horas para no gastar cuota.
- Impacto estimado sólo por palabras clave del título: alto (festival, concierto, feria, maratón, triatlón, copa del rey, final, liga, copa, circo solar...), medio (exposición, mercadillo, teatro, torneo, carrera, congreso...), bajo (resto). Las fechas se guardan como texto libre de Google, sin parsear.
- Uso: un job diario a las 09:00 (Madrid) envía un mensaje interno (`staff_messages`) a todos los usuarios con rol `direccion` con los eventos de impacto alto/medio y la sugerencia de revisar tarifas. El agente de IA lo usa con `search_local_events` y `get_price_recommendation`.
- Limitación: los eventos NO alimentan el motor de reglas; es una señal informativa para que dirección edite precios a mano (o con `set_sale_price` del agente).

---

## 7. Propagación de precios a canales

La fuente es siempre `resolvePrice`; cada canal usa un modo distinto.

| Canal | Disparo | Qué envía | Control de cambios |
|---|---|---|---|
| Jumbo (portal B2B de tour operador) | Automático al final de cada pasada del motor (cada 30 min) y manual desde el botón del calendario (`POST /jumbo/push-prices`, en segundo plano para evitar el 504 del proxy). | Un único precio por fecha: el de la tarifa JUMBO AL (derivada de Dir AL +31 %) para el tipo de referencia Doble; disponibilidad = disponibilidad global real − colchón fijo de 8 habitaciones (`JUMBO_AVAILABILITY_BUFFER`). Si el resultado es <= 0, cierra la venta (stop sales) en vez de anunciar 0. | `jumbo_push_state` por fecha (precio, disponibilidad, stop sales): sólo reenvía lo que cambió respecto al último push verificado. Tras el push lee el calendario de Jumbo para verificar. No hay "reapertura" explícita confirmada: al volver a haber disponibilidad envía el número real. |
| FDM (FrontDeskMaster, PMS con channel manager) | Manual (botón único del calendario, `POST /fdm/push-prices`, modos `prices_only` / `prices_and_avail`, `force`). | Por fecha × tarifa FDM (Dir AL id 27, Dir HD id 28) × uso de habitación (Cuádruple, Individual, Doble): precio resuelto, disponibilidad (el override manual sustituye al cálculo) y cierre. | `fdm_push_state` por fecha/tarifa/uso: sólo envía lo que cambió (precio, disponibilidad o cierre). Concurrencia 8. |
| Nobeds (Expedia y otros) | Manual (`POST /nobeds/push-prices`, admin, tarifa por código, por defecto "Expedia AL"). | Por tipo de habitación mapeado (`nobedsRoomId`): disponibilidad (total − noches ocupadas, 0 si cerrado) y precio. | Sin caché de cambios: reenvía el rango entero, secuencial. Lee las filas directas de `rate_daily_prices` (no usa `resolvePrice`), así que una fecha/tipo sin fila propia se salta. |

Implicaciones para revenue: cualquier regla que mueva Dir AL llega sola a Jumbo (y a toda tarifa derivada) en menos de 30 minutos; FDM y Nobeds requieren pulsar el botón, de modo que las bajadas/subidas dinámicas no llegan por sí solas a esos canales. Las pérdidas de paridad entre canales hay que gestionarlas a mano.

---

## 8. Recuperación de carritos/cancelaciones y descuento temporal como palancas de revenue

Son descuentos dirigidos que no tocan la tarifa pública: se aplican por enlace o token, sólo a quien ya mostró intención de compra.

- Carritos abandonados (`cartRecovery.ts`, cada 10 min): reservas web `tentative` sin pagar entre `minAgeMin` (def. 20 min) y `maxAgeHours` (def. 24 h) → registro en `abandoned_carts` y mensaje (email Resend y WhatsApp plantilla `betania_carrito`) con enlace `GET /public/recover/:token` válido `validityHours` (def. 24 h). El descuento es escalonado por importe de la reserva (def.: >=0 EUR 10 %, >1000 15 %, >2000 20 %, >3500 25 %; `discountTiers` editable). Segmentación para no regalar descuento a clientes que ya lo comprarían: sólo si el teléfono es nuevo, el nombre es nuevo o es la primera vez (criterios combinables). Sin datos de contacto o cliente existente, el carrito se registra sin envío con el motivo. Alerta "carrito abandonado con teléfono: llamar".
- Reenganche de canceladas (`cancellationRecovery.ts`, cada 10 min): reservas recién canceladas (`minAgeHours`-`maxAgeHours`) con email real (excluye alias de Booking); descuento (`discountPct`, def. 15 %) sobre el menor entre lo pagado y lo que costaría hoy con la misma tarifa; el enlace (`/public/recover-cancellation/:token`, válido 48 h por defecto) crea una reserva nueva. El informe Cancelaciones > detalle muestra qué costaría hoy cada estancia cancelada para decidir si merece reenganche.
- Descuento temporal (`/public/discount-timer`, `temporary_discount_settings`): al rellenar email y nombre arranca un temporizador en servidor; a los `activationMinutes` (def. 5) se activa un descuento (`discountPct`, def. 10 %) válido `windowMinutes` (def. 30); se valida el token ligado a email/nombre, un uso real por persona cada 2 días. Crea urgencia sin bajar el precio público.
- Configuración en Tarifas > Promociones Web (sólo dirección).
- Informes: Carritos abandonados y Reenganches de canceladas (conversión y recuperación).

Valor para revenue: es discriminación de precio por intención y por segmento (no por fecha), complementaria a las reglas dinámicas, y no contamina el ADR de referencia de las tarifas públicas.

---

## 9. Informes de revenue

| Informe | Endpoint / lógica | Métricas y notas |
|---|---|---|
| Ocupación | `computeOccupancyReport` (`GET /reports/occupancy`), compartido con el agente de IA | Por día/semana/mes/año: noches disponibles/ocupadas, ocupación %, ingresos, ADR (ingresos ÷ noches ocupadas), RevPAR (ingresos ÷ noches disponibles), llegadas, precio listado medio de una tarifa y lead medio. Opción de incluir canceladas para ver la demanda bruta. Estados vigentes (no tentative). |
| Lead time | `GET /reports/lead-time` | Por canal, para reservas hechas (`bookedAt`) en el rango: nº, media, mínimo y máximo de días entre reserva y check-in. |
| Ventas por canal | `GET /reports/channel-sales` | Reservas e ingresos por periodo de reserva, clasificados en directo / OTA / otros con listas de nombres configurables. |
| Comisiones | `GET /reports/commissions`, `PATCH /commissions/:channelId` | Por periodo y canal sobre reservas por fecha de salida con algo cobrado: base = `originalTotal` (precio original, sin extras/ampliaciones) o `total`; comisión = `bmCommission` real de FDM si existe, si no `% del canal`. Edita el % por canal sólo dirección. |
| Cancelaciones | `GET /reports/cancellations`, `/detail`, `/cancellation-recoveries` | Tasa de cancelación por canal (excluyendo carritos web nunca pagados) y dos series: por fecha de cancelación (cuándo cancelan; usa `reservation_status_logs`) y por fecha de estancia (qué noches quedan huecas, relevante para repricing y overbooking). |
| Carritos abandonados | `GET /reports/abandoned-carts` | Detalle de carritos, envíos y recuperaciones. |
| Efecto reglas | Sección 4 | Impacto en reservas por regla. |

El agente de IA añade `get_revenue`, `get_revenue_forecast`, `get_channel_stats`, `get_channel_comparison` (cuota, ticket medio, noches medias y cancelación por canal), `get_booking_patterns` (días de la semana, meses, estancias y lead), `get_price_recommendation` (ocupación prevista, precio listado y ADR real, por día o por semana) y `set_sale_price` (cambia Dir AL/Doble con confirmación), y el briefing matutino diario cruza todo ello (estado del motor, efectos, competidores, ocupación frente al año anterior).

---

## 10. Propuesta de valor frente a los RMS del mercado

Reglas de comparación: IDeaS G3 y Duetto son RMS/RMS+ para cadenas y hoteles grandes (previsión de demanda, optimización de precio, restricciones, a veces integración con ingresos de F&B y grupos). Beyond y PriceLabs/RoomPriceGenie son más ligeros y están orientados a independientes; RoomPriceGenie y PriceLabs son los más cercanos en segmento. Esta tabla es cualitativa; no se han hecho pruebas ni comparativas de precios contra esos productos.

| Dimensión | betan-bm | IDeaS / Duetto | Beyond | PriceLabs / RoomPriceGenie |
|---|---|---|---|---|
| Enfoque | Reglas transparentes y explicables sobre una tarifa raíz; ocupación, ADR y señal de demanda en vivo. | Forecast probabilístico y optimización matemática (demanda sin restricciones, desplazamiento, segmentación). | Pricing + analítica por tarifario y mercado. | Algoritmo de demanda de mercado + reglas del usuario. |
| Previsión de demanda | No hay modelo de previsión: reacciona a ocupación, lead time medio, silencios y rachas de reservas. | Núcleo del producto. | Sí. | Sí (datos de mercado). |
| Integración con PMS | Nativa: mismas reservas, ocupación, bloqueos y ADR sin sincronización con tercero. Un único origen de verdad. | Vía integraciones con PMS. | Vía integraciones. | Vía integraciones con PMS/channel managers. |
| Explicabilidad | Alta: una regla ganadora por fecha, diagnóstico por fecha ("por qué no se aplicó"), historial de cada cambio y alerta. | Baja-media (modelo). | Media. | Media. |
| Competidores | Dos motores directos del hotel (Paraty, Cloudbeds) y divisor Booking manual; regla de undercut automática. | Compset/market data de proveedores. | Compset. | Datos de mercado a gran escala (PriceLabs). |
| Coste/implantación | Incluido en el PMS, sin proyecto de integración. | Alto, proyecto largo. | Medio. | Bajo-medio por mes. |
| Medición de efecto | Informe Efecto reglas (reservas antes/después, veredicto en lenguaje llano) + agente IA que cuestiona cambios. | Informes avanzados, atribución más rigurosa. | Sí. | Informes básicos. |
| Palancas adicionales | Recuperación de carritos y cancelaciones, descuento temporal, upsell por agotamiento, liquidación nocturna, alertas. | Menos orientadas a conversión de directo. | Parcial. | Algo. |
| Canales | Jumbo automático; FDM y Nobeds manuales. | Normalmente vía channel manager. | Idem. | Idem. |

Propuesta de valor sintetizada:
1. Revenue management "de bolsillo" para hoteles independientes de 20-60 habitaciones que no pueden pagar ni gestionar un RMS enterprise: reglas con lenguaje del negocio (parada de reservas, liquidación nocturna, venta de superiores) en vez de curvas de demanda.
2. Todo en el propio PMS: no hay desfase de datos ni integración que mantener; el precio que ve el recepcionista, el cliente web, el canal y la regla es el mismo (`resolvePrice`).
3. Transparencia y control: una regla ganadora por fecha, prioridades editables, overrides manuales respetados y un diagnóstico de "por qué esta fecha tiene este precio" consultable también por el agente de IA.
4. Bucle completo de gestión: señal (ocupación, ADR, competidores, eventos) → decisión (reglas o agente) → ejecución (calendario, canales) → evaluación (efecto de reglas), con asistente de IA que redacta el briefing diario y cuestiona los cambios.
5. Palancas de conversión directa que un RMS no cubre (carritos, cancelaciones, descuento temporal).

Qué NO ofrece (para no sobrevender): previsión de demanda propia, segmentación por mercado, optimización de grupos/desplazamiento, estrategia de restricciones (LOS dinámico, CTA/CTD), recomendaciones de ocupación por canal, datos de mercado externos (compset a gran escala, demanda de búsquedas), ni un modelo de elasticidad.

---

## 11. Limitaciones y puntos a revisar

Estado técnico y de producto, derivado de la lectura del código. Los marcados "a verificar" son sospechas razonadas que conviene comprobar antes de venderlo como funcionalidad cerrada.

Producto y alcance:
1. Monohotel: `propertyId = 1`, tarifa por código `Dir AL`, tipo "Doble" con id 1 en `competitor_undercut`, tarifa 10 y tipo 1 por defecto en la comparativa, ids de FDM/Jumbo fijos en el código. Para comercializarlo a otros hoteles hay que parametrizarlo (ver `03-DESACOPLAMIENTO-HOTEL.md`).
2. Un solo precio raíz ajustable: el motor sólo escribe en Dir AL; no hay reglas por tarifa, por tipo ni por canal.
3. Una regla activa por tipo (`find`), sin avisarlo en la interfaz.
4. Sin restricciones dinámicas (LOS mínimo/máximo, CTA/CTD) ni reglas por canal; el `minStay` es estático por tarifa.
5. Sin previsión de demanda ni pickup histórico (pace) por fecha: las reglas reaccionan, no anticipan. No compara contra el mismo día del año anterior dentro del motor (sí lo hace el agente de IA, sin ejecutar).
6. Las temporadas (`minPrice`) sólo validan ediciones manuales de la tarifa raíz; el motor puede rebajar por debajo de ese mínimo.
7. La regla de eventos no existe: los eventos locales sólo avisan por mensaje y el impacto es por palabras clave (falsos positivos con "final", "liga", "copa").

Competidores:
8. Sólo dos motores (Paraty, Cloudbeds). Cada motor nuevo es código nuevo; la lógica de "baño privado" está pensada para el tipo de hotel actual.
9. Un solo precio por noche y competidor (2 adultos, 1 habitación, el más barato): sin régimen de comida, política de cancelación, estancia mínima ni tipo de habitación equivalentes.
10. El divisor Booking es una estimación manual por hotel, no un dato observado.
11. Los refrescos de Cloudbeds son lentos (una petición por noche) y dependen de que la web del competidor no cambie su API; sin reintentos ni alertas de datos caducados salvo `last_error`.
12. El scrapeo de endpoints internos de terceros puede ser frágil y debe revisarse a nivel legal/comercial antes de ofrecerlo como servicio.

Motor de reglas:
13. A verificar, `demand_pulse_dip`: tras una recuperación parcial por reservas nuevas no se reinicia `silenceStartAt`; en la pasada siguiente sin reservas nuevas el código recalcula los escalones desde el ancla original y puede devolver el descuento al máximo (limitado por el suelo). Si es así, la subida gradual dura sólo hasta la siguiente pasada tranquila (30 min).
14. A verificar, ADR del suelo de `demand_pulse_dip`: se calcula con `weeklyAdrByDate(hoy, hoy+3)`, que sólo suma noches dentro de ese rango (a diferencia de `evening_clearance_dip`, que pide lunes a domingo). En el calendario también depende del rango visible.
15. El ADR es "en libros": incluye reservas futuras de la semana y reparte `total/nights` por igual (con extras incluidos en `total`), así que un ADR de semana con pocas reservas de tarifa alta o baja puede distorsionar el suelo.
16. `booking_surge` y las reglas nuevas nacen con prioridad 100 (pierden por defecto).
17. Reacción cada 30 minutos (ventanas de 60 min en surge y liquidación horaria con esa granularidad); un reinicio del servidor vuelve a lanzar una pasada inmediata y recompone el diagnóstico (en memoria).
18. Una sola instancia del scheduler: no hay bloqueo distribuido; dos procesos ejecutarían pasadas duplicadas.
19. `sold_out_upsell` arrastra a los demás tipos y tarifas derivadas del origen (efecto colateral conocido).
20. Efecto reglas mide número de reservas (72 h antes/después), no ingresos ni ADR incremental; los reversos silenciosos del motor aparecen como grupo "Manual" con origen automático, y hay sesgo de selección (las reglas de bajada se disparan en momentos flojos).

Canales:
21. Nobeds y FDM son manuales: los cambios del motor no llegan solos. Nobeds no usa `resolvePrice` ni caché de cambios; Jumbo usa login por formulario (portal sin API), sin reapertura confirmada y con colchón fijo en código.

Tests:
22. Cobertura mínima: sólo `applyAdjust`, `findLocalMinimaDates` y `judge`. Las partes más sensibles (estado, prioridades, floors, overrides, inversión de cadenas) no tienen tests automáticos.

Siguientes pasos recomendados: parametrizar el hotel (ids, tarifa raíz, tipo de referencia), tests de la resolución de prioridades y de `demand_pulse_dip` con reloj simulado, canalizar FDM/Nobeds por el mismo mecanismo "sucio/limpio" que Jumbo, añadir previsión simple de pickup y un benchmark real con el divisor de Booking.
