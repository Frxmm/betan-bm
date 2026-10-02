# 02 · Precios y oferta de primera venta

> Fecha: 2026-10-02 · Para: Fran · Estado: propuesta para validar con los 3 primeros clientes
>
> Idea central: **no somos los más baratos ni queremos serlo.** Un hotel de 20 habitaciones puede
> tener un PMS por 40 € al mes. Lo que no consigue por 40 € es que alguien de la zona le **instale
> la cerradura, le conecte la Policía, le deje el WhatsApp funcionando y le coja el teléfono**.
> Ponemos el precio en la franja media (por encima de Amenitiz/Beds24 y por debajo de Cloudbeds/Mews)
> y justificamos la diferencia con servicio e integraciones instaladas.

---

## 1. Lo que cobra la competencia (hotel pequeño, ~20 habitaciones)

Precios públicos o estimaciones de reviews independientes de 2026. Los de USD están en dólares
(1 $ ≈ 0,85-0,90 €); IVA no incluido salvo que se diga. **Verifica en la web de cada uno antes de
citarlos ante un cliente**: cambian a menudo y muchos solo dan precio por presupuesto.

| Producto | Qué es | Precio orientativo para ~20 hab. | Notas |
|---|---|---|---|
| **Amenitiz** (ES) | PMS + web + motor + channel, todo en uno para 1-20 hab. | Desde **42 €/mes** (Presence); 49-69 €/mes para 6-20 hab.; planes altos ~180-220 €/mes | El rival directo en España. Fuerte marketing, soporte remoto |
| **Cloudbeds** | PMS + channel + motor | ~**15 $/hab./mes** → ~300 $/mes; cargado (RMS, mensajería, pagos) 360-500 $+/mes | Planes Flex/One/Experience con mínimos por propiedad |
| **Mews** | PMS cloud premium | Desde **~300 €/mes** (solo PMS), ~9 €/hab.; total realista 4.800-8.400 €/año; contratos de 2 años | Channel, RMS y web aparte |
| **Little Hotelier** (SiteMinder) | PMS + channel para pequeños | Basics **29 $/mes + 1 % por reserva**; Pro desde 109 $/mes | La comisión por reserva sube mucho el coste real |
| **SiteMinder** | Channel manager (NO es PMS) | 135-179 $+/mes; cargado 180-400 $/mes | Hay que sumar un PMS |
| **RoomRaccoon** | PMS todo en uno | ~**199 $/mes** a 20 unidades (Entry 197 $, Premium 367 $, Pro 517 $) | — |
| **Beds24** | Channel + PMS técnico | Base 8,40 € + ~0,55 €/hab. → **~20-40 €/mes** | Muy barato, curva de aprendizaje dura; ideal para quien se lo monta solo |
| **Nobeds** | Channel + PMS básico | **10 €/mes** (Cloud Plus, hasta 30 canales); gratis hasta 3 canales | Es nuestro channel de base |
| **Sirvoy** | Motor + PMS | Starter desde 11 €/mes, Pro desde 41 €/mes (escala por habitaciones) | — |
| **Hostify** | PMS para alquiler vacacional | 20 $/unidad/mes (5-19 unidades) | Orientado a VUT |
| **Lodgify** | PMS + web para VUT | 14-59 $/propiedad/mes; **1,9 % por reserva** en Starter/Professional | Orientado a VUT |
| **Avirato** (ES) | PMS hotelero | Presupuesto; app desde 19 €/mes | Muy implantado en España |
| **Ulyses Cloud** (ES) | PMS cloud | Desde 17 €/mes | — |
| **Hotelgest** (ES) | PMS + channel | Core PMS desde **55 €/mes** sin permanencia | — |
| **Chekin** (ES) | Check-in online + Policía + verificación de identidad | Por presupuesto | Lo contratan encima del PMS → **nosotros lo llevamos dentro** |
| **Nuki Smart Hosting** | Gestión de cerraduras para alquiler | 69 €/año por cerradura | Referencia para "cerradura gestionada" |

**Lectura honesta:**
- Por "software" puro, el mercado está a **40-70 €/mes** (Amenitiz, Hotelgest, Beds24+algo). Si nos comparan así, perdemos.
- Por "software + channel + check-in online + Policía + cerradura gestionada + mensajería", el hotel acaba pagando **150-350 €/mes** sumando 3-4 proveedores (PMS + Chekin + SiteMinder + Nuki/Seam), y nadie se lo instala.
- Ahí es donde jugamos: **un proveedor, un teléfono, instalado.**

