# 04 · Facturación y caja

Este capítulo explica las facturas, las transacciones (cobros), las cajas y la caja de cambio. Las pantallas **Facturas** y **Transacciones** están disponibles para todos los roles salvo Limpieza. **Caja de cambio** es para Recepción y Dirección. **Facturación** (resumen económico) es solo para Dirección.

## 1. Facturas

### Crear una factura desde una reserva

1. Abre la reserva y ve a la pestaña **Facturas**.
2. Pulsa **+ Nueva factura**. Si no hay importe pendiente de facturar, el sistema dice **No hay importe pendiente de facturar**.
3. Revisa a quién se factura (**Facturar a**) y el importe.
4. Pulsa **Crear factura**. Verás **Factura NNNNNNN/AAAA creada**.
5. Pulsa **🖨 Imprimir** en la fila de la factura para imprimirla o guardarla en PDF.

La numeración sigue el formato configurado (por ejemplo `0000001/2026`) y la factura calcula la base imponible y el IVA.

### Proforma

Una factura proforma es un presupuesto previo, sin valor fiscal ni numeración.

1. En la cabecera de la pestaña **Facturas** pulsa **Proforma** (**Factura proforma**).
2. Se genera el documento. Pulsa **Imprimir proforma**.

### Abonos (facturas rectificativas / devoluciones)

1. En la pestaña **Facturas**, en la fila de la factura, pulsa **↩ Devolución** (solo dirección, y solo para facturas con importe positivo).
2. Confirma **¿Crear factura rectificativa de …?**.
3. Verás **Factura rectificativa NNNNNNN/AAAA creada**. Se guarda con importe negativo, así que descuenta de los totales.

### Corregir una factura (solo dirección)

1. Pulsa el botón de editar en la fila de la factura.
2. Cambia los datos fiscales: **Nombre / Razón social**, **CIF / NIF**, **Dirección fiscal** y **Notas de la factura**.
3. Solo Dirección puede cambiar el **Número de factura** y el **Total factura**.
4. Guarda. Verás **Factura actualizada**. Si dejas el número vacío, el sistema avisa **El número de factura no puede estar vacío**.

### Pantalla Facturas (listado)

La pantalla **Facturas** tiene dos pestañas:

- **Listado**: facturas emitidas con buscador por **Número de factura…**, filtro de fechas (**Del** … **Aplicar**) y columnas Nº Factura, Fecha, Razón social, Huésped, Canal, Reserva, Base, IVA y Total. El botón **⬇ Exportar Excel** descarga el listado. Dirección puede eliminar facturas desde el listado.
- **Configuración** (solo administradores): **Formato de numeración** (**Patrón**, por ejemplo `{N:7}/{YYYY}`), **Siguiente número de secuencia**, **IVA (%)**, y una **Plantilla HTML** de factura con vista previa y variables de plantilla. Pulsa **Guardar configuración**.

Las solicitudes de factura de los huéspedes llegan desde su portal (capítulo 06). Ellos indican nombre, NIF y dirección y tú generas la factura.

## 2. Transacciones

La pantalla **Transacciones** muestra todos los cobros imputados en el sistema. Tiene hasta tres pestañas:

- **Transacciones**: lista con filtros. Los usuarios que no son Dirección ven solo un día (**Día**); Dirección elige **Desde** y **Hasta**. Filtros: **Forma de pago**, **Facturada** (**Sí, facturada** / **No facturada**), **Canal**. Pulsa **× Limpiar** para limpiar. Columnas: Fecha, Reserva, Huésped, Habitación, OTA, Caja, Usuario, Descripción e importe. Abajo ves el **Total imputado** y puedes paginar con ‹ Anterior y Siguiente ›.
- **Recogidas** (solo dirección): recogidas de efectivo (ver más abajo).
- **Configuración** (solo dirección): cajas y formas de pago.

Para corregir una transacción, ábrela desde la lista. Los cambios de fecha y hora de cobro quedan registrados.

### Recoger efectivo (solo dirección)

1. Ve a **Transacciones → Recogidas**.
2. Pulsa **Recoger efectivo**.
3. Indica el rango **Desde (cobros efectivo)** y **Hasta (cobros efectivo)**. El sistema calcula el importe pendiente de recoger.
4. Indica la **Fecha y hora de recogida** y una **Nota (opcional)**, por ejemplo "Entregado en administración".
5. Pulsa **Registrar recogida**. Verás **Recogida registrada**.

La lista de recogidas muestra la fecha, el periodo, quién recogió, la nota y el importe, con el **Total recogido**.

