# 02 · Recepción: el día a día

Este capítulo cubre las tareas de Recepción y Dirección: ver el día, gestionar reservas, hacer check-in y check-out, cobrar y enviar información al huésped.

## 1. Inicio (dashboard)

La pantalla **Inicio** muestra cuatro bloques de cifras:

- **Llegadas hoy** (pendientes de check-in).
- **Salidas hoy** (pendientes de check-out).
- **En casa** (reservas activas).
- **Nuevas hoy** (reservas creadas hoy).

Debajo hay listas con las llegadas y salidas pendientes (columnas Huésped, Habitación, Noches, Estado) y un bloque **Últimas reservas**. Si no hay nada pendiente verás **Sin llegadas pendientes** o **Sin salidas pendientes**.

Los estados de reserva que verás en toda la aplicación son: **Provisional**, **Confirmada**, **Por llegar**, **En casa**, **Saliendo**, **Ha salido**, **Cancelada** y **No show**.

## 2. Planning

El **Planning** es el calendario de habitaciones por días. Cada fila es una habitación y cada barra es una reserva (con el color de su estado).

Controles de la parte superior:

- Botones de **Día anterior** y **Día siguiente**.
- **Ir a ▾** con atajos (**Hoy**, **Ayer**, **Hace un mes**, **Hace un año**) y selector **Desde** y **Días**, con **Aplicar**.
- Indicadores **Hoy** y **Esta semana**, y los campos **Dir AL / noche** y **Dir HD / noche** (precio directo por noche).
- Un botón para sincronizar reservas desde ayer hasta dentro de un año.

### Crear una reserva desde el planning

1. Haz clic derecho sobre el día y la habitación donde quieres la reserva.
2. Elige **+ Crear reserva** (en pantallas táctiles aparece un menú con ese botón).
3. Busca el huésped en **Huésped \*** (nombre, email o DNI). Si no existe, pulsa **+ Nuevo huésped**, rellena **Nombre \***, **Apellidos \***, **Teléfono** y **Email** y pulsa **Crear y seleccionar**.
4. Indica **Fecha entrada**, **Fecha salida \***, **Personas**, **Canal \*** y **Tarifa \***.
5. Comprueba o escribe el **Total \***. Debe ser mayor de 0 €.
6. Si hace falta, añade **Habitaciones adicionales** y un **Código externo (Booking, etc.)**.
7. Pulsa **Crear reserva**.

### Bloquear una habitación

1. Haz clic derecho sobre el día y la habitación.
2. Elige **Bloquear habitación**.
3. Indica el **Motivo (opcional)**, por ejemplo mantenimiento o limpieza.
4. Pulsa **Bloquear**.

Para quitar el bloqueo, haz clic derecho sobre el día bloqueado y elige la opción de desbloquear. Los bloqueos de Dirección aparecen como **Bloqueo de Dirección** y recepción no puede quitarlos.

### Mover una reserva

Hay dos formas:

1. **Arrastrar**: arrastra la barra de la reserva a otra habitación o a otras fechas. Aparece un resumen **Confirmar movimiento de reserva** que compara **Actual** y **Nuevo** (Entrada, Salida, Noches, Precio total). Pulsa **Confirmar**. Si hay días bloqueados en la habitación de destino, el sistema no te deja mover.
2. **Clic derecho sobre la reserva**: elige cambiar de habitación. En **Mover reserva** selecciona **1. Tipo de habitación** y **2. Habitación** entre las disponibles y pulsa **Mover reserva**.

Eliminar una reserva desde el planning (**Eliminar definitivamente**) solo está disponible para Dirección.

## 3. Entradas y Salidas

**Entradas** lista las llegadas del día (usa los botones ‹ y › para cambiar de día; **Hoy** vuelve al día actual). Muestra los totales **Por llegar**, **Llegaron** y **Total llegadas**. Columnas: Hab., Huésped, Tipo, Noches, Personas, Canal, Saldo, Estado. Puedes ordenar pulsando en la cabecera de una columna.

- **Check-in**: el botón realiza el check-in de esa llegada (salvo que ya haya llegado; entonces ves **Ver**).
- **Ver**: abre la reserva.

