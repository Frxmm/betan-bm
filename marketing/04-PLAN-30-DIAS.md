# 04 · Plan de 30 días — del 3-oct al 1-nov de 2026

> **Objetivo único:** firmar el **primer cliente fundador** (propuesta aceptada + 50 % del setup cobrado)
> antes del **domingo 1 de noviembre de 2026**. El arranque real del piloto puede ser en noviembre-diciembre
> (temporada baja, que es cuando los hoteles cambian de sistema).
>
> **Restricciones reales:** Fran trabaja a jornada completa. Supuesto: **1-2 h/día entre semana (tardes/noches)
> y 4-5 h sábado y domingo** → unas **70-75 h en total**. Las visitas a hoteles necesitan horario de día:
> **reserva 2-3 días de vacaciones/asuntos propios** para las semanas 3 y 4 (demos), y aprovecha el
> **lunes 12-oct (festivo nacional)**. Las tardes de 17-20 h sirven para visitas: muchos propietarios están ahí.
>
> **Regla de oro del mes:** máximo 40 % del tiempo en código. Si te pillas programando "una cosita más" en vez
> de llamar a hoteles, para. El producto ya es mejor de lo que el mercado sabe.

---

## Checklist de desacoplamiento MÍNIMO (instancia por cliente)

Lo justo para demo y para firmar. El resto (multi-tenant, etc.) después del primer cliente.

**Para la demo (antes del 11-oct):**
- [ ] Instancia de demo separada (VPS propio, BD propia, dominio `demo.<marca>`), **sin datos reales de huéspedes**
- [ ] Script de seed: "Hotel Demo Sol", 20 hab., 3 tipos, tarifas, 30 reservas ficticias, llegadas hoy/mañana
- [ ] Branding por configuración en lo visible de la demo: nombre, logo, colores en motor de reservas, emails y WhatsApp
- [ ] `PROPERTY_ID` y textos "Hotel Betania" fuera de las pantallas que se ven en demo (grep de "Betania" en frontend y plantillas)
- [ ] Stripe en modo test, SES apuntando a **preproducción** (`pre-ses.mir.es`), TTLock con la cerradura del maletín
- [ ] Integraciones Jumbo/FDM/piscina **desactivables** por instancia (flags `isConfigured()` ya existen: comprobar que sin variables no rompen nada)

**Para el primer cliente (puede terminarse en noviembre, pero planificado y estimado en la propuesta):**
- [ ] Script de despliegue de instancia nueva (VPS + Postgres + migraciones + nginx + TLS) en < 1 h, probado 2 veces
- [ ] `.env` por cliente; secretos nunca en el repo; cuentas de terceros a nombre del cliente (Stripe, Meta, Nobeds, TTLock, SES)
- [ ] Plantillas de WhatsApp `{slug}_*` en la cuenta Meta del cliente
- [ ] Contrato de admisión, facturas y datos fiscales parametrizados (CIF, dirección, nº registro turístico)
- [ ] Backups diarios + copia externa + **restauración probada**
- [ ] Monitorización de uptime y alertas a tu móvil
- [ ] Revisión de permisos server-side y rate limiting en endpoints públicos (ver dossier, Fase 0 "Seguridad")
- [ ] Panel o log de salud de integraciones (ver 01)
- [ ] Ruta de actualización: cómo despliegas una versión en Betania + cliente 1 sin romper ninguno

---

## Semana 0 — Fin de semana de arranque (sáb 3 – dom 4 oct)

| Día | Tarea concreta | Tiempo | Entregable | Métrica |
|---|---|---|---|---|
| **Sáb 3** | (1) Leer contrato laboral y código ético de Redeia buscando exclusividad/actividades externas. (2) Pedir cita con asesor/gestoría para la semana. (3) Sacar las 6 cifras de Betania con consultas a la BD (ver 03 §3) | 4 h | Nota con cláusulas relevantes · cita fijada · tabla de 6 cifras | 6/6 cifras con número real |
| **Dom 4** | (1) Decidir nombre comercial y comprobar dominio libre. (2) Empezar lista de prospectos: Google Maps "hotel/hostal" en Benalmádena, Torremolinos, Fuengirola, Mijas, Málaga; filtrar por ICP (12-35 hab.). (3) Pedir a la dirección de Betania 3 contactos en caliente | 4,5 h | Dominio comprado · hoja "Prospectos" con 20 filas (nombre, hab., web, motor sí/no, reseñas con dolor, decisor, teléfono) | 20 prospectos |

