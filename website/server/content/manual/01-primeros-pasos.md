# 01 · Primeros pasos

## Entrar en la aplicación

1. Abre la dirección web del panel del hotel en el navegador (en móvil o en ordenador).
2. En la pantalla **Booking Manager — Inicia sesión para continuar**, escribe tu **Correo electrónico** (por ejemplo `usuario@hotel.es`).
3. Escribe tu **Contraseña**.
4. Pulsa el botón de entrar.

Al entrar, el personal de **Limpieza** llega directamente a **Housekeeping**. El resto de roles llega a **Inicio**.

Si la sesión caduca, la aplicación te devuelve a la pantalla de inicio de sesión. Vuelve a entrar y continúa.

## Recuperar la contraseña (autoservicio)

1. En la pantalla de inicio de sesión pulsa **¿Olvidaste tu contraseña?**.
2. Escribe tu **Correo electrónico**.
3. Pulsa **Enviar enlace**. Recibirás un correo con un enlace para elegir una contraseña nueva.
4. Abre el enlace del correo. Se abre una pantalla donde escribes la contraseña nueva dos veces.
5. Guarda y vuelve a iniciar sesión con la contraseña nueva.

Si no quieres seguir, pulsa el botón para volver a la pantalla de entrada.

Si no te llega el correo, pide a Dirección que te envíe uno de recuperación (ver capítulo 08, Usuarios) o revisa la carpeta de spam.

## Cambiar tu contraseña, tu nombre o tu foto

1. Pulsa el icono de engranaje (⚙) al pie del menú lateral. Se abre **Apariencia**.
2. En la sección **Perfil** puedes cambiar **Nombre**, **Apellidos**, **Correo electrónico** y la foto (icono **Cambiar foto**).
3. Para cambiar la contraseña o el correo, escribe tu **Contraseña actual** (es obligatoria), la **Nueva contraseña** (mínimo 6 caracteres) y **Confirmar contraseña**.
4. Pulsa **Guardar perfil**.

En la misma pantalla, en la sección **Apariencia**, eliges **Tema**, **Fuente** y **Tamaño de texto**, y pulsas **Guardar configuración**.

## Roles y qué ve cada uno

La aplicación tiene seis roles: **Recepción**, **Conserje**, **Mantenimiento**, **Dirección**, **Limpieza** y **Cocina**. Un usuario puede tener varios roles. El administrador principal tiene los mismos permisos que Dirección.

| Pantalla (menú) | Dirección / admin | Recepción | Limpieza | Resto (Conserje, Mantenimiento, Cocina) |
|---|---|---|---|---|
| Inicio, Planning, Entradas, Salidas | Sí | Sí | Sí | Sí |
| Housekeeping, Lavandería | Sí | Sí | Sí | Sí |
| Habitaciones, Implicación | Sí | Sí | Sí | Sí |
| Reservas, Huéspedes | Sí | Sí | No | Sí |
| Facturas, Transacciones, Precios (calendario), Informes | Sí | Sí | No | Sí |
| Escaneo IDs, Caja de cambio, Extras, SES Hospedajes, Accesos | Sí | Sí | No | No |
| Facturación, Tarifas, Nobeds, Notificaciones, Alertas, Usuarios, AI Debug | Sí | No | No | No |

Notas importantes:

- El menú solo muestra lo que tu rol puede usar. Si escribes la dirección de una pantalla restringida no podrás acceder.
- Algunas acciones dentro de una pantalla dependen del rol aunque la pantalla sea visible. Por ejemplo, crear reservas, añadir extras o cambiar habitaciones requiere Recepción o Dirección; cambiar el estado de una reserva a mano, borrar una reserva o editar la fecha de salida a mano es solo para Dirección.
- En el capítulo 08 se explica cómo Dirección decide qué campos de una reserva puede editar cada rol.

### Ver la aplicación como otro rol (solo dirección)

Si eres administrador, en el menú lateral aparece el selector **Ver como… (admin)**. Elige un rol (Recepción, Conserje, Mantenimiento, Limpieza o Cocina) para previsualizar cómo lo ven. Para salir pulsa **Volver a vista de administrador**.

## Navegar por la aplicación

