# 08 · Dirección y configuración

Este capítulo es para Dirección y el administrador principal. Salvo que se indique otra cosa, todo lo de aquí es **(solo dirección)**.

## 1. Usuarios

Entra en **Usuarios** (**Personal con acceso al sistema**).

La tabla muestra Nombre, Email, DNI, Teléfono, Roles, Estado y Último acceso. El administrador principal lleva la marca **ADMIN**.

### Crear un usuario

1. Pulsa **+ Nuevo usuario**.
2. Rellena **Nombre \***, **Apellidos \***, **Email \*** y **Contraseña \***. Opcionalmente **DNI / NIE** y teléfono.
3. Marca al menos un rol en **Roles \***: **Recepción**, **Conserje**, **Mantenimiento**, **Dirección**, **Limpieza** o **Cocina**. Un usuario puede tener varios.
4. Pulsa **Guardar**. Verás **Usuario creado**.

### Editar, desactivar y reactivar

1. En la fila del usuario pulsa **Editar**. Para cambiarle la contraseña escribe una nueva en **Nueva contraseña (vacío = no cambiar)**.
2. Para quitarle el acceso, desactiva la cuenta (**Cuenta de … desactivada**). Para devolvérselo, reactívala (**… reactivado**). Al desactivar no se borran sus datos ni su histórico.
3. Para ayudar a alguien que no recuerda su contraseña, pulsa el icono de correo (**Enviar correo de recuperación de contraseña**). Verás **Correo de recuperación enviado a …**.

Consejo: da a cada persona solo los roles que necesita. Por ejemplo, el personal de limpieza solo necesita **Limpieza**.

## 2. Ajustes de apariencia y perfil

Cada usuario tiene su propia pantalla (engranaje ⚙): **Apariencia** (tema, fuente, tamaño de texto) y **Perfil**. Ver capítulo 01.

## 3. Mensajes y plantillas (Notificaciones)

En **Notificaciones** controlas los mensajes automáticos que reciben los clientes.

### Canales de envío

1. En **Canales de envío**, cada tipo de mensaje tiene dos interruptores: **✉️ Email** y **📲 WhatsApp**. Pulsa para activarlos o desactivarlos. Se guarda al instante (**Guardado**).
2. En **No enviar a reservas de…** puedes excluir canales de venta para ese mensaje (por ejemplo, no enviar a reservas de una OTA). Pulsa un canal para excluirlo (**Clic para excluir**) o para volver a permitirlo (**Excluido — clic para permitir**).

### Plantillas de email

1. En **Plantillas de email** elige la plantilla. Hay: **Enlace de check-in online**, **Recordatorio de pago pendiente**, **Código de cerradura**, **Recuperación de carrito con descuento** y **Confirmación de reserva web (con enlace de gestión)**.
2. Edita el **Asunto** y el cuerpo. Una plantilla modificada lleva la etiqueta **personalizada**.
3. Pulsa **Vista previa** para ver el resultado (y **Ocultar vista previa** para cerrarla).
4. Pulsa **Guardar** (**Plantilla guardada**).
5. Para volver a la versión original, restaura la plantilla de fábrica (**¿Restaurar la plantilla de fábrica? Se perderán tus cambios.**).

### Plantillas de WhatsApp

Las plantillas de WhatsApp las aprueba y aloja Meta. Se editan en **WhatsApp Manager** (el enlace aparece en la pantalla), no en la aplicación.

## 4. Reglas de campos editables de reservas

Dirección decide qué campos de una reserva pueden cambiar otros roles.

1. Ve a **Reservas** y abre la pestaña **Configuración**.
2. En **Campos editables en reservas**, por cada **Campo** elige los **Roles adicionales permitidos** (Recepción, Conserje, Mantenimiento, Limpieza) y, si quieres, **Restringir a canales (vacío = todos)**.
3. En **Nombres bloqueados al guardar huéspedes** añade nombres o apellidos que no deben aceptarse (por ejemplo textos basura): escribe en **Añadir nombre o apellido bloqueado…** y pulsa **+ Añadir**.
4. En **Debe estar saldada para check-in** marca los canales de venta exentos. Por defecto, una reserva con saldo pendiente no puede generar ni reenviar el código de acceso de la cerradura TTLock; los canales que marques aquí (por ejemplo, los que cobran por su cuenta) sí pueden.
5. Pulsa **Guardar cambios**. Verás **Configuración guardada**.

