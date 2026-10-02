# 05 · Tarifas, precios y revenue

Este capítulo explica cómo se definen y cambian los precios. La gestión de tarifas (**Tarifas**) es solo para Dirección. El **calendario de precios** (**Precios**) lo ven todos los roles salvo Limpieza, pero la mayoría de cambios son de Dirección.

## 1. Conceptos básicos

- **Tarifa**: una lista de precios por noche (por ejemplo, "Dir AL" es la tarifa directa de alojamiento).
- **Tarifa derivada**: una tarifa que no tiene precios propios; se calcula a partir de otra tarifa (la **tarifa base**) con un ajuste.
- **Tipo de habitación derivado**: un tipo de habitación que calcula su precio a partir de otro tipo (por ejemplo, Individual = Doble −12 %).
- **Tarifa web**: una tarifa marcada para que se vea en el motor de reservas de la web.
- **Operador (OTA)**: el canal de venta externo asociado a una tarifa (Booking.com, Expedia, etc.).
- **ADR**: precio medio por noche ocupada. **RevPAR**: ingresos por habitación disponible.

## 2. Tarifas (solo dirección)

Entra en **Tarifas**. La pantalla se llama **Tarifas y precios** y tiene cinco pestañas: **Tarifas**, **Temporadas**, **Reglas dinámicas**, **Configuración** y **Promociones Web**.

### Pestaña Tarifas

La tabla muestra Tarifa, Regla de creación, Operador, Ajuste / Precio y Control. En **Control** hay iconos para marcar si la tarifa es visible en el motor web (**Web**), si es **Editable por usuario**, **Bloquear tarifa** (impide que otros la editen hasta desbloquearla), **Editar tarifa** y **Eliminar tarifa**.

Crear una tarifa:

1. Pulsa **+ Nueva tarifa**.
2. Escribe el **Nombre \*** y, si quieres, un **Código** (por ejemplo `WEB_AL`) y una **Descripción**.
3. Si es derivada, elige la **Tarifa base** (o deja **Es tarifa base** si tiene precios propios).
4. Elige el **Ajuste**: **Fijo (€)**, **Porcentaje (%)**, **Importe (+€)** o **Por persona (+€/pers)**, y su valor.
5. Elige el **Tipo de habitación** y el **Operador (OTA)** si aplican.
6. Marca **Editable por usuario** si quieres que otros roles puedan cambiar sus precios.
7. Indica las **Restricciones de estancia**: **Mínimo de noches** y **Máximo de noches** (opcional).
8. Pulsa **Guardar**. Verás **Tarifa creada**.

Con el botón **Operadores** puedes ver y añadir los operadores conectados (nombre, código y URL del logo).

### Pestaña Temporadas

Define periodos (por ejemplo "Temporada Alta") con **Nombre**, **Desde**, **Hasta**, **Color** y el **Precio mín. Dir AL (€)**, que es el suelo de precio de la tarifa directa en esas fechas.

1. Pulsa para crear una **Nueva temporada**.
2. Rellena **Nombre**, **Desde \***, **Hasta \***, el **Precio mín. Dir AL (€)** (por ejemplo 60) y el **Color**.
3. Pulsa **Guardar cambios**.

### Pestaña Configuración

Aquí se define la **Derivación de precio por tipo de habitación**: un tipo puede derivar su precio de otro con un ajuste en % o €, igual para todas las tarifas. Solo el tipo base tiene calendario de precios editable; el derivado se calcula solo. Para cada tipo elige **— Precio propio (editable) —** o el tipo base y escribe el ajuste (por ejemplo `-12`). Verás **Guardado**.

## 3. Calendario de precios

Entra en **Precios** (el menú lo muestra a todos menos a Limpieza). El título de la pantalla es **Calendario de Precios**. Tiene estas pestañas: **Calendario**, **Competidores**, **Historial** y (solo dirección) **Configuración**.

### Leer el calendario

