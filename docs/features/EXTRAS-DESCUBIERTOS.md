# Extras descubiertos: auditoria de huecos sobre `01-FUNCIONALIDADES.md`

> Auditoria de solo lectura del codigo de `/home/bob/Documents/betania-booking-manager` (rama `dubai`). Se leyo `docs/01-FUNCIONALIDADES.md` y despues se barrieron `src/routes`, `src/lib`, `src/db/schema`, `drizzle/` (por nombre), `frontend/views`, `frontend/components`, `frontend-public`, `scripts`, `deploy`, `ideas.txt` y `APRENDIZAJE.txt` (este ultimo es un tutorial de Bun/Hono/Drizzle, sin funcionalidades de producto).
> Rutas de fichero relativas a la raiz del repo del PMS. Cada hallazgo se verifico en codigo (lectura directa o grep); no se ejecuto nada.
> Columna "En 01": **No** = no aparece; **Parcial** = aparece pero sin el detalle que lo hace vendible; **Si** = ya esta bien contado (se incluye solo si el detalle comercial merece mas peso).
> Conclusion previa: el usuario tiene razon. 01 es muy completo en inventario de modulos, pero se deja casi todos los **controles de calidad y antifraude**, las **herramientas de conciliacion** y varios **detalles de experiencia** que son lo que diferencia a este PMS de uno generico.

---

## Valor comercial ALTO

### 1. Puertas de calidad en el check-in con justificacion auditada
- **Que hace.** El check-in se bloquea si: hay contrato sin firmar, no hay deposito registrado, el huesped conserva el email alias de Booking (`@guest.booking.com`) o falta municipio INE valido. Para saltarse tarjeta ZKTeco, parte SES o contrato, el recepcionista debe escribir un motivo de **minimo 15 palabras**, que queda guardado como nota de la reserva ("Check-in sin tarjeta ZKTeco. Motivo: ...").
- **Donde.** `src/routes/reservations.ts` (POST `/:id/check-in`, ~lineas 1083-1285); `frontend/views/ReservationDetailView.tsx` (modales ~2617-2700, `doCheckInExecute` ~1281); flags `checkinHadContract/checkinZktecoEnrolled/checkinSesSent` en `src/db/schema/reservations.ts`.
- **Por que vende.** Cumplimiento (SES, contrato) sin depender de la disciplina del personal; la direccion ve despues quien se salto que y por que. El informe Recepcion y el agente lo usan ("pasos pendientes de check-in").
- **En 01:** Parcial (solo se mencionan flags y alerta `checkin-abandoned`).

### 2. Bloqueo de check-out con depositos sin resolver
- **Que hace.** No se puede hacer check-out mientras quede un deposito con dinero (efectivo o preautorizacion CC) sin cobrar ni devolver. El check-in exige al menos un deposito activo.
- **Donde.** `src/routes/reservations.ts` (check-out ~1285 y check-in ~1115); logica "devuelto" = fila `deposit_return` con descripcion `dep:<id>`.
- **Por que vende.** Cierra el agujero clasico de fianzas olvidadas; cuadra con la Caja de cambio.
- **En 01:** No.

### 3. Reutilizacion automatica de la tarjeta en estancias consecutivas
- **Que hace.** Si el mismo titular (por documento, no por id de huesped) entra el mismo dia en que sale su reserva anterior en la misma habitacion, el sistema reutiliza la tarjeta ya enrolada y la reprograma en TTLock con la ventana completa. Al hacer check-out o cancelar la tarjeta se revoca pero no se borra (`zktecoCardRevokedAt`).
- **Donde.** `src/routes/reservations.ts` (bloque "Enrolado automatico por reserva consecutiva"); `src/db/schema/reservations.ts`; migracion `0118_zkteco_card_revoked_at.sql`.
- **Por que vende.** Cero friccion para estancias largas renovadas por tramos (muy comun en hostal/aparthotel con residentes).
- **En 01:** No.

### 4. Motivo obligatorio (>=5 palabras reales) en cambios delicados
- **Que hace.** Cambiar de habitacion a un huesped ya en casa, o a un tipo virtual, o quitar extras exige un motivo de al menos 5 palabras con letras o numeros (la puntuacion suelta no cuenta). Se valida en servidor y tambien cuando lo hace el agente de IA; el motivo se guarda en el historial.
- **Donde.** `src/lib/textValidation.ts` (`hasMinWords`, con tests); `src/routes/reservations.ts` (~848-874, 985); `src/routes/ai.ts` (~3988); `frontend/components/RoomChangeReasonField.tsx`; `PlanningView.tsx` (`MoveConfirmModal`).
- **Por que vende.** Trazabilidad y antifraude interno sin burocracia. Es la "validacion de texto" que 01 cita pero sin explicar para que sirve.
- **En 01:** Parcial.