## Semana 1 — Preparar (lun 5 – dom 11 oct)

| Día | Tarea concreta | Tiempo | Entregable | Métrica |
|---|---|---|---|---|
| **Lun 5** | Pedir hardware del maletín: 1 TTLock RFID+teclado, 1 gateway G2, 10 tarjetas, tablero; tablet barata si no tienes. Pedir presupuesto a 2 distribuidores TTLock en España (precio por volumen para el pack) | 1,5 h | Pedido hecho · 2 solicitudes de presupuesto | Hardware en camino |
| **Mar 6** | Desacoplamiento demo: grep "Betania"/`PROPERTY_ID` en frontend, emails y plantillas; lista de cambios con estimación | 1,5 h | Lista de cambios priorizada | Nº de ocurrencias a cambiar |
| **Mié 7** | Levantar VPS de demo + BD + despliegue (aunque sea manual, anotando cada paso → será el script) | 2 h | Demo accesible en `demo.<dominio>` | Despliegue OK |
| **Jue 8** | Seed "Hotel Demo Sol" + branding configurable en motor y emails | 2 h | Demo con datos ficticios | Reserva de prueba de punta a punta |
| **Vie 9** | Reunión/llamada con asesor: alta en pluriactividad, epígrafe IAE, tarifa plana vs bonificación, quién factura el hardware, RC | 1,5 h | Decisión de alta y fecha | Fecha de alta fijada |
| **Sáb 10** | (1) Hoja de producto A4 (1 página: dolor → solución → 3 cifras de Betania → precio fundador). (2) Plantilla de propuesta de 1 página (con los números de 02). (3) Completar lista hasta 30 prospectos | 5 h | PDF A4 · plantilla propuesta · 30 prospectos | **30 prospectos cualificados** |
| **Dom 11** | Grabar vídeo de 90 s (reserva → pago → WhatsApp → parte SES → puerta). Si la cerradura no ha llegado, grabar con la de Betania (con permiso). Publicar perfil de Google Business y página web de una sección | 4,5 h | Vídeo · web mínima · GBP creado | Vídeo publicado (no listado) |

## Semana 2 — Salir a la calle (lun 12 – dom 18 oct)

| Día | Tarea concreta | Tiempo | Entregable | Métrica |
|---|---|---|---|---|
| **Lun 12 (festivo)** | Montar maletín de cerradura, darlo de alta en la cuenta TTLock de demo y probar el flujo completo 3 veces. Ensayar la demo de 15 min en voz alta (cronometrada) | 4 h | Maletín funcionando · demo ensayada | Demo ≤ 15 min, 0 fallos en 3 pruebas |
| **Mar 13** | Enviar WhatsApp en caliente a los 3 contactos de Betania (plantilla 9.1). Mensaje a 2 cerrajeros de la zona (plantilla 9.5) | 1 h | 5 mensajes enviados | 5 contactos |
| **Mié 14** | 5 emails en frío personalizados (plantilla 9.3) a prospectos con reseñas de "llegada tardía"/"nadie en recepción" | 1,5 h | 5 emails | 10 contactos acumulados |
| **Jue 15** | Tarde: **3 visitas presenciales** 17-19:30 h (Benalmádena/Torremolinos), dejar A4 y pedir cita | 2,5 h | 3 visitas, notas en la hoja | 13 contactos · ≥ 1 cita |
| **Vie 16** | 5 solicitudes LinkedIn a propietarios/directores de la lista + 1 post (plantilla 9.6). Mensaje a 2 gestorías que llevan hoteles | 1 h | 7 contactos | 20 contactos acumulados |
| **Sáb 17** | Mañana: **4-5 visitas presenciales** (Fuengirola/Mijas). Tarde: borrador de contrato de servicios + DPA + SLA (con plantillas del asesor o una base revisable) | 5 h | Visitas · borradores legales | 25 contactos · ≥ 2 citas de demo |
| **Dom 18** | Seguimientos de lo enviado. Ajustar demo con lo que hayan preguntado. Script de despliegue: convertir los pasos manuales en script | 4 h | Seguimientos · script v1 | % de respuesta (meta ≥ 30 %) |

## Semana 3 — Demos (lun 19 – dom 25 oct) · reservar 1-2 días libres