**Salidas** funciona igual, con **Por salir**, **Ya salieron** y **Total salidas**. Columnas: Hab., Huésped, Llegada, Noches, Canal, Total, Pagado, Saldo, Estado. El botón **Check-out** pide **¿Confirmar check-out?**.

Para el check-in completo (con contrato, SES y tarjeta) se recomienda abrir la reserva con **Ver** y hacerlo desde ahí (sección 6).

## 4. Reservas (listado)

La pantalla **Reservas** lista todas las reservas con filtros.

1. Filtra por estado (**Todos los estados**, **Por llegar**, **Provisional**, **Confirmadas**, **En casa**, **Saliendo**, **Han salido**, **Canceladas**, **No show**), por tarifa, por operador y por fechas (**Llegada**, **Salida**, **Reservada**, **Estadía**).
2. El botón **✕ Hoy** limpia los filtros. Hay también un filtro para reservas con habitaciones adicionales.
3. Pulsa **⬇ Exportar** para descargar el listado en Excel/CSV.
4. Pulsa cualquier fila para abrir la reserva. Columnas: Código, Huésped, Habitación, Noches, Personas, Fecha reserva, Tarifa, Operador, Total, Pendiente, Estado.
5. Usa **← Anterior** y **Siguiente →** para paginar.

### Crear una reserva desde el listado

1. Pulsa **+ Nueva reserva**.
2. Busca o crea el **Huésped \*** (igual que en el planning).
3. Elige **Habitación \***, **Fecha de entrada \***, **Fecha de salida \***, **Tarifa \*** y **Canal \***. Opcionalmente un **Código externo**.
4. Indica el total (mayor de 0 €).
5. Pulsa **Crear reserva**. Verás el aviso **Reserva creada**.

La pestaña **Configuración** del listado (solo dirección) define qué campos pueden editar otros roles; se explica en el capítulo 08.

## 5. La ficha de reserva

Al abrir una reserva ves arriba la cabecera con los botones de acción y debajo las pestañas **Huésped**, **Transacciones**, **Depósitos**, **Facturas**, **Historial** (y una zona de extras y notas).

Botones principales de la cabecera (según el estado):

- **Check-in** / **Check-out**.
- **↩ Revertir a checked-in** (si ya hizo check-out).
- **+ Pago**, **+ Nota**.
- **✍ Contrato** (con ✓ cuando está firmado).
- **🖨 Confirmación**: abre la confirmación de reserva para imprimir.
- **Check-in online ▾**: envía al huésped el enlace de check-in por WhatsApp o por email. Si ya lo hizo verás **✓ Check-in online completado**.
- **🔗 Enlace de pago ▾**: envía el recordatorio de pago pendiente por WhatsApp o email (no aparece para reservas de Booking.com ni si no hay importe pendiente).
- **↔ Ampliar**.
- **⇄ Cambiar hab.** o **⇄ Asignar a habitación**.
- **✂ Partir reserva**.
- **Cancelar reserva**.
- **⚙ Cambiar estado** (solo dirección).

### Editar datos de la reserva

Según tu rol y la configuración de campos, puedes editar el precio total (**Editar precio**), el **Canal de reserva**, la **Tarifa**, el **Código externo**, el tipo de habitación y la habitación. Para cambiar la fecha de salida, solo Dirección puede usar **Editar fecha de salida (admin)** (para estancias normales usa **Ampliar**). También puedes **Recalcular** el precio eligiendo una tarifa: el sistema calcula el total a partir del mapa de precios.

### Editar datos del huésped

1. En la pestaña **Huésped**, pulsa **✎ Editar** junto al **Huésped titular**.
2. Rellena **Nombre \***, **Primer apellido \***, **Segundo apellido**, **Sexo**, **Fecha de nacimiento**, **Nacionalidad**, **Email**, **Teléfono**, tipo y número de documento (**DNI**, **NIE**, **Pasaporte**, **Carnet de conducir**, **Otro**), **Fecha de expedición**, **Fecha de caducidad**, dirección (**País**, **Ciudad / Código postal**, **Municipio INE**) y **Código INE**.
3. Elige **país**, **ciudad** y **municipio** de las listas desplegables. El sistema no acepta texto libre.
4. Pulsa **Guardar**.