---

## 2. Planes propuestos (precios sin IVA)

Banda base: **hasta 25 habitaciones**. Por encima: **+3 €/hab./mes** (26-50 hab.).

| | **Esencial** | **Pro** | **Autónomo** (IA + cerraduras) |
|---|---|---|---|
| **Mensualidad** | **99 €/mes** | **149 €/mes** | **199 €/mes** |
| **Implantación (setup)** | 690 € | 990 € | 1.490 € (sin hardware) |
| PMS, planning, housekeeping, lavandería, facturación | Sí | Sí | Sí |
| Motor de reservas web + widget + portal del huésped | Sí | Sí | Sí |
| Channel manager (vía Nobeds; cuota de Nobeds la paga el hotel, ~10 €/mes) | Sí | Sí | Sí |
| Stripe / Redsys (cuenta del hotel) | Sí | Sí | Sí |
| SES Hospedajes automático + check-in online + escaneo DNI con IA | Sí | Sí | Sí |
| WhatsApp (cuenta Meta del hotel; mensajes los paga el hotel) | Básico (confirmaciones) | Completo | Completo |
| Recuperación de carritos y cancelaciones | — | Sí | Sí |
| Reglas de precio dinámico + comparativa de competidores | — | Sí | Sí |
| Agente IA (chat interno) | — | Sí (uso estándar) | Sí + voz + app Android |
| Integración cerraduras (TTLock / ZKTeco / Nuki…) | — | +4 €/puerta/mes | **Incluida** |
| QR por habitación con autoservicio del huésped | — | Sí | Sí |
| Integraciones "internas" (Holded/A3, TPV, domótica) | Presupuesto | 1 incluida | 2 incluidas |
| Soporte | Email/WhatsApp, laborables | + teléfono urgencias | + teléfono urgencias 8-23 h todos los días |
| Formación | 2 h | 3 h | 4 h + chuleta de operaciones |

**Extras (cualquier plan):**
- **Pack cerradura instalada (TTLock RFID + teclado):** **290 €/puerta** (incluye cerradura, 10 tarjetas, alta y prueba; instalación por cerrajero partner). Gateway: **60 €/unidad** (1 por cada ~4-6 puertas según distancia/planta).
- Puerta principal / portero (Akuvox o ZKTeco): presupuesto (300-700 € según obra).
- Migración desde otro PMS (reservas futuras + fichero de clientes): incluida si hay export CSV/Excel; **250-600 €** si hay que pelear con el formato.
- Horas de desarrollo/soporte fuera de alcance: **55 €/h** (bonos de 10 h a 480 €).
- Desplazamiento fuera de Costa del Sol occidental (Málaga-Marbella): 0,30 €/km.
- **Pago anual:** 2 meses gratis (paga 10, usa 12). Te mejora la caja y reduce cancelaciones.

**Por qué estos números y no los del dossier (129-169 €/mes, 1.500-2.500 € de setup):**
el dossier es el precio "con dos casos de éxito". Hoy no los tienes. Bajamos el setup (que es la barrera
de entrada) y dejamos la mensualidad cerca del objetivo, porque **subir una mensualidad después es mucho
más difícil que subir un setup**. Tras 3 clientes de referencia: setup a 1.200-1.900 € y Pro a 169 €.

---

## 3. Coste propio por cliente (mensual)

Supuesto: hotel de 20 hab., 70 % de ocupación media, estancia media 3 noches → ~140 estancias/mes.