| Día | Tarea concreta | Tiempo | Entregable | Métrica |
|---|---|---|---|---|
| **Lun 19** | Confirmar demos de la semana por WhatsApp. 5 contactos nuevos (email/LinkedIn) | 1 h | Agenda de demos | ≥ 3 demos agendadas |
| **Mar 20 (día libre)** | **2-3 demos** presenciales + 2 visitas en frío entre medias. Propuesta enviada el mismo día a quien diga "mándamela" | 6 h | Demos hechas · propuestas | 2-3 demos · ≥ 1 propuesta |
| **Mié 21** | Revisar demos: qué gustó, qué objeción salió. Actualizar tabla de objeciones (03 §10). Estimar trabajo de integración pedido (Redsys, TPV, cerradura X) | 1,5 h | Notas + estimaciones | Objeciones nuevas registradas |
| **Jue 22** | Tarde: 1 demo o 3 visitas. Café con cerrajero o gestoría si respondieron | 2,5 h | Demo/visitas · partner contactado | 1 partner en conversación |
| **Vie 23** | Segunda tanda de 5 contactos fríos. Seguimiento a propuestas (día +3) | 1 h | 5 contactos | 35 contactos acumulados |
| **Sáb 24** | Mañana: **demos** (sábado es buen día para propietarios). Tarde: cerrar contrato tipo + DPA con lista de subencargados real (hosting, IA, Meta, email, SerpAPI) | 5 h | Demos · contrato listo para firmar | Total demos ≥ 4 |
| **Dom 25** | Desacoplamiento para cliente 1: parametrizar contrato de admisión y facturas; backups + restauración probada en la demo | 4,5 h | Backup restaurado OK | Restauración < 30 min |

## Semana 4 — Propuesta y cierre (lun 26 oct – dom 1 nov) · reservar 1 día libre

| Día | Tarea concreta | Tiempo | Entregable | Métrica |
|---|---|---|---|---|
| **Lun 26** | Llamada de seguimiento a cada propuesta abierta: "¿Qué te falta para decidir?" Ofrecer visita a Betania para ver el sistema en un hotel real | 1,5 h | Estado de cada propuesta | Nº en "negociación" |
| **Mar 27** | Ajustar propuesta del candidato más caliente (alcance, nº de cerraduras, fecha de arranque en temporada baja). **No bajar la mensualidad de 99 €**; si hay que ceder, ceder en setup o en cerraduras | 1,5 h | Propuesta v2 | 1 propuesta final |
| **Mié 28** | Preparar plan de implantación de 1 página (fechas, qué necesitas de ellos: Stripe/Redsys, credenciales SES, Meta, export de su PMS) | 1,5 h | Plan de implantación | — |
| **Jue 29 (día libre o tarde)** | **Reunión de cierre**: firma de contrato + DPA, factura del 50 % del setup (solo si ya estás dado de alta; si no, firma con fecha de inicio y factura al darte de alta) | 3 h | **Contrato firmado** | **1 cierre** |
| **Vie 30** | Agradecimiento + calendario de arranque + pedir la primera referencia/presentación a otro hotelero | 1 h | Calendario compartido | 1 referido pedido |
| **Sáb 31** | Si no hubo cierre: segunda ronda de demos con los "quizá" y 10 contactos nuevos. Si lo hubo: alta de instancia del cliente (staging) y checklist de implantación | 5 h | Demos o instancia cliente | — |
| **Dom 1 nov** | **Revisión go/no-go** (abajo). Actualizar embudo, KPIs y plan de noviembre | 3 h | Documento de revisión de 1 página | Decisión tomada |

---

## Lista de 30 prospectos: cómo construirla (sábado 3 – sábado 10)

Columnas de la hoja: `nombre · municipio · tipo · nº hab. · web propia (s/n) · motor de reservas (s/n, cuál) · PMS detectable · nota Booking/Google · reseñas con dolor (copiar frase) · decisor · teléfono/WhatsApp · email · vía de entrada (caliente/frío/partner) · estado · próximo paso · fecha`.

Reparto objetivo (30):
- 10 en **Benalmádena** (ventaja: "estoy al lado de Betania, venid a verlo").
- 8 en **Torremolinos**.
- 6 en **Fuengirola / Mijas Costa**.
- 6 en **Málaga capital** (hostales y hoteles boutique de 10-25 hab. del centro).

Cómo encontrarlos: Google Maps (filtro "hotel"/"hostal"/"aparthotel"), Booking con filtro de la zona y ordenado por precio medio, lista de establecimientos asociados de AEHCOS si es pública, Registro de Turismo de Andalucía (RTA) para comprobar categoría/plazas, y **los 3 contactos de la dirección de Betania** (prioridad máxima).

Puntuación rápida (0-3 cada uno, priorizar ≥ 8): tamaño en ICP · reseñas de check-in/llegada · sin motor de reservas o motor malo · contacto en caliente · cercanía a Betania.