### 5. Conciliacion bancaria por dia
- **Que hace.** En Facturacion se pegan los movimientos del banco (fecha + importe, una linea por dia) y el sistema compara por dia lo cobrado segun PMS frente al banco, por caja o global, marcando diferencias mayores de 0,02 EUR.
- **Donde.** `frontend/views/BillingView.tsx` (~565-660, `bankText`, `reconcileDates`).
- **Por que vende.** Un gestor o administrador lo entiende al instante: cierre mensual sin Excel.
- **En 01:** No (01 solo habla de scripts de reconciliacion de facturas).

### 6. Comparacion de periodos A vs B en Facturacion
- **Que hace.** Activa un segundo rango de fechas y muestra cada KPI con variacion absoluta y porcentual frente al periodo de referencia (verde/rojo). Presets Hoy/Ayer/Anteayer/Semana/Mes/Personalizado.
- **Donde.** `frontend/views/BillingView.tsx` (`compareActive`, `CompareKpi` ~707).
- **Por que vende.** Respuesta inmediata a "como vamos frente al mes pasado / el ano pasado".
- **En 01:** No.

### 7. Informe "Efecto reglas" con veredicto y consejo automatico
- **Que hace.** Para cada regla de precio dinamico mide reservas de esa noche 72 h antes y despues de cada cambio y emite veredicto (Funciona / Sin efecto / Perjudica / Pocos datos) con un consejo textual ("rebajas sin mas reservas: se esta regalando precio, reduce el descuento..."). Umbral minimo de cambios para opinar. El agente lo consulta en el briefing matutino.
- **Donde.** `src/lib/pricingEffects.ts` (`judge`, con tests); `src/routes/pricing-effects.ts`; `frontend/views/ReportsView.tsx` (`EfectoReglasReport`, ~2048).
- **Por que vende.** Es revenue management que se audita a si mismo: la mayoria de competidores no te dicen si su automatizacion funciona.
- **En 01:** Parcial (se nombra el informe, no el veredicto).

### 8. Push diferencial de precios y disponibilidad (FDM y Jumbo)
- **Que hace.** Guarda el ultimo vector {precio, disponibilidad, cerrado} enviado por fecha x tarifa x tipo (`fdm_push_state`, `jumbo_push_state`) y solo reenvia lo que cambio, incluida la disponibilidad aunque el precio no cambie. Opcion `force` para resincronizar todo. Jumbo se empuja en segundo plano con estado consultable.
- **Donde.** `src/routes/fdm.ts` (~147-370); `src/lib/jumbo-push.ts`; migraciones `0120`-`0123`.
- **Por que vende.** Menos llamadas, menos riesgo de pisar al channel manager y sincronizacion casi en tiempo real tras cada pasada del motor.
- **En 01:** Parcial.

### 9. Sincronizacion FDM con autoasignacion de habitacion
- **Que hace.** Al importar reservas de FDM paginando hasta pagina incompleta (evita truncados silenciosos), asigna la habitacion preferida si esta libre y sin bloqueos; si no, busca otra del mismo tipo. Entiende reservas multihabitacion (`Room` = "307,308"), no sobreescribe nunca el `total` local y guarda `originalTotal` y la comision real del canal (`bmCommission`). Importa tambien **facturas y transacciones** de FDM.
- **Donde.** `src/routes/fdm.ts` (83-90, 408-560, 775-850); `scripts/fdm-sync-cron.ts` (modo `--debug` antes -> despues); `src/db/schema/reservations.ts`.
- **Por que vende.** Es la historia de migracion: "vienes de FrontDesk Master y sigues operando sin perder nada". Reutilizable como modelo para otros PMS de origen.
- **En 01:** Parcial.

### 10. Auditoria de comisiones de OTA
- **Que hace.** El informe Comisiones calcula sobre `originalTotal` (sin extras ni ampliaciones, que no pagan comision) y usa la comision real que reporta el canal cuando existe. Un script compara el extracto de Booking con el 15 % de lo realmente pagado y detecta cobros de mas.
- **Donde.** `src/routes/reports.ts` (783-895, edicion `PATCH /commissions/:channelId`); `scripts/compare-booking-commissions.ts`.
- **Por que vende.** Dinero recuperable: "te decimos cuando Booking te cobra de mas".
- **En 01:** Parcial.

### 11. Agente de IA "gerente proactivo" (no solo chatbot)
- **Que hace.** El prompt incorpora directrices permanentes de direccion: objetivo ocupacion 100 %, cuestionar bloqueos y huecos, vigilar cambios de precio, pedir valoracion de huespedes, agrupar incidencias por causa raiz y preguntar de forma constante y concreta a cada rol. Es ademas **traductor** (traduce mensajes de huespedes y propone respuesta en su idioma), conoce la regla de pago de Agoda (cobra en check-out, no es impago), aplica valoracion 1-10 tras cada check-out, recibe una **foto del hotel cacheada 5 min** (`hotelSnapshot`) y para comparar anos llama a `get_period_summary` por periodo.
- **Donde.** `src/routes/ai.ts` (`systemPrompt` ~201-300, `hotelSnapshot` ~169, `BRIEFING_PROMPT` ~4803).
- **Por que vende.** "El director trabaja lo minimo: el agente detecta, pregunta y propone; el aprueba con un si/no".
- **En 01:** Parcial (se listan tools, no la filosofia de gerente ni el traductor).