| Partida | Si lo pagas tú | Si lo paga el hotel directamente (recomendado) | Comentario |
|---|---|---|---|
| VPS (Hetzner CX32 ~8-8,5 €) + backups (+20 %) + copia externa S3 | 11 € | 11 € | Subió ~30-50 % en abril 2026; vigila |
| Dominio/SSL/email transaccional | 2 € | 2 € | — |
| Nobeds | 10 € | 0 € | Cuenta del hotel |
| WhatsApp Meta (≈560 plantillas utility × 0,0166 € + ~50 marketing × 0,0509 €) | ~12 € | 0 € | Cuenta Meta del hotel |
| LLM (agente IA, visión DNI, voz) | 15-50 € | 15-50 € | **Mide el consumo real de Betania** en la consola del proveedor antes de fijar límites; pon tope mensual por instancia |
| SerpAPI (competidores) | 5-10 € | 5-10 € | Limitar frecuencia de consultas |
| Monitorización, logs, staging (prorrateado) | 3 € | 3 € | — |
| Stripe/Redsys | 0 € | 0 € | Comisiones las paga el hotel en su cuenta |
| **Total infraestructura** | **58-98 €** | **36-76 €** | Objetivo realista: **~50 €** |
| Tu tiempo de soporte (2 h/mes × 40 €/h interno) | 80 € | 80 € | **El coste de verdad.** Los primeros meses serán 4-6 h |

**Regla:** todo lo que sea cuenta de un tercero a nombre del hotel (Stripe, Meta, Nobeds, TTLock, SES)
**va a nombre del hotel**. Menos coste para ti, menos responsabilidad, y si un día te vas no quedan colgados.

### Margen de contribución (sin contar tu tiempo)

| Plan | Mensualidad | Coste infra (≈50 €) | Margen | % |
|---|---|---|---|---|
| Esencial | 99 € | ~35 € (menos IA) | 64 € | 65 % |
| Pro | 149 € | ~50 € | 99 € | 66 % |
| Autónomo (20 puertas) | 199 € | ~60 € | 139 € | 70 % |

Contando 2 h/mes de soporte a 40 €/h, el margen "real" del Pro baja a ~19 €. **Conclusión:** el negocio
solo funciona si el soporte por cliente baja de 2 h/mes → documentación, panel de salud y el agente IA
como primera línea de soporte (está en el dossier, y es correcto).

### Margen del pack cerradura
- Coste: cerradura 60-150 € + tarjetas 15 € + cerrajero partner 30-50 €/puerta = **105-215 €**.
- Venta: 290 €/puerta → **margen 75-185 €/puerta**. Gateway: coste 30-50 €, venta 60 €.
- Hotel de 20 puertas: ~5.800 € de pack → **~2.000-3.000 € de margen**. Es la mayor entrada de caja del primer año: no la regales.
- Guarda 2-3 cerraduras de repuesto + pilas (≈300-400 € de stock).

---

## 4. Costes fijos tuyos y break-even

| Gasto fijo mensual | Importe | Comentario |
|---|---|---|
| Cuota de autónomo en pluriactividad | ~89 €/mes (tarifa plana 2026: 80 € + MEI) **o** reducción del 50 % de la base mínima durante 18 meses (son **incompatibles**, eliges una) | Pide al asesor que calcule cuál te sale mejor; con pluriactividad además puedes pedir **devolución de exceso de cotización** |
| Gestoría/asesor | 40-70 €/mes | Imprescindible el primer año |
| Seguro RC profesional (+ RC general por instalaciones) | 15-35 €/mes (150-400 €/año) | Precio sube si incluye instalación de cerraduras y ciberriesgos |
| Instancia demo + staging + herramientas (dominio, email, gestor de contraseñas) | 25-35 €/mes | — |
| Marketing (ver 03) | 100-300 €/mes | Empieza en ~100 € |
| **Total fijo** | **~270-530 €/mes** | Usa ~350 € como referencia |

**Break-even mensual** (solo recurrente): 350 € / 99 € de margen Pro ≈ **4 clientes Pro**.
Con los setups y packs de cerradura, **el primer año se cubre con 2 clientes** (cada setup + pack paga varios meses de fijos).

**Lo que hace falta para pensar en dejar Red Eléctrica** (estimación grosera, consúltalo con el asesor):
- Necesitas ~3.500-4.000 €/mes de margen para un neto de ~2.500 € tras cuota, IRPF y gastos.
- Eso son **~30-35 clientes Pro** solo con recurrente, o ~20-25 clientes + 2-3 instalaciones de cerraduras al mes.
- A 1-2 clientes nuevos al mes, son **18-30 meses**. Encaja con los hitos H1-H3 del dossier. No dejes el trabajo antes de H3.

---

## 5. Descuentos de piloto (clientes 1-3: "Fundadores")

