# 06 · Motor de reservas y portal del huésped

Este capítulo explica lo que ve y hace el huésped, y cómo integrarlo en la web del hotel. Sirve para que el personal sepa responder a las dudas de los clientes.

Hay cuatro páginas públicas, todas disponibles en siete idiomas (español, inglés, francés, alemán, italiano, ucraniano y chino):

| Página | Dirección | Para qué sirve |
|---|---|---|
| **Motor de reservas** (página completa) | `/booking` | Reservar y pagar online |
| **Widget de reservas** (para incrustar) | `/booking-widget` | Mismo motor, para meterlo en la web del hotel |
| **Portal "Mis reservas"** (página completa) | `/portal` | Que el huésped vea y gestione sus reservas |
| **Widget del portal** (para incrustar) | `/portal-widget` | Mismo portal dentro de la web del hotel |
| **QR de habitación** | `/room` (con el token del QR) | Acceso del huésped alojado, sin login por email |
| **Firma de contrato** | `/sign` | El huésped firma el contrato desde su móvil |

## 1. Motor de reservas y widget (lo que ve el huésped)

El huésped avanza por tres pasos: **Disponibilidad**, **Tus datos** y **Pago**.

1. En **¿Cuándo quieres venir?** elige **Llegada**, **Salida** y **Personas**, y pulsa **Ver disponibilidad** (en el widget, **Buscar disponibilidad**).
2. Se muestran las **Habitaciones disponibles**, con cuántas quedan y el máximo de personas. Si no hay, ve **Sin disponibilidad** y se le sugiere probar otras fechas o menos personas.
3. En cada habitación elige la tarifa (**Selecciona tarifa:**). Algunas muestran avisos como **Mín. N noches**, **¡Tarifa especial para 2 noches!**, **¡Oferta semanal disponible!** o **¡Tarifa mensual con el mejor precio!**. Pulsa **Continuar →**.
4. Puede añadir **Servicios opcionales** (extras activados en el motor de reservas).
5. Rellena **Datos del huésped principal**: **Nombre \***, **Apellidos \***, **Email \***, **Teléfono** y **Comentarios** (por ejemplo "Cama supletoria, llegada tarde…"). Puede marcar **Prefiero dos camas separadas**; es una preferencia sujeta a disponibilidad, no una garantía.
6. Pulsa **Pagar … →**. Se le redirige al pago con tarjeta (**Redirigiendo…**).
7. Al terminar ve **¡Reserva confirmada!** con el número de reserva y las fechas, y recibe un email de confirmación.

Detalles útiles:

- Si el cliente abandona el pago, al volver ve **Tienes una reserva pendiente de pago** con **Completar pago** o **Empezar de nuevo**. El sistema lo recuerda incluso días después en el mismo navegador.
- Si la promoción de descuento temporal está activa, verá **¡Oferta relámpago!** con cuenta atrás y luego **Descuento del N% aplicado** (capítulo 05).
- El enlace **Mis reservas** lleva al portal.
- La reserva web aparece en el panel como **Provisional** hasta que se paga y luego como **Confirmada**. Las reservas web sin pagar generan alertas de carrito abandonado si no se completan.

Qué configura Dirección para este motor:

- Qué tarifas se ven (**Web** en **Tarifas**).
- Qué tipos de habitación y con qué etiqueta y máximo de personas se muestran (**Habitaciones → Tipos**: **Etiqueta motor de reservas** y **Máx. personas motor de reservas**).
- Qué extras se ofrecen (**Extras**, columna **Booking engine**).
- Las promociones web (capítulo 05) y los emails (capítulo 08).

## 2. Portal "Mis reservas" (lo que ve el huésped)

1. El huésped abre `/portal` o el widget y escribe **Tu email de reserva**.
2. Pulsa **Enviar enlace de acceso**. Recibe un enlace mágico (sin contraseña) válido durante 48 horas.
3. Al abrir el enlace pulsa **Acceder a mis reservas**.
4. Ve sus reservas separadas en **Próximas** y **Anteriores**, y un botón **+ Nueva reserva** (abre el motor de reservas).
5. Pulsa **Ver detalle →** en una reserva.

Dentro de una reserva puede:

- **Check-in online**: rellenar **Tipo de documento**, **Número de documento**, **Nacionalidad**, **Fecha de nacimiento**, dirección de su domicilio (con buscador de direcciones), **Hora de llegada prevista**, y pulsar **Confirmar check-in online**. En el panel aparece **✓ Check-in online completado**.
- **Pagar el importe pendiente** (**Pago pendiente**, **Pagar …**).
- **Añadir extras** (**Añadir extras**, **Total extras**, **Pagar …**).
- **Ampliar su estancia** (**Ampliar tu estancia**): elige las **Noches adicionales**, ve la **Nueva fecha de salida** y el **Importe de la ampliación**, y paga con **Pagar y ampliar**. Antes debe tener el saldo pendiente pagado.
- **Pedir su factura**: **Solicitar factura**, rellena **Nombre completo / Razón social**, **NIF / CIF / DNI / NIE / Pasaporte** y **Dirección completa**, y **Enviar solicitud**. Si ya hay factura, **Descargar PDF**.
- **Dejar feedback** (**Cuéntanos qué tal**): **Genial**, **Normal**, **Hay un problema** o **Una sugerencia**, con comentario opcional. Esto llega al personal como feedback (capítulo 08) y las quejas sin resolver generan alerta.