### 12. Briefing matutino con comparativa interanual y borradores
- **Que hace.** Cada manana, solo lectura, revisa salud del motor de precios, efecto de reglas, competidores 14 dias, ocupacion vs mismos dias del ano pasado, quejas abiertas y alertas; termina con "preguntas para ti" (max. 4). Los mensajes al personal que propone quedan como BORRADOR, nunca se envian solos.
- **Donde.** `src/routes/ai.ts` (`BRIEFING_PROMPT`, `BRIEFING_SYSTEM_EXTRA`, `runDirectorBriefing` ~4803-4840).
- **Por que vende.** Seguridad: IA que propone pero no actua sin humano.
- **En 01:** Parcial.

### 13. Cobros con tarjeta conciliables con el TPV
- **Que hace.** Todo pago con tarjeta exige el numero de pedido/operacion de la terminal o, alternativamente, el flujo completo "Cobrado en otro turno" (fecha/hora real y quien cobro). Se compara por clave y etiqueta de la forma de pago, por si el admin la renombro.
- **Donde.** `src/routes/financial.ts` (~361-398); `src/db/schema/financial.ts` (`cardOperationNumber`); migracion `0101_card_operation_number.sql`.
- **Por que vende.** Cuadre de TPV a final de mes sin buscar a ciegas.
- **En 01:** No (solo se menciona "Cobrado en otro turno").

### 14. Lista negra de huespedes con severidad
- **Que hace.** Boton "L. Negra" en la ficha de la reserva con motivo y severidad; la reserva muestra banner rojo a quien la abra.
- **Donde.** `frontend/views/ReservationDetailView.tsx` (~1159, 1622, 1934-1943, 4020); `src/db/schema/guests.ts` (`blacklistReason/Severity`); `src/routes/guests.ts`.
- **Por que vende.** Memoria compartida del hotel sobre huespedes problematicos.
- **En 01:** No.

### 15. Anonimizacion RGPD y consentimiento de email
- **Que hace.** Borrar un huesped no elimina la fila: anonimiza datos identificativos y conserva el historial contable. Consentimiento de email por huesped (`emailConsentGiven`), aviso explicito en la ficha.
- **Donde.** `src/routes/guests.ts` (DELETE `/:id`, ~339-375); `frontend/views/GuestsView.tsx` (~586, 671).
- **Por que vende.** Argumento de compliance europeo ("derecho al olvido" sin romper facturas).
- **En 01:** No.

### 16. Proteccion contra emails inventados
- **Que hace.** Bloquea guardar el alias temporal de Booking y detecta emails sospechosos (alias OTA sustituido por dominio gratuito parecido al nombre); el recepcionista debe declarar que el cliente se lo dio personalmente y queda registrado con su nombre y hora.
- **Donde.** `frontend/views/ReservationDetailView.tsx` (`detectSuspiciousEmail` ~2968, modal ~3174); `src/routes/guests.ts` (322, PATCH); bloqueo tambien en check-in.
- **Por que vende.** Calidad de datos: los emails reales alimentan magic link, resenas y recuperacion de carritos.
- **En 01:** Parcial (solo "sustitucion del email temporal").

### 17. Planning operativo: arrastrar, menu contextual, rango y precio en cabecera
- **Que hace.** Arrastrar reservas entre habitaciones/fechas con modal de confirmacion que muestra actual vs nuevo (y pide motivo si procede); clic derecho en celda -> nueva reserva o bloquear cama; seleccion de rango (`RangeMenu`); clic derecho en reserva -> mover/borrar; tarjetas de ocupacion Hoy / Semana / Seleccion con **edicion en linea del precio Dir AL y Dir HD**; saltos rapidos (GotoDropdown); boton de sincronizacion FDM (ayer a +365 dias).
- **Donde.** `frontend/views/PlanningView.tsx` (`MoveConfirmModal` 1214, `ResContextMenuPopup` 1294, `RangeMenu` 1144, `OccRateInput` 811, `FdmSyncButton` 1488).
- **Por que vende.** Es la pantalla que se ensena primero en una demo y 01 la reduce a "Gantt por rango".
- **En 01:** Parcial.