Avisos que te dará el sistema:

- Si el email es un alias temporal de Booking (`@guest.booking.com`), te pide el email real antes de guardar o de hacer check-in.
- Si el email parece sospechoso, te pide confirmar con **El cliente me lo ha dado personalmente** o **Voy a pedírselo**.
- Si faltan datos obligatorios, aparece **Faltan datos obligatorios**.

Otras acciones del huésped:

- **⇄ Cambiar titular** y **+ Añadir** (huéspedes adicionales): busca uno existente por **Nombre, apellido, email o documento…** o pulsa **Crear nuevo huésped →**. En reservas de grupo, elige la **Habitación**.
- **★ VIP**, **🚫 Lista negra** (pide **Motivo \*** y **Severidad**; permite también quitarlo).
- **💬 Feedback**: registra lo que ha dicho el huésped (**Elogio**, **Neutro**, **Queja**, **Sugerencia**) con una **Categoría** (limpieza, ruido, camas, wifi, desayuno, ducha, checkin, precio, trato, ubicación, otro).

## 6. Check-in

### Check-in normal desde la ficha

1. Abre la reserva y revisa que la fecha de hoy esté entre la entrada y la salida (fuera de ese rango no se puede hacer check-in).
2. Comprueba los datos del huésped titular y de los adicionales (documento, fecha de nacimiento, dirección completa con municipio INE).
3. Registra el **depósito** en la pestaña **Depósitos** (**+ Agregar depósito**). Sin depósito activo el sistema avisa: **No hay ningún depósito registrado — añádelo antes del check-in**.
4. Pide la firma del contrato (sección 12) y genera la tarjeta o el código de acceso (sección 13).
5. Pulsa **Check-in**.
6. Si falta algún dato obligatorio para SES, el sistema te lo indica (**Faltan datos obligatorios para SES: …**) y no sigue hasta que lo completes.
7. Si faltan la tarjeta de acceso, el parte SES o el contrato firmado, el sistema abre un aviso (**Check-in sin tarjeta ZKTeco**, **Check-in sin enviar SES Hospedajes** o **Check-in sin contrato firmado**). Puedes pulsar **Continuar con check-in** escribiendo el motivo por el que procedes. Ese motivo queda registrado, y las incidencias aparecen en el informe de Recepción.

También existe el botón **Hacer check-in + enviar SES**, que hace el check-in y envía el parte de viajeros a la vez. Cuando termina, verás **Check-in realizado · Parte SES enviado** y el número de lote.

El sistema mide el tiempo de check-in desde el primer intento (informe de Recepción, capítulo 08).

### Check-in con escaneo de DNI (pantalla Escaneo IDs)

Sirve para agilizar el check-in fotografiando el documento. Solo funciona con llegadas de **hoy** en estado **Por llegar** o **Confirmada**.

1. Abre **Escaneo IDs** en el menú (Recepción y Dirección). Verás **Escaneo de documentos — Check-in rápido con la cámara — solo llegadas de hoy**.
2. Selecciona la reserva de la lista. Si no hay ninguna, aparece **No hay llegadas pendientes para hoy**.
3. Empieza por el **Titular**. Después se tratan los demás huéspedes de la reserva.
4. Haz una foto del documento con la cámara del móvil. La imagen se reduce automáticamente antes de subirla.
5. Espera a **Leyendo el documento…**. La IA rellena los campos: **Nombre \***, **Primer apellido \***, **Segundo apellido**, **Sexo**, **Fecha de nacimiento**, **Nacionalidad**, **Tipo de documento**, **Número de documento**, **Nº de soporte**, **Fecha de expedición**, **Fecha de caducidad**.
6. Revisa y corrige los datos. El sistema valida el DNI y el NIE: comprueba el formato y la letra de control, y avisa si la letra no coincide.
7. Si la foto salió mal, pulsa **Repetir foto**.
8. Pulsa **Guardar**. Verás **Datos guardados**.
9. Termina el check-in desde la ficha de la reserva (sección anterior).

Si la imagen falla, aparece **No se pudo procesar la imagen** o **No se pudo leer la imagen**: repite la foto con mejor luz.

## 7. Check-out