---

## Criterios go / no-go (revisión del domingo 1-nov)

| Resultado al 1-nov | Lectura | Decisión |
|---|---|---|
| **≥ 1 firmado** y ≥ 4 demos hechas | Hay producto y hay mercado | **GO**: implantar el piloto en nov-dic, completar Fase 0 del dossier, buscar cliente 2 con su referencia |
| 0 firmados, pero ≥ 4 demos y ≥ 2 propuestas "en pensarlo" con objeción concreta | Interés real, cierre lento (normal en la primera venta) | **GO condicionado**: 3 semanas más; atacar la objeción nº1 (precio → ceder setup; confianza → visita a Betania; riesgo → más plan B) |
| 0 firmados, < 3 demos con ≥ 25 contactados | El problema es el mensaje o el canal | **Pivotar el mensaje**: probar entrada vía partners (cerrajero/gestoría) y oferta "solo check-in autónomo + SES" encima de su PMS actual |
| < 15 contactados | No es el mercado: no se ha ejecutado | **Revisar tu tiempo**: o se reservan horas fijas o se aplaza el proyecto con fecha. Sin culpa, pero con decisión |
| Firmado, pero la implantación prevista > 40 h | Riesgo de comerte el tiempo | Fijar alcance cerrado por escrito; todo extra a 55 €/h |

**Señales de alarma para parar y pensar (en cualquier momento):**
- Una cláusula de Redeia que impida la actividad → nada de firmar hasta resolverlo.
- Sin seguro RC → no instalar cerraduras en un tercero.
- Dedicas > 15 h/semana sostenidas y te afecta al trabajo/descanso → bajar ritmo, no subir.

---

## Métricas del mes (tablero de una hoja)

| Métrica | Meta | Real |
|---|---|---|
| Prospectos cualificados | 30 | |
| Contactados | 25 | |
| Conversaciones | 10 | |
| Demos | 5 | |
| Propuestas | 2-3 | |
| Firmas | 1 | |
| Partners en conversación | 2 | |
| Horas invertidas (código / venta) | ≤ 40 % / ≥ 60 % | |
| Gasto | ≤ 400 € | |

---

## Fuentes

- Estrategia y fases: `~/Documents/betan-pms/DOSSIER.md` (Fase 0, Fase 1 pilotos, hitos H1-H4)
- Precios y oferta: `02-PRECIOS.md` · Mensajes y guiones: `03-PLAN-MARKETING.md` · Integraciones: `01-INTEGRACIONES-ESTRATEGIA.md`
- AEHCOS: https://asest.es/story/asociacion-empresarios-hoteleros-costa-del-sol/
- SES Hospedajes (entorno de preproducción y obligaciones): https://chekin.com/blog/todo-lo-que-necesitas-saber-sobre-ses-hospedajes/ · `src/lib/ses.ts`
- Tarifa plana / pluriactividad 2026: https://www.infoautonomos.com/seguridad-social/tarifa-plana-autonomos/ · https://getquipu.com/blog/tarifa-plana-o-bonificacion-por-pluriactividad/
- Seguro RC autónomos: https://cuantomecuesta.com/es/seguro-autonomo/

---

## Resumen (10 líneas)

1. Objetivo: 1 cliente fundador firmado y 50 % del setup cobrado antes del 1-nov-2026.
2. Oferta a firmar: setup 495 €, 99 €/mes × 12 (1.er mes gratis), luego 119 €/mes; año 1 = 1.584 € + IVA.
3. Opción cerraduras: 4 puertas a 240 € + gateway a coste = ~1.005 €.
4. Precio de lista que se enseña: Pro 149 €/mes, setup 990 €; pack cerradura 290 €/puerta.
5. Tiempo disponible: ~70-75 h; reservar 2-3 días libres + festivo 12-oct para demos.
6. Embudo: 30 prospectos → 25 contactos → 10 conversaciones → 5 demos → 2-3 propuestas → 1 firma.
7. Gasto del mes ≤ 400 € (maletín de cerradura ~150-250 € incluido).
8. Antes de facturar: contrato Redeia revisado, alta de autónomo (~89 €/mes o -50 %), RC, contrato + DPA.
9. Desacoplamiento mínimo para demo antes del 11-oct; para cliente 1, planificado para nov-dic.
10. Go/no-go el 1-nov: ≥ 1 firma = GO; demos sin firma = 3 semanas más; < 15 contactados = revisar tu tiempo.