### 18. Google Ads: conversiones mejoradas, linker entre dominios y deduplicacion
- **Que hace.** Solo dispara la conversion con importe realmente pagado; `user_data.email` para enhanced conversions; `linker` entre la web del hotel y el dominio del motor; `transaction_id` + localStorage contra doble disparo.
- **Donde.** `frontend-public/gtag.ts`; `GET /api/public/config` en `src/routes/public.ts`.
- **Por que vende.** Mide el retorno de la publicidad de pago con precision; argumento clave para hoteles que invierten en Google Ads.
- **En 01:** Parcial.

### 19. Widget embebible con protocolo postMessage
- **Que hace.** Los iframes emiten y reciben mensajes: altura/expansion (`betania-widget-height`), reset, scroll al inicio, idioma en vivo (`betania-widget-lang`), cierre del portal y apertura del motor desde el portal. El idioma lo manda la pagina anfitriona.
- **Donde.** `frontend-public/booking-widget.tsx` (21, 413, 426); `portal-widget.tsx` (41, 45, 797); `i18n.ts` (`useWidgetLang`).
- **Por que vende.** Instalacion en la web del hotel sin tocar CSS ni scroll; el portal del huesped tambien existe como widget (7 idiomas en `i18n-portal.ts`, no solo el motor).
- **En 01:** Parcial (01 dice 7 idiomas solo para el motor).

### 20. Un solo binario, test y produccion en paralelo, backup nocturno
- **Que hace.** `bun build --compile` genera un ejecutable unico con el frontend y el contrato PDF embebidos; despliegue por rsync + systemd; entornos `test` (puerto 3001) y `prod` (3000) con nginx que sirve `booking.` y `booking-test.`; backup `pg_dump -Fc` diario a las 03:00 por timer systemd con retencion.
- **Donde.** `package.json` (scripts `build`, `deploy:*`); `deploy/*.service`, `deploy/nginx.conf`, `scripts/betania-db-backup.timer`, `scripts/backup-db.sh`.
- **Por que vende.** Instalacion barata y reproducible para otros hoteles, con entorno de pruebas incluido.
- **En 01:** Parcial (se cita backup solo como deuda).

### 21. Expedia a traves de Nobeds
- **Que hace.** Pantalla "Enviar tarifas a Expedia": elige tarifa (p. ej. "Expedia AL"), rango y empuja precios + disponibilidad calculada a Nobeds; mapeo de tipos; sincronizacion de reservas.
- **Donde.** `frontend/views/NobedsSyncView.tsx` (~162-300); `src/routes/nobeds.ts` (`push-prices`, `push-availability`).
- **Por que vende.** Segundo canal real conectado por precio, no solo importacion.
- **En 01:** Parcial (01 dice "empujar tarifas" sin citar Expedia).

### 22. Mapas de procedencia a nivel provincia espanola
- **Que hace.** Mapas coropleticos mundial y de provincias de Espana (provincia = 2 primeros digitos del INE; si el huesped no tiene INE se cruza la ciudad por nombre), en SVG puro sin servicios externos.
- **Donde.** `frontend/components/GeoMaps.tsx`; `frontend/data/geo/*`; `src/routes/guests.ts` (`/stats`, ~214-285).
- **Por que vende.** Marketing y turismo regional: de donde viene el cliente, sin Google Maps.
- **En 01:** Parcial.

---

## Valor comercial MEDIO

### 23. Candado de desayunos
- **Que hace.** Entre las 09:30 y las 11:30 (Madrid), quien abre la pestana Desayunos queda "armado": cualquier clic que le saque de Housekeeping le pide confirmar que ya marco todos los desayunos. Es por usuario y fecha; se libera solo a las 11:30.
- **Donde.** `frontend/components/BreakfastLockGuard.tsx`; `HousekeepingView.tsx` (`armBreakfastLock`).
- **Por que vende.** Disciplina operativa sin policia: ejemplo de UX pensada para personal real.
- **En 01:** No.

### 24. Mensajes "Importante ahora" bloqueantes con acuse
- **Que hace.** Direccion (o el agente) envia un mensaje importante que bloquea la pantalla del destinatario: no se cierra con Escape ni clic fuera y el boton "Leido" se habilita tras 10 s. El acuse queda registrado. Encuesta cada 30 s.
- **Donde.** `frontend/components/ImportantStaffMessagePopup.tsx`; `src/routes/ai.ts` (`/important-messages`, `/:id/ack`); migracion `0124_staff_messages_important.sql`.
- **Por que vende.** Comunicacion interna con prueba de lectura, sin WhatsApp de grupo.
- **En 01:** Parcial.

### 25. Implicacion: popup solo si > 80, horas de trabajo y compensaciones
- **Que hace.** El popup semanal solo aparece si el rating supera 80 (reconocer, no presionar). La vista muestra comparativa por tipo de accion, actividad diaria y **horas del dia en que trabaja cada persona en la plataforma**, ademas de las compensaciones de direccion.
- **Donde.** `frontend/components/EngagementWeeklyPopup.tsx`; `frontend/views/EngagementView.tsx` (64, 128-149); `src/routes/engagement.ts`.
- **Por que vende.** Gestion de personal con enfoque positivo y transparente.
- **En 01:** Parcial.