1. Abre la reserva (o usa **Check-out** en la pantalla **Salidas**).
2. Resuelve los depósitos: los depósitos con dinero (efectivo o preautorización de tarjeta) deben estar **Cobrados** o **Devueltos**. Usa en la pestaña **Depósitos** los botones **Cobrar** o **Marcar devuelto**. Si no, el sistema dice **Hay depósitos sin cobrar ni devolver — resuélvelos antes del check-out**.
3. Comprueba que el saldo está a cero (pestaña **Transacciones**, **Pendiente**).
4. Pulsa **Check-out**. Aparece la ventana **Antes de cerrar…** donde puedes valorar al huésped con estrellas, y pulsas **Confirmar check-out**.
5. Verás **Check-out realizado**. La habitación pasa a la lista de limpieza.

Si te equivocas, **↩ Revertir a checked-in** (pide confirmación **¿Revertir la reserva a checked-in?**).

## 8. Cobros: pagos y depósitos

### Registrar un pago

1. En la reserva pulsa **+ Pago** (o ve a la pestaña **Transacciones** y pulsa **+ Registrar pago**).
2. Rellena **Importe \***, **Forma de pago \*** (Efectivo, Tarjeta, Transferencia, etc.) y la caja o **Cuenta**.
3. Para pagos con tarjeta indica el **Nº de Op.** (número de la terminal o recibo). Es obligatorio, salvo que uses **Cobrado en otro turno**.
4. Añade una **Descripción (opcional)**, por ejemplo "anticipo" o "saldo final".
5. Pulsa **Registrar**. Verás **Pago registrado**.

Si registras un pago cuando no hay saldo pendiente, el sistema te pide explicar el motivo y **Confirmar pago**.

### Cobrado en otro turno

Se usa cuando el pago lo cobró otro compañero en otro turno. Indica la **Hora real del pago** y **¿Quién cobró el pago?** (usuarios con rol de recepción). Más adelante se puede corregir con **Guardar corrección** (**Fecha real del pago**). Las correcciones aparecen en el informe **Errores en el registro de pagos** (capítulo 08).

### Depósitos

1. En la pestaña **Depósitos** pulsa **+ Agregar depósito**.
2. Elige el **Tipo de depósito** (por ejemplo **Efectivo**, **Depósito**, datos de tarjeta), el **Importe (€)** y una **Descripción (opcional)**.
3. Pulsa **Registrar**. Verás **Depósito registrado**.
4. Al finalizar la estancia, usa **Cobrar** (si hay que cobrar) o **Marcar devuelto** (si hay que devolverlo).

Los estados de un depósito son **Preautorización**, **Datos de Tarjeta**, **Cobrado** y **Devuelto**.

### Eliminar un pago o depósito

Pulsa el icono de eliminar en la fila. El sistema pide confirmar con **¿Eliminar este pago?** o **¿Eliminar este depósito?**.

## 9. Walk-in (cliente sin reserva)

No hay un botón específico de walk-in. El proceso es:

1. Crea la reserva desde el planning (clic derecho sobre la habitación libre de hoy) o con **+ Nueva reserva**.
2. Elige el **Canal** de walk-in que tenga configurado el hotel.
3. Introduce los datos del huésped (o escanea el DNI desde **Escaneo IDs** si la reserva ya está creada para hoy).
4. Registra el depósito y el pago (sección 8).
5. Haz el check-in (sección 6).

## 10. Cancelar una reserva

1. Abre la reserva.
2. Pulsa **Cancelar reserva** (botón rojo). Solo aparece si no ha salido ni está cancelada.
3. Confirma **¿Cancelar esta reserva?**. Verás **Reserva cancelada**.

Dirección puede además **Borrar reserva** (**Zona de peligro**) y forzar cualquier estado con **Cambiar estado**.

## 11. Dividir (partir) una reserva

Sirve para continuar una estancia en otra habitación desde una fecha concreta. El botón **✂ Partir reserva** solo aparece si la reserva está **En casa**, tiene más de una noche, tiene habitación y no tiene habitaciones adicionales.

