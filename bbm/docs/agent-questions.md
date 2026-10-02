# Preguntas del recepcionista — Agente IA

Índice de preguntas que el agente es capaz de resolver usando sus tools.

---

## Operaciones del día

| # | Pregunta | Tool |
|---|----------|------|
| 1 | ¿Cuántos huéspedes tenemos en casa ahora mismo? | `get_today_summary` |
| 2 | ¿Cuántas llegadas y salidas hay hoy? | `get_today_summary` |
| 3 | Lista las llegadas de hoy / de mañana | `get_arrivals` |
| 4 | Lista las salidas de hoy | `get_departures` |
| 5 | Haz el check-in de la reserva #42 | `check_in` |
| 6 | Haz el check-out de Juan García | `search_reservations` → `check_out` |

---

## Reservas y huéspedes

| # | Pregunta | Tool |
|---|----------|------|
| 7  | Busca la reserva de María López | `search_reservations` |
| 8  | ¿Cuánto le queda por pagar al huésped de la habitación 3? | `search_reservations` → `get_reservation` |
| 9  | ¿Cuántas reservas canceladas hubo de mayo a agosto? | `query_reservations` |
| 10 | ¿Cuántas reservas tenemos para el mes de agosto? | `query_reservations` |
| 11 | ¿Cuántos no-shows tuvimos el año pasado? | `query_reservations` |
| 12 | ¿Qué reservas llegan esta semana sin pagar completamente? | `get_pending_payments` |
| 13 | ¿Hay alguna reserva confirmada sin habitación asignada? | `get_unassigned_reservations` |
| 14 | ¿Qué habitaciones están disponibles del 15 al 20 de julio? | `get_availability` |

---

## Ingresos y caja

| # | Pregunta | Tool |
|---|----------|------|
| 15 | ¿Cuánto hemos cobrado esta semana? Desglosado por forma de pago | `get_revenue` |
| 16 | ¿Cuánto vamos a ingresar el próximo mes según reservas actuales? | `get_revenue_forecast` |
| 17 | Genera la factura de la reserva #42 | `create_invoice` |

---

## Estadísticas y análisis

| # | Pregunta | Tool |
|---|----------|------|
| 18 | ¿Cuál es la tasa de ocupación de junio? | `get_occupancy_rate` |
| 19 | ¿Qué canal de venta nos trae más reservas, Booking o Airbnb? | `get_channel_stats` |
| 20 | ¿Cuál es la estancia media y el precio medio por noche? | `get_stay_stats` |
| 21 | ¿Cuál ha sido la habitación más ocupada este año? | `get_room_stats` |
| 22 | ¿Qué huéspedes han repetido más de una vez? ¿Quién viene más? | `get_repeat_guests` |

---

## Navegación

| # | Pregunta | Tool |
|---|----------|------|
| 23 | Muéstrame la vista de facturación | `navigate` |
| 24 | Llévame a la reserva #42 | `navigate` |

---

## Tools disponibles

| Tool | Descripción |
|------|-------------|
| `get_today_summary` | Llegadas, salidas y huéspedes en casa hoy |
| `get_arrivals` | Lista llegadas de un día concreto |
| `get_departures` | Lista salidas de un día concreto |
| `search_reservations` | Busca por nombre, código o habitación |
| `get_reservation` | Detalle completo de una reserva |
| `query_reservations` | Cuenta/lista con filtros: estado, canal, fechas |
| `check_in` | Realiza check-in |
| `check_out` | Realiza check-out |
| `get_availability` | Habitaciones disponibles entre dos fechas |
| `create_invoice` | Genera factura de una reserva |
| `navigate` | Navega a una pantalla de la app |
| `get_revenue` | Ingresos reales cobrados en un período, por forma de pago |
| `get_revenue_forecast` | Ingresos previstos de reservas futuras confirmadas |
| `get_occupancy_rate` | Tasa de ocupación (%) de un período |
| `get_channel_stats` | Reservas e ingresos desglosados por canal de venta |
| `get_pending_payments` | Reservas con saldo pendiente de pago |
| `get_repeat_guests` | Huéspedes con más de una reserva, ranking |
| `get_stay_stats` | Noches medias, precio medio por noche y por reserva |
| `get_room_stats` | Habitaciones más reservadas/ocupadas |
| `get_unassigned_reservations` | Reservas confirmadas sin habitación asignada |