### 26. Housekeeping: tiempo de respuesta medido
- **Que hace.** Registra `assignedAt` por tarea (solo si cambia la asignacion) para calcular el tiempo desde asignar hasta completar; excluye las tareas auto-asignadas al completarlas. Alimenta el informe Housekeeping por trabajador.
- **Donde.** `src/routes/housekeeping.ts` (~197-215); migracion `0081_hk_task_assigned_at.sql`; `reports.ts` (`/housekeeping-staff`).
- **Por que vende.** Productividad medible de limpieza.
- **En 01:** Parcial.

### 27. Presencia en la barra superior
- **Que hace.** Ping cada 60 s; avatares con iniciales de los usuarios conectados (los ultimos 90 s), hasta 5 mas contador.
- **Donde.** `frontend/components/Topbar.tsx`; `src/routes/users.ts` (`/presence/ping`, `/presence`); tool `get_online_users` del agente.
- **Por que vende.** Sensacion de equipo en una sola pantalla.
- **En 01:** Si (se lista, merece mas peso visual en demo).

### 28. Pregunta diaria "donde te gustaria estar" y fondo de pantalla
- **Que hace.** Una vez al dia, a hora aleatoria, el asistente pregunta donde le gustaria estar al usuario y le pone una foto de ese lugar como fondo (Pexels, con atribucion). Direccion puede fijar el fondo de otro usuario.
- **Donde.** `frontend/components/AgentFloat.tsx` (~33, 166-210); `src/routes/ai.ts` (`BACKGROUND_KICKOFF` ~4957); `src/lib/pexels.ts`; migracion `0047_dashboard_background.sql`.
- **Por que vende.** Toque humano memorable en demos; reduce rechazo del personal a la herramienta.
- **En 01:** Parcial.

### 29. Voz del navegador con envio automatico y TTS opcional
- **Que hace.** Dictado con deteccion de silencio que envia solo; lectura en voz alta apagada por defecto (por dispositivo), sin releer historial al restaurar sesion; el Resumen rapido es un chat solo de voz.
- **Donde.** `frontend/components/AgentFloat.tsx` (~18-100); `frontend/lib/speech.ts`; `AdminQuickStats.tsx` (`VoiceChat`).
- **Por que vende.** Manos libres para recepcion y direccion en movil.
- **En 01:** Parcial.

### 30. Modo admin simplificado forzado
- **Que hace.** Si el usuario lo tiene activado (Usuarios -> Editar), toda su sesion se sustituye por el Resumen rapido: sin menu, sin X; solo cerrar sesion. Ocupacion hoy, cobrado por metodo, reservas nuevas, llegadas pendientes con saldo y chat de voz.
- **Donde.** `frontend/components/Layout.tsx` (~44); `frontend/components/AdminQuickStats.tsx`; migracion `0129_simplified_admin_mode.sql`.
- **Por que vende.** Propietarios no tecnicos: "tu dashboard en una pantalla, sin tocar nada".
- **En 01:** Si (una linea; es el "dashboard de direccion a pantalla completa").

### 31. Selector "ver como rol"
- **Que hace.** La direccion puede ver la interfaz como Recepcion, Conserje, Mantenimiento, Limpieza o Cocina para comprobar permisos.
- **Donde.** `frontend/components/Sidebar.tsx` (`VIEW_AS_ROLES` ~46).
- **Por que vende.** Formacion y soporte: ensenar a cada rol lo que vera.
- **En 01:** Si (mencion breve).

### 32. Extras con tipos de precio y venta en el motor
- **Que hace.** Cada extra se cobra por estancia, por noche, por persona o por persona y noche, con cantidad maxima, icono, color, IVA propio y visibilidad en el motor web. Informe de ventas de extras.
- **Donde.** `src/db/schema/financial.ts` (`saleItems`); `src/routes/public.ts` (~403-406); `src/routes/catalog.ts` (`/sale-items`, `/sale-items/sales`); `frontend/views/ExtrasView.tsx`.
- **Por que vende.** Upselling configurable (desayuno, parking, cuna) sin desarrollo.
- **En 01:** Parcial.

### 33. Preferencia de cama twin con alerta de descuadre
- **Que hace.** El huesped marca "dos camas" al reservar; al asignar habitacion, si la cama no es twin salta una alerta agrupada.
- **Donde.** `src/routes/public.ts` (~295, 495, 514); `src/db/schema/reservations.ts` (`bedPreferenceTwin`); alerta `bed-preference-mismatch-group` en `src/routes/alerts.ts`; migracion `0084`.
- **Por que vende.** Cuida un detalle que genera resenas negativas.
- **En 01:** Parcial.