Reglas:
- **Nunca gratis.** Lo gratis no se valora ni se usa, y no valida nada. El piloto paga algo desde el primer día.
- Descuento **a cambio de algo concreto**, por escrito: testimonio, métricas, referencias, feedback.
- **Precio de fundador** que se mantiene tras el piloto (fideliza y no tienes que "subir" de golpe).

| Concepto | Precio de lista | Fundador (clientes 1-3) |
|---|---|---|
| Setup Pro | 990 € | **495 €** (50 %) |
| Mensualidad Pro | 149 € | **99 €/mes los 12 primeros meses**, luego **119 €/mes de por vida** (precio fundador) |
| Primer mes tras arranque | — | **Gratis** (periodo de acompañamiento) |
| Pack cerradura | 290 €/puerta | **240 €/puerta**; gateway a precio de coste |
| Permanencia | — | Ninguna; baja con 30 días de aviso y exportación de datos |
| A cambio | — | Vídeo-testimonio de 1 min, caso de éxito con cifras (ocupación, % venta directa, horas ahorradas), 2 referencias telefónicas, 30 min de feedback cada 2 semanas durante 3 meses, permiso para usar el logo |

---

## 6. LA OFERTA de la primera venta (con números)

> **"Plan Fundador — Hotel X (20 habitaciones)"**
>
> - Implantación completa (configuración, tarifas, motor de reservas en su web, SES, Stripe/Redsys,
>   WhatsApp, migración desde su PMS actual, formación 3 h, 2 semanas de acompañamiento): **495 €**
>   (50 % a la firma, 50 % al arrancar).
> - Mensualidad plan Pro: **99 €/mes** durante 12 meses; el **primer mes es gratis**. Después, 119 €/mes de por vida.
> - **Opcional — check-in autónomo:** 4 cerraduras TTLock instaladas en las habitaciones con más llegadas
>   tardías + 1 gateway: 4 × 240 € + 45 € = **1.005 €**. Si funciona, el resto de puertas a 240 €.
> - Sin permanencia. Datos siempre suyos, exportables.
>
> **Total año 1 sin cerraduras: 495 + 11 × 99 = 1.584 € + IVA** (≈ 132 €/mes; menos que Cloudbeds o Mews
> y con la Policía, el check-in y el WhatsApp incluidos).
> **Con piloto de 4 cerraduras: 2.589 € + IVA.**

Tu resultado (aprox.): setup 495 € (≈10-15 h de trabajo) + cerraduras ~350-450 € de margen + 99 €/mes con ~50 € de coste.
**No es un negocio todavía; es una referencia.** Y una referencia en la Costa del Sol vale más que los 1.000 € que dejas de cobrar.

**Cuándo NO hacer esta oferta:** si el hotel tiene > 50 habitaciones, restaurante grande con TPV complejo, o
cerraduras Salto/Onity que hay que integrar → precio de lista + presupuesto de integración. No te hundas en el primer cliente.

---

## 7. Contrato y legal básico (no firmar nada sin esto)

**Documentos (plantillas a preparar con el asesor/abogado, ~300-600 € una vez, merece la pena):**
1. **Contrato de prestación de servicios** (SaaS + implantación): alcance por plan, precio, duración/baja, propiedad de los datos (del hotel), propiedad del software (tuya; el hotel tiene licencia de uso), **limitación de responsabilidad** (p. ej. hasta lo pagado en los últimos 12 meses; excluye lucro cesante), fuerza mayor, caídas de terceros (Meta, Stripe, Booking, Ministerio).
2. **Contrato de encargado del tratamiento (art. 28 RGPD)**: tratas datos de huéspedes del hotel (incluidos **documentos de identidad, imágenes de DNI y datos de pago**). Debe incluir: objeto y duración, medidas de seguridad, confidencialidad, **lista de subencargados** (hosting, proveedor de IA, Meta/WhatsApp, email, SerpAPI…), **transferencias internacionales** (proveedores en EE. UU. → cláusulas tipo / Marco de Privacidad de Datos UE-EE. UU.), asistencia en derechos ARCO, notificación de brechas en < 48 h al hotel, devolución/borrado al terminar. Plazo de conservación de partes de viajeros: el que marque el RD 933/2021 (3 años).
3. **SLA por escrito** (realista para alguien con trabajo a jornada completa — mejor prometer poco y cumplir):
   - Disponibilidad objetivo del servicio: **99,5 % mensual** (excluye mantenimientos avisados y caídas de terceros).
   - **Crítica** (no se pueden hacer check-ins, motor de reservas caído, cerraduras no abren): respuesta **< 1 h de 8 a 23 h** todos los días; fuera de ese horario, mejor esfuerzo.
   - **Alta** (una función importante falla con alternativa manual): < 4 h laborables.
   - **Normal**: < 1 día laborable. Mejoras: roadmap, sin plazo.
   - Compensación por incumplimiento: crédito del 10 % de la mensualidad (topado). Nada de penalizaciones abiertas.