- Cada fila es una tarifa o tipo de habitación; cada columna, un día.
- Elige cuántos días ver (**Días:**), muévete con ◀ ▶ y vuelve con **Hoy**.
- Leyenda de colores: **Precio personalizado**, **Cerrada**, **Derivada** (calculada), **Sobre ADR semanal** (precio por encima del ADR real de esa semana) y **Bajo ADR semanal** (por debajo).
- Un resumen por propiedad muestra disponibilidad y precios.
- Las celdas de solo lectura llevan la marca **Solo admin**.

### Cambiar precios

1. Haz clic en una o varias celdas (**Click para seleccionar celdas**). Aparece una barra con el número de celdas seleccionadas.
2. Escribe el **Precio (€)**. Si hay tarifas derivadas, ves una vista previa en **Tarifas derivadas:**.
3. Para cerrar la venta de esas fechas, marca **Cerrar tarifa** en lugar de escribir un precio.
4. Pulsa **Aplicar precio** (o **Cerrar**). Verás **Precios actualizados**.
5. Si quieres volver al valor calculado desde reservas, usa el icono de volver al valor calculado en la celda.

También puedes ajustar la **Disponibilidad** de un tipo de habitación y fecha (el editor permite fijar o quitar un ajuste de disponibilidad).

### Enviar precios a los canales

El botón **⇅ Enviar precios** (Recepción y Dirección) publica los precios a FrontDesk Master (precio y disponibilidad) y a Jumbo (precio derivado de Dir AL). Solo envía lo que ha cambiado desde el último envío. Mensajes habituales: **FDM: sin cambios**, **Jumbo: ya hay un envío en curso**, o la confirmación de que Jumbo ha verificado las fechas. Jumbo trabaja en segundo plano; si tarda, el aviso lo indica.

### Competidores

La pestaña **Competidores** (Recepción y Dirección; solo Dirección edita) compara tus precios con los de hoteles de la competencia.

- **Hoteles competidores**: añade un competidor con **Nombre**, **Motor de reservas** (por ejemplo Cloudbeds), **Namespace** y **Web del hotel**, y pulsa para guardar (**Competidor añadido — actualizando sus precios…**). Puedes **Actualizar** sus precios cuando quieras.
- **Divisor precio efectivo**: el precio de mostrador del competidor se divide por este número para obtener su precio efectivo (por ejemplo, Booking Genius más una rebaja).
- **Comparativa de precios**: elige **Nuestra tarifa**, **Tipo de habitación** y **Periodo**. Verás tus precios y los de cada competidor, y **La más barata**.

### Historial

La pestaña **Historial** (Recepción y Dirección) lista los cambios de precio: **Cuándo**, **Usuario / origen**, **Tipo(s) hab.**, **Antes → Después** y **Fechas afectadas**. Filtra por **Fechas afectadas desde … hasta** y por tarifa. Un cambio automático aparece como **Reverso automático a precio base**.

### Configuración (solo dirección)

Define la vista por defecto: **Días por defecto**, qué **Tipos de habitación** y qué **Tarifas visibles** se muestran al abrir el calendario. Pulsa **Guardar** (**Valores por defecto guardados**).

## 4. Reglas dinámicas (solo dirección)

Las reglas ajustan los precios automáticamente según la ocupación, la demanda o la competencia. Se gestionan en **Tarifas → Reglas dinámicas**.

La lista muestra Prioridad, Tipo, Condición y Estado (activa o **Inactiva**). Un número de **Prioridad** menor gana si varias reglas se cumplen la misma fecha.

Tipos de regla disponibles:

| Tipo | Qué hace |
|---|---|
| **Disponibilidad baja** (sube precio) | Sube el precio cuando queda poco porcentaje de habitaciones libres |
| **Caída en lead time** (baja precio) | Baja el precio cuando, en un día concreto de antelación (lead time), la ocupación está por debajo del umbral configurado |
| **Mínimos locales** (baja precio) | Baja el precio cuando la ocupación está por debajo de un umbral |
| **Parada de reservas** (hoy a 3 días, baja progresivo) | Si no entran reservas durante una ventana de tiempo, baja el precio por escalones |
| **Más cara que competidores** (baja precio) | Baja el precio respecto al competidor (descuento %) |
| **Venta de superiores** (baja precio) | Cuando se agota un tipo, rebaja el tipo superior derivado |
| **Liquidación nocturna** (baja precio) | A partir de una hora (por defecto 20:00) baja el precio de lo que queda sin vender |
| **Reservas seguidas** (sube precio) | Sube el precio si entran varias reservas seguidas |