### 34. Campos editables por rol y por canal
- **Que hace.** Direccion decide que campos de la reserva puede tocar cada rol y para que canales (p. ej. total, tarifa, codigo externo).
- **Donde.** `frontend/views/ReservationsView.tsx` (`FieldRulesConfig` ~33); `src/routes/settings.ts` (`/field-rules`); `src/db/schema/reservations.ts`.
- **Por que vende.** Permisos finos sin crear roles nuevos.
- **En 01:** Parcial.

### 35. Nombres bloqueados y canales exentos de saldo
- **Que hace.** Lista editable de nombres basura que el sistema rechaza al crear o editar huespedes; lista de canales que reciben codigo de cerradura aunque tengan saldo pendiente.
- **Donde.** `ReservationsView.tsx` (`BlockedGuestNamesConfig` ~141, `TtlockBalanceExemptConfig` ~234); `src/routes/settings.ts`.
- **Por que vende.** Higiene de datos y reglas de negocio configurables desde la UI.
- **En 01:** Parcial.

### 36. Exportacion CSV paginada con BOM UTF-8
- **Que hace.** Descarga todas las filas de un filtro paginando (tope servidor 1000) en CSV con BOM para que Excel respete tildes. Disponible en Reservas y Facturas.
- **Donde.** `ReservationsView.tsx` (~80-130); `InvoicesView.tsx` (~356).
- **Por que vende.** Sin lock-in de datos. **Nota:** 01 dice "Excel (xlsx)"; es CSV (la libreria `xlsx` solo la usan scripts de importacion).
- **En 01:** Parcial (con error).

### 37. Empresas candidatas: el CIF puede venir solo de la factura
- **Que hace.** Detecta empresas por forma de CIF en el NIF de la reserva y tambien mirando el NIF de las facturas (la ultima prevalece); lista clientes con mas de una reserva en 6 meses como candidatos a precio semanal; flujo borrador/enviada/aceptada/rechazada.
- **Donde.** `src/routes/corporate.ts` (17-80); `src/lib/corporateDetection.ts`; `frontend/views/CorporateView.tsx`.
- **Por que vende.** Un CRM minimo de cuentas corporativas.
- **En 01:** Parcial (ver seccion de funcionalidades a medias: las ofertas no se aplican solas).

### 38. Recogidas de efectivo
- **Que hace.** Historial de recogidas de caja con rango de fecha-hora y calculo del efectivo desde la ultima recogida (usa `createdAt`, unico campo con hora precisa).
- **Donde.** `src/routes/financial.ts` (~1034-1135); `TransactionsView.tsx` (`CollectionsTab`); migraciones `0061`-`0063`.
- **Por que vende.** Control de efectivo entre turnos y direccion.
- **En 01:** Parcial.

### 39. Validacion de domicilio y municipio INE para SES
- **Que hace.** Antes de guardar al huesped exige pais valido de lista, ciudad/CP coherentes y municipio INE de 5 digitos (con base postal offline); advierte de direccion incompleta.
- **Donde.** `ReservationDetailView.tsx` (~3115-3140); `src/routes/postal.ts`; `src/lib/postal-es.json`.
- **Por que vende.** Partes SES sin rechazos por datos incompletos.
- **En 01:** Parcial.

### 40. Feed "Ultimas reservas" en el inicio
- **Que hace.** Tarjetas con hora exacta (segundos si es de hoy), canal coloreado, estancia, tarifa, total, estado y el comentario del huesped destacado en amarillo (`extraField2`).
- **Donde.** `frontend/views/DashboardView.tsx` (~126-225); `GET /dashboard/recent`.
- **Por que vende.** "Ves entrar las reservas en directo".
- **En 01:** Parcial.

### 41. Check-in: tiempo por empleado y pasos pendientes
- **Que hace.** Mide inicio y fin del proceso de check-in, abandonos y duracion media por empleado (franja mas habitual); el agente avisa de check-ins hechos con pasos pendientes (contrato, tarjeta, SES).
- **Donde.** `src/routes/reservations.ts` (`/checkin-start`, `/checkin-abandon`); `reports.ts` (`/checkin-time` 644); `src/routes/ai.ts` (system prompt: `checkin_time_by_employee`).
- **Por que vende.** Eficiencia de recepcion con datos, no con impresiones.
- **En 01:** Parcial.

### 42. Consola AI Debug con trazas en vivo
- **Que hace.** Chat de depuracion que muestra la traza de ejecucion (tools llamadas) y logs por SSE desde un bus interno de logs.
- **Donde.** `frontend/views/AiDebugView.tsx`; `src/lib/log-bus.ts`; `/ai/debug-chat`, `/ai/logs`.
- **Por que vende.** Transparencia de la IA ante cliente tecnico; "ves por que respondio eso".
- **En 01:** Si (una linea).