4. **Anexo de cerraduras**: plan B **obligatorio** (tarjeta maestra / llave mecánica en recepción o caja de llaves), responsabilidades del hotel (pilas, custodia de tarjetas maestras), qué incluye la garantía del hardware (la del fabricante), desplazamiento y horario. La instalación física la hace y la garantiza **el cerrajero partner**.
5. **IA**: informar al huésped de que interactúa con un sistema de IA cuando hable con el agente (Reglamento europeo de IA, obligaciones de transparencia del art. 50, aplicables desde agosto de 2026 — **verifícalo con el asesor**). Revisión humana en decisiones de cobro.

**Seguros:**
- **RC profesional** (errores en el software/servicio, pérdida de datos): suma asegurada ≥ 300.000 €. Para autónomos de servicios suele estar en 100-300 €/año.
- **RC general/explotación** si participas en instalaciones físicas, o exige al cerrajero partner su seguro y que figure él como instalador.
- Valora una póliza de **ciberriesgos** cuando tengas 3+ clientes (manejas DNIs).

---

## 8. Cómo cobrar siendo empleado de Red Eléctrica (léelo con un asesor — esto no es asesoramiento legal)

1. **Mira tu contrato y el código ético de Redeia ANTES de nada:** busca cláusulas de **exclusividad / plena dedicación** (si existen y te las compensan, no puedes tener otra actividad sin renunciar al pacto), de **no concurrencia** (aquí no aplica en principio: sector distinto) y de **comunicación de actividades externas / conflictos de interés**. Si piden comunicarlo, comunícalo por escrito.
2. Redeia es una cotizada con participación pública minoritaria (SEPI): en principio **no te aplica la Ley de Incompatibilidades del personal público**, pero **confírmalo** con tu asesor o RR. HH.
3. Nunca uses tiempo, portátil, correo ni red de la empresa para betan-bm. Ni una demo en horario laboral.
4. **Alta como autónomo en pluriactividad**: alta censal en Hacienda (modelo 036/037) con el epígrafe de IAE que te indique el asesor (servicios informáticos/profesional; **si vas a vender hardware de cerraduras, probablemente necesitas también un epígrafe de comercio/instalación**, o que el hardware lo facture el cerrajero partner directamente al hotel — **opción más sencilla al principio**), y alta en RETA.
5. Cuota reducida: **tarifa plana (~89 €/mes en 2026) o bonificación por pluriactividad (50 % de la base mínima los primeros 18 meses)**, no ambas. Pregunta también por la devolución del exceso de cotización por pluriactividad.
6. **Impuestos**: IVA 21 % (modelo 303 trimestral), IRPF por pagos fraccionados (modelo 130) o por retención en factura si tu actividad es profesional y facturas a empresas (15 %, o 7 % los primeros años). Tu propia facturación también tendrá que cumplir **Verifactu desde el 1-jul-2027**: usa un software que lo cumpla.
7. **No uses cooperativas de facturación** para evitar el alta: riesgo legal y no transmiten seriedad.
8. Cuando pases de ~3.000 €/mes de beneficio o tengas socios/empleado, estudia **SL** (limita responsabilidad, importante con cerraduras y datos sensibles).

---

## Fuentes