1. Pulsa **✂ Partir reserva**.
2. Indica la **Fecha de corte**.
3. Elige una habitación libre para el tramo siguiente (si no hay, verás **No hay habitaciones disponibles de este tipo para ese tramo**).
4. Pulsa **Partir reserva**. Verás **Reserva partida — continuación #…**. La nueva reserva es la continuación y los importes se reparten con el concepto "Traspaso por partición".

## 12. Habitaciones extra

1. En la reserva, en el bloque **Estancia**, pulsa **+ Hab.** (solo si no ha salido ni está cancelada).
2. Elige una **Habitación disponible** y pulsa **Añadir**. Verás **Habitación adicional añadida**.
3. Para quitarla, usa **Quitar habitación**. Debes escribir un **Motivo — obligatorio**.

Reglas de permiso: Dirección puede añadir habitaciones extra libremente. Recepción solo puede añadirlas en reservas **Walk-in del mismo día**; en ese caso el sistema calcula automáticamente el precio de la habitación extra.

## 13. Ampliar la estancia

1. Pulsa **↔ Ampliar** en la reserva.
2. Se muestra la **Estancia actual**. Elige la **Nueva fecha de salida**.
3. Elige la **Tarifa para las noches extra** (o **Sin tarifa (precio manual)**). Si dejas el importe vacío se usa el precio calculado. Verás el **Total**.
4. Confirma. Verás **Reserva ampliada a … noches**.
5. Si la reserva tenía código de cerradura o tarjeta de acceso, el sistema los regenera o reenrola. Si el código de la cerradura cambia, te lo muestra para que se lo des al cliente (**El código de la cerradura ha cambiado. Proporciona el nuevo al cliente: …**). Si falla, te avisa del error.

El importe adicional no puede ser 0 €, y la fecha de salida debe ser posterior a la actual.

El huésped también puede ampliar y pagar desde su portal o desde el QR de la habitación (capítulo 06).

## 14. Notas

1. Pulsa **+ Nota** en la reserva.
2. Escribe la **Nota** y pulsa guardar. Verás **Nota añadida**.

Las notas aparecen en el **Historial** de la reserva.

## 15. Extras

En la reserva puedes añadir cargos adicionales:

1. En el bloque de extras pulsa **+ Añadir extra**.
2. Elige el **concepto** (por ejemplo alojamiento, bar y bebidas u otros), la **Cantidad** y el **Precio ud. (€)**. Puedes dejar una nota opcional.
3. Pulsa **Añadir**. Verás **Extra añadido**.
4. Para quitarlo, **¿Quitar este extra?**. El bloque muestra **Total extras**.

La pantalla **Extras** del menú (Recepción y Dirección) muestra todas las ventas de extras; la configuración de extras se explica en el capítulo 08.

## 16. SES Hospedajes (parte de viajeros)

La ley obliga a comunicar los datos de los viajeros a SES Hospedajes. El sistema lo hace desde la reserva.

Desde la ficha de reserva (panel **SES Hospedajes**):

1. Comprueba que el titular y los huéspedes adicionales tienen todos los datos obligatorios (el sistema los valida y los lista si falta alguno).
2. Pulsa **Enviar parte** y confirma **¿Enviar parte de viajero al SES Hospedajes?**.
3. Cuando termina, el panel muestra **✓ Enviado** con el **Lote**. Mientras tanto aparece **Pendiente de envío**.

También se envía con **Hacer check-in + enviar SES** (sección 6).

La pantalla **SES Hospedajes** del menú muestra los partes enviados:

1. Elige el rango **Desde** y **Hasta** (por defecto, hoy y ayer; el máximo para consultar el estado de todos es de 2 días).
2. Revisa las cifras **Partes enviados**, **Con lote**, **Procesados OK** y **Con error**.
3. En la tabla ves Reserva, Huésped, Hab., Entrada, Salida, Pers., Enviado, Lote SES y Estado SES (**Recibido**, **Procesado**, **Anulado**, **Sin lote** o **Errores en comunicaciones**).
4. Pulsa **Consultar** para ver el estado actualizado.

## 17. Contrato y firma