### 43. Scripts de migracion y auditoria
- **Que hace.** Comparar reservas y tarifas entre la BD actual y un backup restaurado, importar participantes de un grupo desde Excel (`.xls`), edicion masiva de acompanantes (copiar direccion, cambiar tipo de documento), limpiar importaciones, `ai-ask.ts` como REPL del agente, seeds.
- **Donde.** `scripts/compare-reservations.ts`, `compare-rates.ts`, `import-guests-xls.ts`, `bulk-update-reservation-guests.ts`, `clean-import.ts`, `ai-ask.ts`.
- **Por que vende.** Onboarding de nuevos hoteles con red de seguridad ("probamos contra tu backup y ves exactamente que cambio").
- **En 01:** Parcial.

---

## Valor comercial BAJO

### 44. Seis temas, cuatro fuentes y cinco tamanos
- **Que hace.** Oscuro, Claro, Especial, Retro, Bosque y "Hotdog"; Sistema/Inter/Georgia/Mono; tamanos XS-XL por usuario; fondo de panel personalizado.
- **Donde.** `frontend/views/SettingsView.tsx` (8-29); `user_preferences`.
- **En 01:** Parcial. Util para accesibilidad y personal mayor.

### 45. Busqueda global con teclado
- **Que hace.** Busqueda por ID, codigo externo, nombre o habitacion con debounce de 220 ms y navegacion con flechas y Enter; no hay mas atajos globales de teclado en la app.
- **Donde.** `frontend/components/Topbar.tsx`; `reservations.ts` (`/search`).
- **En 01:** Si.

### 46. Notas internas tipificadas
- **Que hace.** `reservation_notes.type` distingue nota manual de registro automatico de cambio; el historial mezcla ambas con el log de estados.
- **Donde.** `src/db/schema/reservations.ts`; migracion `0004_reservation_notes_type.sql`; `statusLog.ts`.
- **En 01:** Parcial.

### 47. Lavanderia: estado "rotas" y acuse de discrepancias
- **Que hace.** Las prendas se clasifican en listas/tendidas/en agua/sucias/rotas por tipo (ducha, manos, sabanas, pies); el entregador debe reconocer discrepancias con el receptor.
- **Donde.** `frontend/views/LaundryView.tsx` (5-16); `src/db/schema/laundry.ts`; migracion `0059`.
- **En 01:** Parcial (no cita "rotas").

### 48. Confirmacion de reserva imprimible
- **Que hace.** HTML listo para imprimir o guardar como PDF, con envio manual por email o WhatsApp.
- **Donde.** `src/routes/reservations.ts` (`/confirmation-print` ~1551).
- **En 01:** Si.

### 49. Canal de eventos locales a direccion
- **Que hace.** A las 09:00 busca eventos en Benalmadena/Malaga (SerpAPI) y envia mensaje interno a direccion si hay eventos de impacto alto o medio en 30 dias.
- **Donde.** `src/lib/eventsScheduler.ts`; `src/lib/serpapi.ts`.
- **En 01:** Si.

### 50. Anotaciones de correccion en el cuadre de caja
- **Que hace.** Los depositos "cobrados" no se borran: se marca `resolvedAt/By`, distinguiendo registro original de resolucion.
- **Donde.** `src/routes/financial.ts` (`/transactions/:id/cobrar` ~521-565); migracion `0104_deposit_resolved_by.sql`.
- **En 01:** Parcial.

---

## Correcciones a 01 (afirmaciones inexactas verificadas)

| Punto en 01 | Realidad en codigo |
|---|---|
| "Notificaciones (`/notifications`, campana, solo direccion): lista y marcar leidas" | La pantalla `/notifications` (`NotificationsView.tsx`) es en realidad la **configuracion de mensajeria**: canales de envio, plantillas de email y plantillas de WhatsApp (llama a `/api/settings/messages` y `/message-templates`). No hay campana en la UI que liste la tabla `notifications`. |
| "Export a Excel de listados (`xlsx`)" | Los listados exportan **CSV con BOM UTF-8**. `xlsx` solo se usa en scripts de importacion. |
| SES: "alta, consulta de lote y anulacion" | `anularComunicaciones` existe en `src/lib/ses.ts` pero **ninguna ruta lo llama**; no hay anulacion desde la UI. |
| Chat en `AgentView` | `AgentView.tsx` no esta enrutado ni importado; el chat vive en `AgentFloat`. |
| Tabla de reservas con "tasa turistica" | `cityTax` y `cityTaxFromPortal` existen en schema pero **ningun codigo los usa**. |
| "Depositos de garantia" configurables | `deposit_items.requiredForCheckIn` no se lee en ninguna parte; la exigencia de deposito en check-in esta cableada en `reservations.ts`. |

---

## Funcionalidades que conviene destacar en la web y en las demos (top 15)