- Amenitiz: https://comparatifchannelmanager.fr/en/amenitiz-pricing/ · https://www.capterra.com/p/183836/Amenitiz/pricing/ · https://amenitiz-avis.fr/en/amenitiz-reviews-2026/
- Cloudbeds: https://www.roommaster.com/blog/cloudbeds-pricing · https://costbench.com/software/hotel-management/cloudbeds/ · https://hoteltechinsight.com/pms/cloudbeds/
- Mews: https://www.mews.com/en/pricing · https://www.roommaster.com/blog/mews-pricing · https://amenitiz.com/en/blog/amenitiz-vs-mews-hotel-pms-comparison-2026
- Little Hotelier: https://www.roommaster.com/blog/littlehotelier-pricing · https://pricingsaas.com/companies/littlehotelier
- SiteMinder: https://www.roommaster.com/blog/siteminder-pricing · https://costbench.com/software/hotel-management/siteminder/
- RoomRaccoon: https://www.pmscompare.com/pms/roomraccoon · https://www.xpay.sh/saas-pricing/roomraccoon/
- Beds24: https://comparatifchannelmanager.fr/en/beds24-pricing/
- Nobeds: https://www.capterra.es/software/176616/nobeds
- Sirvoy: https://sirvoy.com/pricing/ · https://www.roommaster.com/blog/sirvoy-pricing
- Hostify: https://www.bnbcalc.com/reviews/hostify-review
- Lodgify: https://www.roommaster.com/blog/lodgify-pricing · https://frontdeskreview.com/software/vacation-rental-software/lodgify/
- Avirato: https://www.comparasoftware.com/avirato-pms-hotel · Ulyses: https://www.capterra.com/p/182565/Ulyses-Cloud/ · Hotelgest: https://hotelgest.com/en/planes
- Chekin: https://chekin.com/pt/blog/chekin-em-numeros-2026/
- Nuki Smart Hosting: https://nuki.io/en-se/discover-nuki/for-your-vacation-rental/pricing
- Seam: https://www.seam.co/pricing
- WhatsApp precios por mensaje España: https://developers.facebook.com/docs/whatsapp/pricing · https://whautomate.com/whatsapp-business-api-pricing-spain
- Hetzner subida de precios 2026: https://agentdeals.dev/hetzner-pricing-2026
- Tarifa plana / pluriactividad 2026: https://www.infoautonomos.com/seguridad-social/tarifa-plana-autonomos/ · https://getquipu.com/blog/tarifa-plana-o-bonificacion-por-pluriactividad/ · https://ayudasautonomos.com/tarifa-plana-autonomo-pluriactividad/
- Seguro RC autónomos: https://cuantomecuesta.com/es/seguro-autonomo/ · https://www.billeo.es/blog/seguros-autonomo-obligatorios-recomendados-2026
- Verifactu: https://www.infobae.com/espana/2025/12/02/hacienda-aplaza-hasta-2027-la-obligacion-de-facturar-con-verifactu-para-autonomos-y-pymes/
- SES Hospedajes / RD 933/2021: https://chekin.com/blog/todo-lo-que-necesitas-saber-sobre-ses-hospedajes/

---

## Resumen (10 líneas)

1. Mercado: software puro 40-70 €/mes (Amenitiz 42-69, Hotelgest 55, Beds24 ~30); premium 260-500 €/mes (Cloudbeds, Mews ≥300 €).
2. Planes: Esencial 99 €/mes · Pro 149 €/mes · Autónomo (IA + cerraduras) 199 €/mes, hasta 25 hab.; +3 €/hab. por encima.
3. Setup: 690 € / 990 € / 1.490 €; subir a 1.200-1.900 € tras 3 referencias.
4. Pack cerradura TTLock: 290 €/puerta instalada (coste 105-215 €) + gateway 60 €.
5. Coste infra por cliente ≈ 50 €/mes (36-76 € si el hotel paga Nobeds y Meta); el coste real es tu tiempo.
6. Margen de contribución Pro ≈ 99 €/mes (66 %); fijos tuyos ≈ 350 €/mes → break-even recurrente con 4 clientes Pro.
7. Oferta primera venta: setup 495 €, 99 €/mes × 12 (1.er mes gratis), luego 119 € de por vida; año 1 = 1.584 € + IVA.
8. Piloto de cerraduras: 4 puertas a 240 € + gateway = 1.005 €; año 1 con cerraduras = 2.589 € + IVA.
9. Extras: 55 €/h, bono 10 h = 480 €, migración 250-600 €, anual = 2 meses gratis.
10. Antes de facturar: revisar contrato/código ético de Redeia, alta en pluriactividad (≈89 €/mes o -50 %), DPA RGPD, SLA y RC ≥ 300.000 €.