1. En la reserva pulsa **✍ Contrato**.
2. Se muestra un QR y un enlace (**El huésped escanea el QR con su móvil y firma con el dedo**). Puedes pulsar **Copiar** para copiar el enlace.
3. El huésped abre el enlace en su móvil, ve el contrato, firma en pantalla (**Firme aquí con el dedo**, con la opción **Borrar firma**) y confirma.
4. Cuando termina, el panel muestra **✓ Contrato firmado**. La ventana se actualiza sola, y el enlace caduca a las 24 horas.
5. Si el enlace caducó, pulsa **Generar nuevo enlace de firma**.

Si haces el check-in sin contrato firmado, el sistema te pide el motivo.

## 18. Claves de acceso y cerraduras

Hay dos sistemas, ambos desde la ficha de reserva.

### Cerradura de habitación (código)

1. En el panel **Cerradura**, elige el tipo de código: **Normal (14:00)** o **Anticipado (09:00)**. Para el anticipado debes escribir un **Comentario (obligatorio para anticipado)**.
2. Pulsa **Generar y enviar código**. El código se genera y se envía al huésped (por ejemplo, **Código enviado por WhatsApp**).
3. Si hace falta, puedes **reenviar** el código o **revocarlo** (**¿Revocar el código de acceso?**).

Mientras no hay código, el panel muestra **Sin código generado**.

Por defecto, una reserva con saldo pendiente no puede generar ni reenviar el código de la cerradura: cobra primero el saldo. Dirección puede eximir a determinados canales de venta de esta regla (capítulo 08).

### Acceso al recinto (tarjeta ZKTeco)

- En el panel **Acceso recinto** ves **✓ Enrollada** si el huésped tiene tarjeta, o **Sin tarjeta de acceso**. Con **Detalles** ves más información.
- Al hacer check-in puede enrolarse la tarjeta automáticamente (si la opción de enrolado está activada) o reutilizarse la de una reserva anterior del mismo huésped en estancias consecutivas.
- Para quitarla usa revocar (**¿Revocar la tarjeta de acceso al recinto?**).

La pantalla **Accesos** del menú (Recepción y Dirección) permite:

- **Tarjetas**: lista de tarjetas (reserva, habitación, nombre, nº de tarjeta, última vista, usos). Puedes buscar y filtrar (**Sin usar +7 días**, +30, +60, +90). Se puede **Eliminar** una tarjeta.
- **Accesos**: registro de eventos de las puertas (hora, puerta, tarjeta, evento, dirección). Filtros: **Solo accesos**, **Solo errores/alertas**, **Entrada y salida**.
- **Control de puertas**: botones para abrir puertas y **Sincronizar**.
- **Configuración** (solo dirección): interruptor **Enrolar tarjeta IC en TTLock al hacer check-in**.

## 19. Envío por WhatsApp y email

Desde la ficha de reserva, si el huésped tiene teléfono o email:

| Acción | Dónde | Resultado |
|---|---|---|
| Enlace de check-in online | **Check-in online ▾** → **📲 Por WhatsApp** o **✉️ Por email** | "Enlace de check-in enviado por WhatsApp / email" |
| Recordatorio de pago | **🔗 Enlace de pago ▾** → WhatsApp o email | "Recordatorio de pago enviado por WhatsApp / email" |
| Código de cerradura | **Generar y enviar código** | Envío al huésped |
| Confirmación impresa | **🖨 Confirmación** | Abre la hoja para imprimir |

Si el envío falla, aparece **Error enviando WhatsApp** o **Error enviando email**. Comprueba el teléfono o el email del huésped. Los textos de los mensajes los gestiona Dirección en **Notificaciones** (capítulo 08).

## 20. Lista de huéspedes

La pantalla **Huéspedes** tiene dos pestañas:

- **Lista**: busca por nombre, email, teléfono o documento, y filtra por país (código ISO2, por ejemplo ES, FR) o por fechas de estancia. Columnas: Nombre, Email, Teléfono, Edad, Nacionalidad, Documento, Reservas, Noches, valoraciones del huésped y del hotel, VIP, Alta. Puedes crear (**Nuevo huésped**) o editar un huésped.
- **Demografía**: gráficos de distribución por edad y por nacionalidad, reservas por provincia de origen, y cifras de total, edad media y datos registrados.

Dentro del editor del huésped hay una sección **Anonimización de datos personales (RGPD)** que permite eliminar de forma definitiva los datos de identificación. Úsala solo cuando sea necesario y con autorización.