Dirección siempre puede editar. El resto de roles solo editan los campos que habilites aquí.

## 5. Alertas

Las alertas (capítulo 01) se generan solas. Dirección puede:

- **Ver el historial** y la atención por empleado en **Alertas** (**Historial** y **Por empleado**), silenciar alertas y usar **Comunicarse con Dirección (urgente)**.
- **Activar o desactivar tipos de alerta** pidiéndoselo al asistente IA: "¿Qué alertas tengo configuradas?" o "Desactiva la alerta de X" (capítulo 07).

## 6. Informes

Entra en **Informes** (todos los roles menos Limpieza). Elige el periodo (**Desde**, **Hasta**, **‹ Mes anterior**, **Mes actual**, **Mes siguiente ›**) y la pestaña:

| Pestaña | Qué muestra |
|---|---|
| **Ocupación** | Ocupación media, ingresos, ADR, RevPAR y lead time por periodo; agrupa por días o **Semanas**; permite comparar con el precio de una tarifa |
| **Ventas por canal** | Reservas e ingresos de ventas directas frente a OTA (puedes definir qué canales son directos y cuáles OTA) |
| **Comisiones** | Precio original y comisión por canal |
| **Cancelaciones** | Cancelaciones por fecha de cancelación y por fecha de estancia, ratio por canal, y el **reenganche de cancelaciones** (ofertas enviadas y recuperadas) |
| **Lead time** | Antelación media, mínima y máxima por canal |
| **Recepción** | Check-ins válidos, check-ins sin contrato firmado, sin tarjeta ZKTeco o sin SES, tiempo medio de check-in por día y por recepcionista, y **Errores en el registro de pagos** |
| **Desayunos** | Desayunos servidos, media diaria, incluidos en tarifa y días sin servicio |
| **Lavandería** | Piezas entregadas y procesadas, discrepancias, entregas y procesado por trabajador |
| **Housekeeping** | Tareas generadas y completadas, no molestar, tiempo medio de respuesta por trabajador |
| **Carritos abandonados** | Carritos, importe perdido, emails enviados, recuperados e importe recuperado, con el detalle por cliente |
| **Efecto reglas** (solo dirección) | Resultado de las reglas dinámicas: **Funciona**, **Sin efecto**, **Perjudica** o **Pocos datos**, y **Qué ajustar** |
| **Empresas** (solo dirección) | Empresas candidatas a precio fijo semanal y ofertas (**Crear oferta**) |
| **Feedback** (Recepción y Dirección) | Hilos de feedback de huéspedes: **Abiertos** o **Todos**, con estados **Abierto**, **En curso**, **Resuelto** y **Descartado**; puedes abrir un hilo (**Abrir hilo**), añadir comentarios (**Comentar**) |
| **Uso QR habitaciones** | Visitas a los QR de habitación |

Solo **Efecto reglas**, **Empresas** y **Feedback** están restringidas por rol, como se indica en la tabla.

## 7. Implicación (engagement)

La pantalla **Implicación** mide cuánto usa cada persona la plataforma.

- **Para cada usuario**: ve **Tu implicación** (puntuación sobre 100, con el desglose) y las compensaciones de Dirección que le hayan sumado o restado puntos. Una vez a la semana, al entrar, se le muestra su puntuación si es mayor de 80.
- **Para Dirección**: la tabla compara a todos los empleados. Columnas: Empleado, Rol, **Rating 3m (oficial)**, **Rating periodo**, **Fallos check-in**, Acciones, **Días activos**, **Acc./día** y **Último acceso**. Hay gráficos de la **Comparativa por tipo de acción** y de las **Horas del día en que trabaja en la plataforma**. Puedes ver las **Compensaciones de Dirección** y ajustarlas (también pidiéndoselo al asistente).

El rating (0-100) combina el volumen de acciones por día activo (50 puntos) y la constancia de días activos (50 puntos). La puntuación oficial es una media de 3 meses.

## 8. Habitaciones y tipos

La pantalla **Habitaciones** (todos los roles pueden verla; crear y editar es de Dirección) tiene tres pestañas: lista de habitaciones, **Características** y **Tipos**.

### Habitaciones

La tabla muestra Código, Tipo, Capacidad, Precio base, Orden, Color, TTLock y Estado.

