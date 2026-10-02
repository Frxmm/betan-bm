# 07 · Agente IA (asistente)

El asistente responde preguntas sobre el hotel y puede hacer algunas acciones por ti. Entiende lenguaje normal: escribe como hablarías a un compañero.

## 1. Cómo abrirlo

1. Pulsa la burbuja del asistente (**Asistente IA**) que flota en la esquina de la pantalla. Aparece en cualquier pantalla.
2. Verás **¿En qué puedo ayudarte?** y cuatro sugerencias rápidas: **Resumen de hoy**, **Llegadas de mañana**, **Busca a García** y **Disponibilidad esta semana**. Pulsa una o escribe tu pregunta.
3. Escribe en **Escribe… (Enter para enviar)** y pulsa Enter o el botón de enviar.
4. Si hay respuestas nuevas con la burbuja cerrada, aparece un contador en la burbuja.

Botones de la cabecera del asistente:

- **🕘 Sesiones anteriores**: recupera conversaciones guardadas (**Sin sesiones guardadas** si no hay ninguna).
- **↺ Limpiar**: empieza una conversación nueva.
- **✕ Cerrar**: cierra el panel.

## 2. Chat

- El asistente muestra su respuesta en texto. Si ha hecho una acción (por ejemplo navegar a una pantalla), lo indica bajo el mensaje.
- Para ir a una pantalla puedes decir "Muéstrame la vista de facturación" o "Llévame a la reserva #42". Solo puede navegar a Inicio, Planning, Entradas, Salidas, Facturación, Reservas, Huéspedes y Habitaciones.
- Para llegadas de días pasados, indica la fecha exacta.

## 2b. Voz (solo dirección)

Por ahora la voz solo está disponible para Dirección. Si eres de otro rol no verás estos botones.

1. **Escuchar las respuestas**: pulsa el icono de voz de la cabecera. Cuando está activada, el asistente lee en voz alta cada respuesta nueva. Está apagada por defecto y la preferencia se guarda por dispositivo. Pulsa de nuevo para silenciar.
2. **Dictar**: pulsa el icono del micrófono (**Dictar por voz**). Mientras escucha verás **Escuchando…**. Pulsa de nuevo para parar. Requiere un navegador compatible (por ejemplo Chrome).

Además existe una app Android que despierta con la palabra "Betan", transcribe lo que pides y usa el mismo asistente, y una pantalla de resumen de cifras. Pregunta a Dirección si está instalada en vuestros dispositivos.

## 3. Ejemplos de preguntas

Estas preguntas están comprobadas y el asistente sabe resolverlas.

### Operaciones del día

- ¿Cuántos huéspedes tenemos en casa ahora mismo?
- ¿Cuántas llegadas y salidas hay hoy?
- Lista las llegadas de hoy / de mañana.
- Lista las salidas de hoy.
- Haz el check-in de la reserva #42.
- Haz el check-out de Juan García.

### Reservas y huéspedes

- Busca la reserva de María López.
- ¿Cuánto le queda por pagar al huésped de la habitación 3?
- ¿Cuántas reservas canceladas hubo de mayo a agosto?
- ¿Cuántas reservas tenemos para el mes de agosto?
- ¿Cuántos no-shows tuvimos el año pasado?
- ¿Qué reservas llegan esta semana sin pagar completamente?
- ¿Hay alguna reserva confirmada sin habitación asignada?
- ¿Qué habitaciones están disponibles del 15 al 20 de julio?

### Ingresos y caja

- ¿Cuánto hemos cobrado esta semana? Desglosado por forma de pago.
- ¿Cuánto vamos a ingresar el próximo mes según reservas actuales?
- Genera la factura de la reserva #42.

Los importes totales de facturación son exclusivos de Dirección. Si no eres Dirección, el asistente te lo dirá.

### Estadísticas y análisis

- ¿Cuál es la tasa de ocupación de junio?
- ¿Qué canal de venta nos trae más reservas, Booking o Airbnb?
- ¿Cuál es la estancia media y el precio medio por noche?
- ¿Cuál ha sido la habitación más ocupada este año?
- ¿Qué huéspedes han repetido más de una vez? ¿Quién viene más?

### Navegación

- Muéstrame la vista de facturación.
- Llévame a la reserva #42.

## 4. Qué más puede hacer

Además de las preguntas anteriores, el asistente puede:

- **Consultar**: historial completo de una reserva, historial de un huésped, estado de housekeeping, resumen de desayunos, estado de lavandería, transacciones del día, facturas y anomalías en facturas, carritos abandonados, nuevos reservas, usuarios conectados, habitaciones y sus características.
- **Precios y revenue**: calcular el presupuesto de una tarifa, recomendar precios, comparar con competidores, ver el estado de las reglas dinámicas y su efecto, ver patrones de reserva y comparativa de canales.
- **Reservas**: crear una reserva (queda sin habitación; se asigna luego en el planning), asignar o cambiar habitación, modificar una reserva, añadir una nota, registrar un pago, cancelar, ampliar la estancia (calcula antes el precio y te lo muestra), y pasar tareas de limpieza a hecho o crear y asignar tareas de limpieza.
- **Huéspedes**: actualizar datos o la valoración de un huésped, y abrir hilos de feedback.
- **Mensajes internos (solo dirección)**: enviar un mensaje a una persona del equipo o a todos, incluso marcado como importante.
- **Mantenimiento y piscina (solo dirección)**: incidencias de habitación, niveles y lecturas de piscina, estado de depósito de agua, inventario de desayunos.
- **Alertas (solo dirección)**: ver qué alertas hay configuradas y activar o desactivar un tipo.
- **Abrir una puerta (solo dirección)**: abre una de las puertas del control de accesos tras confirmar cuál.
- **Precios de venta (solo dirección)**: cambiar el precio de venta de un extra.

## 5. Quién puede qué (y confirmaciones)

El servidor comprueba tu rol en cada acción de escritura; no depende de lo que diga el asistente.

| Acción | Roles permitidos |
|---|---|
| Check-in, check-out, cancelar, crear reserva, registrar pago, asignar habitación, ampliar, modificar reserva o huésped, asignar tareas de limpieza | Recepción y Dirección |
| Añadir nota a una reserva | Recepción, Conserje y Dirección |
| Marcar limpieza como hecha, crear tarea de limpieza | Recepción, Limpieza y Dirección |
| Mensajes al equipo, tareas programadas, activar o desactivar alertas, ajustar implicación, abrir puerta, precios de venta | Solo Dirección |

Reglas de seguridad:

1. **Confirmación obligatoria**: antes de cualquier cambio, el asistente te describe exactamente qué va a hacer (reserva, huésped, importe…) y te pregunta si confirmas. Solo cuando respondes que sí lo ejecuta. Los mensajes internos al equipo son la excepción: no piden confirmación.
2. **Una cosa cada vez**: las acciones afectan a una sola reserva o huésped. No hace operaciones masivas, por ejemplo, no cancela varias reservas de golpe.
3. **Ampliar estancia**: primero calcula el precio, te lo muestra ("La ampliación de X noches suma Z €, nuevo total T €. ¿Confirmas?") y solo tras tu confirmación la aplica.
4. **Valoración tras check-out**: tras un check-out hecho con el asistente, te pregunta de inmediato cómo valorarías la estancia del 1 al 10.
5. **Datos sensibles**: los totales de facturación, mantenimiento y piscina son solo de Dirección. Si no tienes permiso, el asistente no inventa datos: te dice que no tienes acceso.
6. **Proactividad**: el asistente puede avisarte por su cuenta si ve pocas habitaciones libres (2 o menos) o ocupación muy alta, y proponerte acciones de precio.

Ejemplo de conversación con confirmación:

> **Tú:** Cancela la reserva #42.
> **Asistente:** Voy a cancelar la reserva #42 de María López, del 10 al 12 de julio (240 €). ¿Confirmas?
> **Tú:** Sí.
> **Asistente:** Hecho, la reserva #42 está cancelada.

## 6. Tareas programadas (solo dirección)

Dirección puede pedir al asistente que repita algo cada cierto tiempo, sin tener que pedirlo cada vez.

1. Escribe lo que quieres, por ejemplo: "Cada dos días envía un chiste sobre hoteles a todo el personal, a horas aleatorias".
2. El asistente te confirma con tus palabras: qué hará cada vez, cada cuántos días y la ventana horaria (por defecto 09:00–20:00).
3. Responde que sí. Se crea la tarea y te indica la próxima ejecución.
4. Cada vez que toca, el asistente ejecuta la instrucción a una hora aleatoria dentro de la ventana.

Para gestionarlas, pídeselo al asistente:

- "Lista las tareas programadas": muestra las activas e inactivas, su frecuencia, ventana, próxima ejecución y el resultado o error de la última.
- "Pausa la tarea 3" o "Activa la tarea 3": la pausa o reactiva sin borrarla.
- "Elimina la tarea 3": la borra definitivamente (pide confirmación).

## 7. AI Debug (solo dirección)

La pantalla **AI Debug** del menú es una herramienta técnica: un chat de pruebas que muestra la **Traza de ejecución** (qué herramientas llamó el asistente, con qué argumentos, qué respondió y cuánto tardó) y los **Logs SSE**. Permite elegir el motor (**Ollama / RunPod** o **Claude**). Solo es útil para diagnosticar respuestas raras del asistente.

## 8. Consejos

- Sé concreto: incluye nombre, número de reserva o fechas.
- Si el asistente no encuentra algo, prueba con otro dato (apellido, código, habitación).
- Las respuestas de datos salen de la propia base de datos del hotel, pero si algo te parece raro, comprueba la ficha de reserva.
- Para cambios importantes (cancelaciones, pagos), revisa bien el resumen antes de confirmar.