Crear una regla:

1. Ve a **Tarifas → Reglas dinámicas** y pulsa para crear una **Nueva regla**.
2. Escribe un **Nombre** (por ejemplo "Última disponibilidad") y elige el **Tipo de regla**.
3. Rellena los parámetros que aparecen según el tipo, por ejemplo: **Umbral disponibilidad (%)**, **Umbral ocupación (%)**, **Ventana de detección (minutos)**, **Tarifa de referencia** (la que se compara con los competidores y se ajusta), **Tipo de habitación que se agota** y **Tipo superior**.
4. Elige el ajuste: **Tipo de ajuste**, **Valor**, **Escalón de bajada**, **Descuento sobre el precio del competidor (%)** y otros según el tipo.
5. Si aplica, ajusta **Suelo de precio (% del ADR semanal)**, **Ventana de silencio (minutos)**, **Hora de inicio (0-23, Europe/Madrid)** y **Ventana de override manual (minutos)**.
6. Fija la **Prioridad** y guarda (**Regla creada** o **Regla actualizada**).

Notas:

- Si cambias un precio a mano, el motor respeta tu cambio durante la **Ventana de override manual**.
- Cada vez que una regla cambia un precio, el sistema avisa con una alerta informativa (morada) y lo anota en **Precios → Historial**.
- Para saber si una regla funciona, mira **Informes → Efecto reglas** (capítulo 08): muestra, por regla, cambios, variación media y veredicto (**Funciona**, **Sin efecto**, **Perjudica** o **Pocos datos**).

## 5. Promociones web (solo dirección)

En **Tarifas → Promociones Web** hay tres paneles para recuperar reservas de la web. Cada uno se guarda con **Guardar configuración**.

### Reenganche de reservas canceladas

Envía una oferta de descuento a quien canceló una reserva directa.

- **Tiempos**: **Esperar antes de enviar (h)** (margen por si fue un cancel accidental), **Ignorar si canceló hace más de (h)** y **Validez del enlace de descuento (h)**.
- **Descuento**: **% de descuento**.

### Recuperación de carritos abandonados

Detecta clientes que empezaron a reservar en la web y no pagaron, y les envía un recordatorio con descuento.

- **Esperar antes de detectar (min)**: el usuario puede estar aún pagando.
- **Ignorar si lleva más de (horas)**: no recuperar carritos muy antiguos.
- **Tramos de descuento**: pulsa **+ Añadir tramo** e indica **Si el importe supera…** y el **Descuento ofrecido**. Se puede **Eliminar** un tramo.
- **Criterios de cliente nuevo**: el teléfono no existe en otro perfil, el nombre y apellido no existen en otro perfil, y sin reservas anteriores completadas.

Los carritos con teléfono generan una alerta azul de propuesta para llamar al cliente. En **Informes → Carritos abandonados** ves los carritos, el importe perdido, los emails enviados, los recuperados y el importe recuperado.

### Descuento temporal en la reserva

No envía nada por email. Se activa dentro de la propia página de reserva si el cliente rellena sus datos y tarda en pagar: **Activar a los (min)** desde que rellena email y nombre, y **Ventana para completar (min)** durante la que vale el descuento. El cliente ve una cuenta atrás en la página (**Oferta relámpago**).

## 6. Dónde ver el resultado

- **Informes** (capítulo 08): ocupación, ventas por canal, comisiones, cancelaciones, lead time, carritos, efecto de las reglas, empresas.
- **Empresas** (informe, solo dirección): lista de empresas candidatas a precio fijo semanal y ofertas creadas (**Crear oferta** con **Precio fijo por semana (€)**, **Desde**, **Hasta**).