### Cajas y formas de pago (solo dirección)

En **Transacciones → Configuración**:

- **Cajas**: pulsa **+ Nueva caja** y rellena **Nombre \***. Marca las opciones que apliquen: **Es tarjeta / TPV**, **Es cuenta bancaria**, **Contar en turno**, **Caja por defecto**. Puedes **Editar** o **Eliminar** (el sistema pide desactivar o eliminar, las transacciones existentes no se modifican).
- **Formas de pago**: pulsa **+ Nueva forma de pago** e indica la **Clave interna \*** (solo minúsculas, números y `_`; no se puede cambiar después), la **Etiqueta \*** (el nombre que verán los usuarios) y el **Color**.

## 3. Cierre de turno

La aplicación no tiene un botón único de "Cerrar turno". El control del turno se hace con:

1. **Cobros del turno**: registra cada pago en la reserva con la caja y la forma de pago correctas (capítulo 02). Las cajas marcadas como **Contar en turno** son las que se cuentan para el turno.
2. **Arqueo de la caja de cambio** (sección 4): al menos dos al día.
3. **Verificación de depósitos en efectivo** (sección 4).
4. **Recogida de efectivo** por Dirección (sección 2).

La pantalla **Alertas → Por empleado** (solo dirección) usa los turnos de caja cerrados para calcular cuántas alertas atendió cada persona. Si necesitas un cierre formal distinto, consúltalo con Dirección.

## 4. Caja de cambio

La pantalla **Caja de cambio** (Recepción y Dirección) sirve para contar el efectivo de la caja de recepción y anotar los gastos que se pagan de ella.

### Hacer un arqueo

1. Cuenta el efectivo y escribe cuántas **Monedas** (5, 10, 20 y 50 cts, 1 € y 2 €) y **Billetes** (5, 10, 20, 50 y 100 €) tienes.
2. La pantalla calcula **EFECTIVO CONTADO** y suma **+ GASTOS SIN REPONER**.
3. Compara el resultado con la **CONSIGNA** (el importe fijo que debe haber en la caja; por defecto 500 €, editable en el campo de la consigna). La pantalla indica **✓ Cuadra**, **Sobran …** o **Faltan …**.
4. Pulsa **💾 Guardar caja**. Verás **Caja guardada**.

Debes hacer al menos dos arqueos al día: el primero antes de las 15:15 y el segundo antes de las 23:15. Si no, aparece una alerta. Si el efectivo más los gastos sin reponer es menor que la consigna, hay una alerta de descuadre.

### Gastos por reponer

1. En **Gastos por reponer**, escribe el **Concepto (p.ej. pilas mando)** y el importe.
2. Pulsa **+ Añadir**. Verás **Gasto añadido**.
3. Cuando repongas el dinero a la caja, pulsa **↻ Reponer todo**. Los gastos pasan a **Repuesto**.
4. Puedes eliminar un gasto con confirmación **¿Eliminar este gasto?**.

### Verificar depósitos en efectivo

1. En **Depósitos en efectivo — verificación**, la lista muestra los depósitos en efectivo de reservas en casa.
2. Marca cada depósito que hayas contado físicamente en la caja y pulsa **✓ Confirmar recuento (marcados/total)**.
3. Si todo cuadra verás **Depósitos verificados: todo cuadra**. Si faltan depósitos, se registra un descuadre (**Descuadre: faltan N depósito(s) por marcar**) en el histórico.

También se exigen dos verificaciones diarias.

### Histórico

Muestra **Últimos arqueos** (fecha y hora, usuario, efectivo y consigna), el **Histórico de gastos** (concepto, importe, quién lo añadió y quién lo repuso) y los **Descuadres de depósitos** (activos en sistema, contabilizados y faltan).

## 5. Facturación (solo dirección)

La pantalla **Facturación** da la visión económica del periodo. Elige el rango de fechas con los accesos rápidos (**Anteayer**, **Última semana**, **Último mes**, **Personalizado**) y pulsa **Aplicar**. Pestañas:

- **Pendiente**: reservas con saldo pendiente en el periodo.
- **Resumen**: **Facturado**, **Cobrado** y **Pendiente**, desglosado por canal, por forma de pago y por caja.
- **Todas**: lista de reservas del periodo con huésped, habitación, estancia, total, pagado y saldo.
- **Gráficas**: ingresos por canal y evolución (**Agrupar** por día o por mes). Permite comparar con otro periodo (**Período B**: periodo anterior o año anterior).
- **Caja**: **Conciliación bancaria por día**, con el importe del sistema, el del banco y la diferencia.