1. **Agente "gerente proactivo" con voz y briefing matutino** (hallazgos 11, 12, 29): el director solo aprueba con un si/no. Es el gancho principal.
2. **Motor de precios dinamico que se audita solo** (7 + 8 reglas de 01): veredicto Funciona/Perjudica y consejo, con empuje diferencial a los canales.
3. **Planning con arrastrar y soltar, menu contextual y precio en cabecera** (17): demo en 60 segundos.
4. **Puertas de calidad en el check-in con justificacion auditada** (1, 2, 4): cumplimiento sin policia.
5. **Conciliacion bancaria y comparacion de periodos** (5, 6): el gestor lo entiende al instante.
6. **Recuperacion de carritos, cancelaciones y descuento temporal con contador** (01 seccion 8) unido a **Google Ads con conversiones mejoradas** (18): del anuncio a la reserva medido.
7. **Portal del huesped y QR de habitacion**: magic link, check-in online, ampliacion autopagada, limpieza a peticion, informe de uso del QR (01 secciones 4 y 5), con widget embebible por postMessage (19).
8. **Cerraduras y accesos integrados con reutilizacion automatica de tarjeta** (3 + TTLock/ZKTeco de 01).
9. **SES Hospedajes con validacion previa y municipio INE** (39 + 01 seccion 12) y **escaneo de DNI con IA** (01 seccion 13).
10. **Caja de cambio, depositos y cobros conciliables con el TPV** (2, 13, 38 + 01 seccion 10).
11. **Modo admin simplificado + app Android con palabra de activacion "Betan"** (30 + 01 seccion 20): propietario sin menus.
12. **Mensajes importantes con acuse y alertas por rol** (24 + 31 alertas de 01): comunicacion con prueba de lectura.
13. **Migracion desde FDM/Nobeds/Jumbo sin perder datos** (9, 21, 43): historia de onboarding.
14. **Mapas de procedencia por provincia y demografia** (22): marketing sin herramientas externas.
15. **Implicacion del personal con enfoque positivo** (25) y **housekeeping medible** (26, 23): operativa y RRHH en una vista.

---

## Funcionalidades que estan a medias / sin emisor / muertas

**Sin emisor (hay almacenamiento o API, nada las alimenta)**
- **Tabla `notifications` y `src/routes/notifications.ts`**: ningun `insert` en todo el codigo; solo existe el esquema y la API de lectura. (La pantalla "Notificaciones" es otra cosa, ver correcciones.)
- **`reservation_notes.popupAt`**: la API acepta la fecha para mostrar una nota como popup al abrir la reserva, pero ni el modal de notas ni `ReservationDetailView` la leen ni la muestran.

**Pantallas o codigo huerfano**
- `frontend/views/FdmPushView.tsx`: no esta enrutada ni importada (el push FDM se lanza desde `PriceCalendarView`).
- `frontend/views/AgentView.tsx`: no esta enrutada ni importada (queda `/agent` en `TITLE_MAP` de `Topbar.tsx`).
- `src/lib/nobeds.ts`: `createBooking` y `updateBooking` sin ningun llamador (solo se importan reservas y se empuja disponibilidad/precios).
- `src/lib/ses.ts`: `anularComunicaciones` sin ruta ni UI.

**A medias**
- **Ofertas corporativas**: son un registro con estados; no se aplican automaticamente al precio de ninguna reserva, no se envian por email (`sentAt` solo se marca a mano) y el estado `expired` no se calcula nunca solo (`src/routes/corporate.ts`).
- **Reembolsos Stripe**: no hay ninguna llamada a refund en el codigo; las rectificativas y devoluciones se hacen contablemente, no en la pasarela.
- **Tasa turistica**: columnas `cityTax`, `cityTaxFromPortal` sin uso; no se calcula ni se factura.
- **Campos de reserva sin uso**: `autoAuthoriseStatus`, `autoChargeStatus` (tokenizacion), `onlineGuestUrl`, `serviceFee`.
- **Campos de huesped sin uso en UI**: `childRelationship`; `photoUrl` y `documentUrl` solo se vacian al anonimizar.
- **Extras**: `sale_items.commissionValue` sin uso; `deposit_items.requiredForCheckIn` sin efecto (ver correcciones).
- **Estado en memoria que se pierde al reiniciar**: limites de magic link y reset de contrasena, cache SerpAPI/TTLock, `lastProactiveCheckinDay` (ya en 24 de 01).
- **Aspiraciones de `ideas.txt` no implementadas**: turnos y horarios, buzon de tareas, menu de incidencias de habitacion, registros de inventario/higiene/piscina propios (hoy en la app Flask aparte), gestion documental, plantillas de factura multiples, mas integraciones menores y "testing para los empleados".
- **Backup**: `backup-db.sh` apunta a `betania_test` con `KEEP_DAYS=3` aunque su cabecera dice 14 dias; no cubre `public/avatars` (ya en 01).
- **Deploy**: README dice `root@...` pero `package.json` despliega con `direccion@...` (ya en 01).