1. Pulsa **+ Nueva habitación**.
2. Rellena **Código \*** (por ejemplo 101) y **Tipo de habitación \***.
3. Indica las características: **Cama inicial**, **Baño** (Ducha, Bañera, Ducha y bañera), **Terraza** (privada, compartida, sin terraza), **Tamaño de cama**, **Tamaño (m²)**, **Vistas**, **Tipo de cerradura**, **TTLock ID** (el identificador numérico de la cerradura en la app TTLock), **Marca aire acondicionado** y **Marca TV**.
4. Si quieres, cambia los colores del planning (**Override colores**; vacío = hereda del tipo).
5. Pulsa **Guardar**. Verás **Habitación creada**.

Puedes **Editar**, **Desactivar** y **Reactivar** una habitación. En la tabla, el botón **QR** genera el QR de acceso de la habitación (capítulo 06).

Con los filtros de la parte superior (**Baño**, **Terraza**, **Cama**, **Vistas**) buscas habitaciones por características. **✕ Limpiar filtros** los quita.

### Tipos de habitación

1. En la pestaña **Tipos** pulsa **+ Nuevo tipo**.
2. Rellena **Nombre \*** (por ejemplo "Doble estándar"), **Prefijo** (por ejemplo DBL), **Descripción**, **Capacidad máx.**, **Precio base (€/noche)**, **Camas extra permitidas** y **Precio cama extra (€)**.
3. Para integraciones y web: **Clase FDM**, **Etiqueta motor de reservas** y **Máx. personas motor de reservas**.
4. Elige los **Colores (planning)**.
5. Pulsa **Guardar**. Verás **Tipo creado**.

## 9. Extras

La pantalla **Extras** (Recepción y Dirección) tiene dos pestañas: **Ventas** (todas las ventas de extras, con filtros **Desde**, **Hasta** y **Extra**, y total) y **Configuración** (solo dirección).

Crear un extra:

1. En **Configuración**, pulsa **+ Nuevo extra**.
2. Rellena **Nombre \*** (por ejemplo Desayuno o parking), **Icono (emoji)**, **Precio base (€)**, **Tipo de precio** (**Por estancia**, **Por noche**, **Por persona** o **Por persona/noche**), **Cantidad máxima**, **IVA (%)** y **Descripción** (visible en el motor de reservas).
3. Pulsa **Guardar**. Verás **Extra creado**.
4. Marca **Booking engine** y **Activo** para que se ofrezca a los huéspedes en la web. Puedes **Desactivar** o **Eliminar** un extra.

## 10. Integraciones

| Integración | Dónde se ve | Qué hace |
|---|---|---|
| **Nobeds** (channel manager) | **Nobeds** (menú) | Conecta con Nobeds. Permite **Cargar alojamientos Nobeds**, mapear cada tipo de habitación con su **ID rental Nobeds**, **Enviar tarifas a Expedia** (rango **Desde**/**Hasta**) y **Sincronizar ahora** las reservas. Si falta la clave, la pantalla indica **Sin configurar** |
| **FrontDesk Master (FDM)** | **Precios → ⇅ Enviar precios** | Publica precios y disponibilidad. También hay una pantalla de envío manual de tarifas con **Solo precios** o **Precios + disponibilidad** |
| **Jumbo** | **Precios → ⇅ Enviar precios** | Envía los precios (derivados de la tarifa de referencia) y verifica las fechas |
| **SES Hospedajes** | Reserva y pantalla **SES Hospedajes** | Parte de viajeros a la autoridad (capítulo 02) |
| **ZKTeco** (tarjetas del recinto) | **Accesos** | Control de puertas y tarjetas (capítulo 02) |
| **TTLock** (cerraduras de habitación) | **Habitaciones**, ficha de reserva | Códigos de cerradura (capítulo 02) |
| **WhatsApp y email** | **Notificaciones**, ficha de reserva | Mensajes automáticos y manuales |
| **Pagos con tarjeta en la web** | Motor de reservas y portal | Cobro online de reservas, extras y ampliaciones |

Las claves y credenciales de cada integración se configuran en el servidor, no en la pantalla. Si una pantalla dice **Sin configurar**, consulta con quien administra el sistema.

## 11. Otros paneles de dirección

- **Resumen rápido** (en el panel): ocupación hoy, cobrado hoy, reservas nuevas hoy y llegadas pendientes.
- **Fondo del panel**: el asistente puede cambiar la imagen de fondo del panel (para ti o para otro usuario) si se lo pides.
- **Notificaciones importantes** al equipo: mensajes con ventana bloqueante (capítulo 01).