Caso especial de Booking.com: si la reserva llegó con un email temporal de Booking, el portal le pide su **email real** (**Necesitamos tu email real**) antes de continuar.

### Qué ve el personal

- Un check-in online completado aparece como **✓ Check-in online completado** en la ficha de reserva.
- Una ampliación pagada aplica el cambio en la reserva. Si no hay disponibilidad, aparece una alerta para recepción.
- Una solicitud de factura llega al personal para emitirla (capítulo 04).

## 3. QR de habitación

Es un código QR pegado en cada habitación. Permite que el huésped alojado vea su estancia sin necesidad de login por email.

### Para el huésped

1. Escanea el QR de su habitación con el móvil.
2. En **Bienvenido a tu habitación** escribe su **Primer apellido** (el de la reserva) y pulsa **Acceder**.
3. Ve el detalle de su estancia ya iniciada y puede:
   - **Ampliar** su estancia y pagar.
   - **Añadir extras**.
   - Indicar la **Limpieza de hoy**: **Limpieza normal**, **No molestar** o **Solo toallas**. Esa petición llega a Housekeeping.
   - Dejar feedback.
4. Si falla verá mensajes como **No hemos podido verificarte. Revisa el apellido o pasa por recepción.**, **Este código no es válido — pasa por recepción.** o **Demasiados intentos — inténtalo de nuevo en unos minutos**. La sesión es corta y caduca; basta con volver a escribir el apellido.

### Para el personal: generar e imprimir el QR

1. Ve a **Habitaciones**.
2. En la fila de la habitación pulsa **QR**.
3. En la ventana **QR de acceso — Habitación N** pulsa **Descargar PNG**, imprímelo y pégalo en la habitación.

Es el mismo QR siempre: no cambia con las actualizaciones del sistema, por lo que el QR impreso sigue sirviendo.

El uso de los QR se mide en **Informes → Uso QR habitaciones** (visitas totales, días con visitas, media por día, día con más visitas).

## 4. Integrarlo en la web del hotel

Los widgets están pensados para insertarse con un `iframe`. Pide a quien gestione la web del hotel que use estas direcciones (sustituye `TU-DOMINIO` por el dominio del panel).

### Widget de reservas

- Dirección del iframe: `https://TU-DOMINIO/booking-widget`
- Para forzar el idioma añade `?lang=es` (también `en`, `fr`, `de`, `it`, `uk`, `zh`). Si no lo indicas, se usa el idioma del navegador.
- El widget avisa a la página con mensajes `postMessage`:
  - `betania-widget-height`: altura que debe tener el iframe (campos `height` y `expanded`). La web debe escucharlo y ajustar la altura del iframe, o el cliente verá barras de scroll.
  - `betania-widget-scroll-top`: pide a la página que suba al inicio del widget.
- La página puede enviar al widget `betania-widget-reset` para volver al formulario inicial sin recargar.

Ejemplo mínimo:

```html
<iframe id="betania-booking" src="https://TU-DOMINIO/booking-widget?lang=es"
        style="width:100%;border:0" scrolling="no"></iframe>
<script>
  window.addEventListener('message', function (e) {
    var f = document.getElementById('betania-booking')
    if (e.data && e.data.type === 'betania-widget-height') f.style.height = e.data.height + 'px'
    if (e.data && e.data.type === 'betania-widget-scroll-top') f.scrollIntoView({ behavior: 'smooth' })
  })
</script>
```

### Widget del portal

- Dirección del iframe: `https://TU-DOMINIO/portal-widget`
- Mensajes que envía a la página:
  - `betania-portal-height`: altura del contenido.
  - `betania-portal-close`: el cliente pulsó **✕ Cerrar** (úsalo para cerrar un modal).
  - `betania-portal-open-booking`: el cliente pulsó **+ Nueva reserva** (úsalo para abrir el widget de reservas).

### Enlaces directos

Si no quieres incrustar nada, enlaza a `https://TU-DOMINIO/booking` (reservar) y `https://TU-DOMINIO/portal` (mis reservas).

Después de pagar, el cliente vuelve a `/booking/success` (o `/booking-widget/success`), donde ve la confirmación.

## 5. Contrato: firma del huésped

1. El recepcionista genera el enlace desde **✍ Contrato** en la reserva (capítulo 02).
2. El huésped abre la página (`/sign`), ve **Cargando contrato…**, lee el texto y firma con el dedo en **Firme aquí con el dedo** (puede **Borrar firma**).
3. Al terminar ve **✅ Contrato firmado correctamente.** y ya puede cerrar la página.
4. Si abre un enlace ya usado ve **✅ Este contrato ya fue firmado. ¡Gracias!**.