- **Menú lateral**: a la izquierda (en móvil se abre con el botón de menú). Muestra solo las pantallas de tu rol. Al pie ves tu nombre, tus roles, el engranaje (Apariencia) y el botón de **Cerrar sesión**.
- **Barra superior**: muestra el título de la pantalla actual, la fecha de hoy y el **buscador**.
- **Buscador**: escribe en **Buscar reserva, huésped o habitación…** y elige un resultado para abrir la reserva. Puedes moverte por los resultados con el teclado.
- **Usuarios conectados**: la barra superior muestra quién está conectado en este momento.
- **Asistente IA**: una burbuja flotante te permite hablar con el asistente desde cualquier pantalla (capítulo 07).

## Alertas

Las alertas aparecen en una barra en la parte superior de la pantalla. Se actualizan solas cada 5 minutos. Los colores indican la urgencia:

| Color | Prefijo | Significado |
|---|---|---|
| Rojo | **Solucionar urgente:** | Requiere acción inmediata |
| Amarillo | **Advertencia:** | Aviso que no es urgente (por ejemplo, incidencias) |
| Morado | **Info:** | Información de cambios automáticos del sistema (por ejemplo, reglas de precio aplicadas) |
| Azul | **Propuesta:** | Sugerencia sin urgencia, para hacer cuando haya un momento (por ejemplo, llamar a un carrito abandonado) |

Cómo trabajar con una alerta:

1. Lee el mensaje. Si afecta a una reserva, puedes pulsar el enlace para abrirla.
2. Pulsa el botón de acción de la alerta (por ejemplo **Hecho** o el que ofrezca) para resolverla. Algunas te llevan a la pantalla donde se arregla; otras se confirman con un clic.
3. Si la alerta es agrupada, una sola línea se despliega y muestra los elementos dentro.
4. Las alertas se quitan solas cuando el problema desaparece (por ejemplo, al hacer el check-in o al hacer el arqueo).

Tipos de alerta más habituales (todas se pueden activar o desactivar desde Dirección):

- Check-out no marcado pasadas las 14:00.
- Reservas en el hotel sin cobrar; reservas con total de 0 €; reservas sin habitación asignada.
- Reserva de Booking.com sin check-in y no-show sin marcar en Booking.com.
- Limpieza sin asignar pasadas las 12:00 (solo Limpieza).
- Caja de cambio: faltan los dos arqueos diarios (antes de las 15:15 y de las 23:15) o descuadre.
- Depósitos en efectivo sin verificar o con descuadre.
- Procesado de lavandería sin declarar (de 16:30 a 19:00).
- Desayunos sin confirmar (de 11:00 a 13:00) o servicio de desayunos flojo.
- Objetos robados marcados en housekeeping.
- Incidencias de habitación abiertas más de 3 días con clientes dentro.
- Check-in abandonado hoy.
- Huésped alojado sin tarjeta de acceso enrollada, o intento de acceso con tarjeta no enrollada.
- Carrito abandonado con teléfono (propuesta de llamada).
- Reglas automáticas de precio aplicadas; alta ocupación; salud del motor de reglas.
- Quejas de huéspedes sin resolver más de 24 horas.
- Ampliación de estancia pagada sin disponibilidad.

### Pantalla Alertas (solo dirección)

Contiene dos pestañas:

- **Historial**: lista de alertas activadas en un periodo (columnas Activada, Tipo, Mensaje, Severidad, Reserva, Estado). Los estados son Urgente, Advertencia, Propuesta, Silenciada y Resuelta. Puedes **Silenciar** una alerta. Si hace falta, **Comunicarse con Dirección (urgente)** envía un aviso urgente a recepción.
- **Por empleado**: por cada turno de caja cerrado, cuántas alertas se atendieron y cuántas quedaron sin atender, con el **% atendidas**.

## Mensajes de Dirección

- Dirección puede enviarte un mensaje a través del asistente. Aparece como burbuja de chat en el asistente flotante.
- Si es un mensaje marcado como **importante**, aparece una ventana que bloquea la pantalla. No se puede cerrar con Escape ni haciendo clic fuera. El botón **Leído** se activa tras una cuenta atrás de unos 10 segundos. Léelo y pulsa **Leído**.

## Aviso semanal de implicación

Una vez por semana, al entrar, puedes ver tu puntuación de implicación, pero solo si es mayor de 80. Es un reconocimiento, no una presión. Más detalles en el capítulo 08.

## Pantalla de Inicio

La pantalla **Inicio** resume el día (detalle en el capítulo 02). Los usuarios de Dirección ven además un panel de **resumen rápido** con ocupación de hoy, cobrado hoy, reservas nuevas hoy y llegadas pendientes.
