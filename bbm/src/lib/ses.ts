/**
 * Cliente SES Hospedajes — Ministerio del Interior (RD 933/2021)
 *
 * Protocolo: SOAP/HTTPS con HTTP Basic Auth
 * Datos: XML comprimido en ZIP y codificado en Base64
 *
 * XSDs de referencia (v3.1.3):
 *   altaParteHospedaje.xsd   → inner XML alta PV
 *   consultarComunicacion.xsd → inner XML consulta lotes
 *   anularComunicacion.xsd   → inner XML anulación
 *   tiposGenerales.xsd       → tipos compartidos
 *   tipoComunicacion.xsd     → envelope SOAP + respuesta
 *
 * Credenciales POR TENANT (getSecret; módulo 'ses'):
 *   SES_USERNAME                — usuario asignado por SES
 *   SES_PASSWORD                — contraseña
 *   SES_CODIGO_ARRENDADOR       — código arrendador (cabecera SOAP, max 10 chars)
 *   SES_CODIGO_ESTABLECIMIENTO  — código establecimiento (inner XML, max 10 chars)
 *   SES_APLICACION              — nombre aplicación (default: nombre del hotel, max 50 chars)
 *   SES_PRODUCCION              — "true" para producción (default: entorno de pruebas)
 */

import { zipSync } from 'fflate'
import COUNTRIES from '../../frontend/data/countries.json'
import { getSecret, hasFeature, getBranding } from './property'

const ENDPOINT_PRE = 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion'
const ENDPOINT_PRO = 'https://hospedajes.ses.mir.es/hospedajes-web/ws/v1/comunicacion'

interface SesCreds {
  username: string; password: string; arrendador: string; establecimiento: string
  aplicacion: string; produccion: boolean
}

export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('ses')) return false
  return !!(
    await getSecret('SES_USERNAME') && await getSecret('SES_PASSWORD') &&
    await getSecret('SES_CODIGO_ARRENDADOR') && await getSecret('SES_CODIGO_ESTABLECIMIENTO')
  )
}

export async function isProduccion(): Promise<boolean> {
  return (await getSecret('SES_PRODUCCION')) === 'true'
}

async function creds(): Promise<SesCreds> {
  if (!await hasFeature('ses')) throw new Error('Módulo SES no activado')
  const username = await getSecret('SES_USERNAME'), password = await getSecret('SES_PASSWORD')
  const arrendador = await getSecret('SES_CODIGO_ARRENDADOR'), establecimiento = await getSecret('SES_CODIGO_ESTABLECIMIENTO')
  if (!username || !password || !arrendador || !establecimiento) throw new Error('SES no configurado (SES_USERNAME, SES_PASSWORD, SES_CODIGO_ARRENDADOR, SES_CODIGO_ESTABLECIMIENTO)')
  return {
    username, password, arrendador, establecimiento,
    aplicacion: (await getSecret('SES_APLICACION')) || `${(await getBranding()).name} PMS`,
    produccion: await isProduccion(),
  }
}

function esc(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ISO 3166-1 alpha-2 → alpha-3 (SES exige Alfa-3, patrón [a-zA-Z]{3}), a partir
// del listado completo de países de frontend/data/countries.json (249 países,
// el mismo que usa el CountryPicker del formulario de huésped) — antes había
// aquí una tabla a mano con solo ~90 países, y cualquiera que faltase (p.ej.
// Armenia, AM) se enviaba a SES tal cual en alfa-2 en vez de alfa-3, y SES lo
// rechaza porque exige exactamente 3 letras.
const ISO2_TO_ISO3: Record<string, string> = Object.fromEntries(
  (COUNTRIES as { code: string; code3: string }[]).map(c => [c.code.toUpperCase(), c.code3.toUpperCase()])
)

export function toIso3(code?: string | null): string {
  if (!code) return ''
  const u = code.toUpperCase().trim()
  if (u.length === 3) return u         // ya es alfa-3
  return ISO2_TO_ISO3[u] ?? u
}

// Nuestro enum idDocType → código catálogo SES TIPO_DOCUMENTO
// Catálogo oficial (operación catalogo, 2026): NIF, NIE, PAS, CIF, CIF_E, OTRO.
// No existe código para carné de conducir → se comunica como OTRO.
const DOC_TYPE_MAP: Record<string, string> = {
  dni:             'NIF',
  nie:             'NIE',
  passport:        'PAS',
  driving_licence: 'OTRO',
  other:           'OTRO',
}

// Nuestro enum gender → sexo SES (string1Type, max 1 char)
const GENDER_MAP: Record<string, string> = {
  male: 'H', female: 'M', non_binary: 'X',
}

function isMinorAt(dateOfBirth: string, referenceDate: string): boolean {
  const dob = new Date(dateOfBirth)
  const ref = new Date(referenceDate)
  const age = ref.getFullYear() - dob.getFullYear()
  const m   = ref.getMonth() - dob.getMonth()
  return (m < 0 || (m === 0 && ref.getDate() < dob.getDate())) ? age - 1 < 18 : age < 18
}

// ─── Tipos públicos ────────────────────────────────────────────────────────────

export interface SesGuest {
  firstName:           string
  lastName:            string
  secondLastName?:     string | null
  gender?:             string | null
  dateOfBirth?:        string | null   // YYYY-MM-DD, requerido por XSD
  nationality?:        string | null   // ISO 3166-1 (alfa-2 ó alfa-3)
  idDocType?:          string | null
  idDocNumber?:        string | null
  idDocSupportNumber?: string | null   // requerido para NIF/NIE
  email?:              string | null   // al menos email o phone
  phone?:              string | null
  address1?:           string | null   // direccion dentro de bloque direccion
  zipCode?:            string | null   // codigoPostal, requerido por XSD
  city?:               string | null   // nombreMunicipio (si no es ESP)
  cityIneCode?:        string | null   // codigoMunicipio INE 5 dígitos (si ESP)
  addressCountryCode?: string | null   // ISO 3166-1 alfa-2, fallback si nationality está vacío
}

export interface SesStay {
  referencia:   string    // max 50 chars
  checkInDate:  string    // YYYY-MM-DD
  checkOutDate: string    // YYYY-MM-DD
  numPersonas:  number
  tipoPago?:    string    // catálogo TIPO_PAGO, default EFECT (max 5 chars)
}

export interface SesValidationError { field: string; message: string }

export function validateGuest(g: SesGuest, checkInDate?: string): SesValidationError[] {
  const errs: SesValidationError[] = []
  const refDate = checkInDate ?? new Date().toISOString().slice(0, 10)

  if (!g.firstName)   errs.push({ field: 'firstName',   message: 'Nombre requerido' })
  if (!g.lastName)    errs.push({ field: 'lastName',    message: 'Primer apellido requerido' })
  if (!g.dateOfBirth) errs.push({ field: 'dateOfBirth', message: 'Fecha de nacimiento requerida (campo obligatorio en XSD)' })

  // Contacto: al menos uno de telefono/correo requerido (regla de negocio del PDF)
  if (!g.email && !g.phone)
    errs.push({ field: 'contacto', message: 'Se requiere email o teléfono' })

  // Validación de formato email (patrón XSD: [^@]+@[^\.]+\..+)
  if (g.email && !/^[^@]+@[^.]+\..+$/.test(g.email))
    errs.push({ field: 'email', message: 'Formato de email inválido' })

  // Campos requeridos para adultos (regla de negocio, no XSD minOccurs)
  const minor = g.dateOfBirth ? isMinorAt(g.dateOfBirth as string, refDate) : false
  if (!minor) {
    if (!g.idDocType)   errs.push({ field: 'idDocType',   message: 'Tipo de documento requerido para adultos' })
    if (!g.idDocNumber) errs.push({ field: 'idDocNumber', message: 'Número de documento requerido para adultos' })
    if ((g.idDocType === 'dni' || g.idDocType === 'nie') && !g.idDocSupportNumber)
      errs.push({ field: 'idDocSupportNumber', message: 'Nº soporte requerido para NIF/NIE' })
    if (g.idDocType === 'dni' && !g.secondLastName)
      errs.push({ field: 'secondLastName', message: 'Segundo apellido obligatorio para NIF (apellido2 requerido)' })
  }

  return errs
}

// ─── Construcción del XML interno (validado contra altaParteHospedaje.xsd) ────

function buildDireccionXml(g: SesGuest, iso3Pais: string): string {
  // Orden obligatorio del XSD: direccion, [direccionComplementaria], [codigoMunicipio], [nombreMunicipio], codigoPostal, pais
  const lines: string[] = []
  lines.push(`<direccion>${esc(g.address1 ?? '-')}</direccion>`)
  const iso3Nat = toIso3(g.nationality) || toIso3(g.addressCountryCode)
  if (iso3Nat === 'ESP' && g.cityIneCode && /^\d{5}$/.test(g.cityIneCode)) {
    lines.push(`<codigoMunicipio>${g.cityIneCode}</codigoMunicipio>`)
  } else if (g.city) {
    lines.push(`<nombreMunicipio>${esc(g.city)}</nombreMunicipio>`)
  }
  lines.push(`<codigoPostal>${esc(g.zipCode ?? '00000')}</codigoPostal>`)
  lines.push(`<pais>${iso3Pais}</pais>`)
  return lines.map(l => `          ${l}`).join('\n')
}

function buildPersonaXml(g: SesGuest, checkInDate: string): string {
  const iso3Nat  = toIso3(g.nationality)
  const iso3Pais = iso3Nat || 'ESP'
  const tipoDoc  = DOC_TYPE_MAP[g.idDocType ?? ''] ?? ''
  const sexo     = GENDER_MAP[g.gender ?? ''] ?? ''
  const minor    = g.dateOfBirth ? isMinorAt(g.dateOfBirth, checkInDate) : false

  // Orden exacto del personaHospedajeType XSD:
  // rol, nombre, apellido1, [apellido2], [tipoDocumento], [numeroDocumento],
  // [soporteDocumento], fechaNacimiento, [nacionalidad], [sexo], direccion,
  // [telefono], [telefono2], [correo], [parentesco]
  const lines: (string | null)[] = [
    `        <rol>VI</rol>`,
    `        <nombre>${esc(g.firstName)}</nombre>`,
    `        <apellido1>${esc(g.lastName)}</apellido1>`,
    g.secondLastName      ? `        <apellido2>${esc(g.secondLastName)}</apellido2>` : null,
    !minor && tipoDoc     ? `        <tipoDocumento>${tipoDoc}</tipoDocumento>` : null,
    !minor && g.idDocNumber ? `        <numeroDocumento>${esc(g.idDocNumber)}</numeroDocumento>` : null,
    !minor && g.idDocSupportNumber ? `        <soporteDocumento>${esc(g.idDocSupportNumber)}</soporteDocumento>` : null,
    g.dateOfBirth         ? `        <fechaNacimiento>${g.dateOfBirth}</fechaNacimiento>` : null,
    iso3Nat               ? `        <nacionalidad>${iso3Nat}</nacionalidad>` : null,
    sexo                  ? `        <sexo>${sexo}</sexo>` : null,
    `        <direccion>`,
    buildDireccionXml(g, iso3Pais),
    `        </direccion>`,
    // Contacto: telefono y/o correo (al menos uno)
    g.phone ? `        <telefono>${esc(g.phone)}</telefono>` : null,
    g.email ? `        <correo>${esc(g.email)}</correo>` : null,
    // parentesco solo si hay algún menor en el grupo — para reserva individual no aplica
  ]

  return lines.filter(l => l !== null).join('\n')
}

export function buildInnerXml(guests: SesGuest | SesGuest[], stay: SesStay, codigoEst: string): string {
  const tipoPago   = (stay.tipoPago ?? 'EFECT').slice(0, 5)
  const guestList  = Array.isArray(guests) ? guests : [guests]
  const personasXml = guestList.map(g => [
    `      <persona>`,
    buildPersonaXml(g, stay.checkInDate),
    `      </persona>`,
  ].join('\n')).join('\n')

  // XSD usa elementFormDefault="unqualified": solo el root lleva namespace (con prefijo)
  // los elementos hijo deben estar en el namespace vacío — no usar xmlns="" por defecto
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ns:peticion xmlns:ns="http://www.neg.hospedajes.mir.es/altaParteHospedaje">`,
    `  <solicitud>`,
    `    <codigoEstablecimiento>${esc(codigoEst)}</codigoEstablecimiento>`,
    `    <comunicacion>`,
    `      <contrato>`,
    // Orden obligatorio contratoHospedajeType: referencia, fechaContrato, fechaEntrada, fechaSalida, numPersonas, [numHabitaciones], [internet], pago
    `        <referencia>${esc(stay.referencia.slice(0, 50))}</referencia>`,
    `        <fechaContrato>${stay.checkInDate}</fechaContrato>`,
    `        <fechaEntrada>${stay.checkInDate}T14:00:00</fechaEntrada>`,
    `        <fechaSalida>${stay.checkOutDate}T12:00:00</fechaSalida>`,
    `        <numPersonas>${guestList.length}</numPersonas>`,
    `        <numHabitaciones>1</numHabitaciones>`,
    `        <pago>`,
    `          <tipoPago>${tipoPago}</tipoPago>`,
    `        </pago>`,
    `      </contrato>`,
    personasXml,
    `    </comunicacion>`,
    `  </solicitud>`,
    `</ns:peticion>`,
  ].join('\n')
}

// ─── ZIP + Base64 ──────────────────────────────────────────────────────────────

export function xmlToZipBase64(xml: string): string {
  const bytes  = new TextEncoder().encode(xml)
  const zipped = zipSync({ 'solicitud.xml': bytes }, { level: 6 })
  return Buffer.from(zipped).toString('base64')
}

// ─── SOAP envelope ─────────────────────────────────────────────────────────────

function buildSoap(cr: SesCreds, base64: string, tipoOperacion: 'A' | 'B' | 'C', tipoComunicacion?: string): string {
  const arrendador = cr.arrendador
  const aplicacion = esc(cr.aplicacion.slice(0, 50))

  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:com="http://www.soap.servicios.hospedajes.mir.es/comunicacion">
  <soapenv:Header/>
  <soapenv:Body>
    <com:comunicacionRequest>
      <peticion>
        <cabecera>
          <codigoArrendador>${esc(arrendador)}</codigoArrendador>
          <aplicacion>${aplicacion}</aplicacion>
          <tipoOperacion>${tipoOperacion}</tipoOperacion>${tipoComunicacion ? `\n          <tipoComunicacion>${tipoComunicacion}</tipoComunicacion>` : ''}
        </cabecera>
        <solicitud>${base64}</solicitud>
      </peticion>
    </com:comunicacionRequest>
  </soapenv:Body>
</soapenv:Envelope>`
}

// ─── Parsing respuesta SOAP ────────────────────────────────────────────────────
// El XSD dice <codigo> pero el ejemplo del PDF muestra <codigoRetorno> — intentamos ambos.
// Las etiquetas pueden venir con prefijo de namespace (p.ej. <ns2:codigoRetorno>) según
// el servidor del MIR, así que el regex tolera un prefijo opcional.

function parseSoapResponse(xml: string): { codigo: number; descripcion: string; lote?: string; fault?: string } {
  const codigoStr = xml.match(/<(?:\w+:)?codigoRetorno>(\d+)<\/(?:\w+:)?codigoRetorno>/)?.[1]
                 ?? xml.match(/<(?:\w+:)?codigo>(\d+)<\/(?:\w+:)?codigo>/)?.[1]
  const descripcion = xml.match(/<(?:\w+:)?descripcion>(.*?)<\/(?:\w+:)?descripcion>/s)?.[1]?.trim() ?? ''
  const lote        = xml.match(/<(?:\w+:)?lote>([\w-]+)<\/(?:\w+:)?lote>/)?.[1]

  // Un SOAP Fault (credenciales rechazadas, XML malformado, etc.) no trae codigoRetorno —
  // sin esto, un fallo real se reportaba como "SES error -1: " sin ninguna pista.
  const faultString = xml.match(/<faultstring>(.*?)<\/faultstring>/s)?.[1]?.trim()
                    ?? xml.match(/<(?:\w+:)?Reason>.*?<(?:\w+:)?Text.*?>(.*?)<\/(?:\w+:)?Text>/s)?.[1]?.trim()

  return { codigo: codigoStr ? parseInt(codigoStr) : -1, descripcion, lote, fault: faultString }
}

async function callSoap(cr: SesCreds, soap: string): Promise<{ codigo: number; descripcion: string; lote?: string; rawXml: string; httpStatus: number; fault?: string }> {
  const res = await fetch(cr.produccion ? ENDPOINT_PRO : ENDPOINT_PRE, {
    method:  'POST',
    headers: {
      'Content-Type':  'text/xml; charset=UTF-8',
      'Authorization': 'Basic ' + Buffer.from(`${cr.username}:${cr.password}`).toString('base64'),
      'SOAPAction':    '',
    },
    body: soap,
    // @ts-ignore — Bun: CA FNMT del gobierno español no incluida en bundles estándar
    tls: { rejectUnauthorized: false },
  })
  const rawXml = await res.text()
  const parsed = parseSoapResponse(rawXml)

  // Si no se pudo extraer codigoRetorno/codigo, dejamos constancia en el log del servidor
  // del status HTTP y un fragmento del body — de otro modo el error "-1" es indiagnosticable.
  if (parsed.codigo === -1) {
    console.error(`[SES] Respuesta no reconocida — HTTP ${res.status}${parsed.fault ? ` — SOAP Fault: ${parsed.fault}` : ''}`)
    console.error(`[SES] Body (primeros 2000 chars): ${rawXml.slice(0, 2000)}`)
  }

  return { ...parsed, rawXml, httpStatus: res.status }
}

// ─── API pública ───────────────────────────────────────────────────────────────

/** Alta de parte de viajeros (tipoComunicacion: PV) */
export async function submitParte(guest: SesGuest | SesGuest[], stay: SesStay): Promise<{ lote: string }> {
  const cr       = await creds()
  const innerXml = buildInnerXml(guest, stay, cr.establecimiento)
  const soap     = buildSoap(cr, xmlToZipBase64(innerXml), 'A', 'PV')
  const { codigo, descripcion, lote, rawXml, httpStatus, fault } = await callSoap(cr, soap)

  if (codigo !== 0) {
    // Intentar extraer errores de validación del resultadoComunicaciones
    const errors = [...rawXml.matchAll(/<error>(.*?)<\/error>/gs)].map(m => (m[1] ?? '').trim())
    const detail  = errors.length ? ` — ${errors.join('; ')}` : ''
    // codigo -1 significa que no pudimos parsear la respuesta (SOAP Fault, error HTTP,
    // caída del servicio del MIR, etc.) — añadimos contexto para que no sea un error mudo
    if (codigo === -1) {
      const causa = fault ? `SOAP Fault: ${fault}` : (httpStatus !== 200 ? `HTTP ${httpStatus}` : 'respuesta no reconocida')
      throw new Error(`SES error de comunicación (${causa})${descripcion ? ` — ${descripcion}` : ''}${detail}`)
    }
    throw new Error(`SES error ${codigo}: ${descripcion}${detail}`)
  }
  if (!lote) throw new Error('SES no devolvió número de lote')
  return { lote }
}

export interface SesComunicacionEstado {
  referencia:          string
  codigoComunicacion:  string
  codigoEstado:        number
  descEstado:          string
  errores:             string[]
}

/** Consulta del estado de un lote (tipoOperacion: C) */
export async function consultarLote(lote: string): Promise<{
  codigoEstado:   number
  descEstado:     string
  comunicaciones: SesComunicacionEstado[]
  rawXml:         string
}> {
  const innerXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<lotes xmlns="http://www.neg.hospedajes.mir.es/consultarComunicacion">`,
    `  <lote>${esc(lote)}</lote>`,
    `</lotes>`,
  ].join('\n')

  const cr = await creds()
  const soap = buildSoap(cr, xmlToZipBase64(innerXml), 'C')
  const { codigo, descripcion, rawXml, httpStatus, fault } = await callSoap(cr, soap)

  if (codigo !== 0) {
    if (codigo === -1) {
      const causa = fault ? `SOAP Fault: ${fault}` : (httpStatus !== 200 ? `HTTP ${httpStatus}` : 'respuesta no reconocida')
      throw new Error(`SES consulta — error de comunicación (${causa})${descripcion ? ` — ${descripcion}` : ''}`)
    }
    throw new Error(`SES consulta error ${codigo}: ${descripcion}`)
  }

  // Estado general del lote
  const estadoStr  = rawXml.match(/<codigoEstado>(\d+)<\/codigoEstado>/)?.[1]
  const descEstado = rawXml.match(/<descEstado>(.*?)<\/descEstado>/s)?.[1]?.trim() ?? ''

  // Errores por comunicación individual — dos formatos posibles:
  // - submit response: <comunicacion>…</comunicacion>
  // - consultar response: <resultadoComunicacion>…</resultadoComunicacion>
  const comunicaciones: SesComunicacionEstado[] = []
  const comBlocks = [
    ...rawXml.matchAll(/<resultadoComunicacion>(.*?)<\/resultadoComunicacion>/gs),
    ...rawXml.matchAll(/<comunicacion>(.*?)<\/comunicacion>/gs),
  ]
  for (const [, block] of comBlocks) {
    if (!block) continue
    const referencia         = block.match(/<referencia>(.*?)<\/referencia>/s)?.[1]?.trim() ?? ''
    const codigoComunicacion = block.match(/<codigoComunicacion>(.*?)<\/codigoComunicacion>/s)?.[1]?.trim() ?? ''
    const codEst             = block.match(/<codigoEstado>(\d+)<\/codigoEstado>/)?.[1]
    const descEst            = block.match(/<descEstado>(.*?)<\/descEstado>/s)?.[1]?.trim() ?? ''
    const tipoError          = block.match(/<tipoError>(.*?)<\/tipoError>/s)?.[1]?.trim() ?? ''
    const orden              = block.match(/<orden>(\d+)<\/orden>/)?.[1]
    const errores            = [...block.matchAll(/<error>(.*?)<\/error>/gs)].map(m => m[1]?.trim() ?? '')
    // Para resultadoComunicacion, si no hay codigoEstado/descEstado propios, usar tipoError como descEstado
    comunicaciones.push({
      referencia:         referencia || (orden ? `Comunicación ${orden}` : ''),
      codigoComunicacion,
      codigoEstado:       codEst ? parseInt(codEst) : (errores.length > 0 ? 3 : 1),
      descEstado:         descEst || tipoError,
      errores,
    })
  }

  return {
    codigoEstado:   estadoStr ? parseInt(estadoStr) : -1,
    descEstado,
    comunicaciones,
    rawXml,
  }
}

/** Anulación de comunicaciones por código (tipoOperacion: B) */
export async function anularComunicaciones(codigosComunicacion: string[]): Promise<void> {
  // Inner XML según anularComunicacion.xsd
  const items    = codigosComunicacion.map(c => `  <codigoComunicacion>${esc(c)}</codigoComunicacion>`).join('\n')
  const innerXml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<comunicaciones xmlns="http://www.neg.hospedajes.mir.es/anularComunicacion">`,
    items,
    `</comunicaciones>`,
  ].join('\n')

  const cr = await creds()
  const soap = buildSoap(cr, xmlToZipBase64(innerXml), 'B')
  const { codigo, descripcion, httpStatus, fault } = await callSoap(cr, soap)
  if (codigo !== 0) {
    if (codigo === -1) {
      const causa = fault ? `SOAP Fault: ${fault}` : (httpStatus !== 200 ? `HTTP ${httpStatus}` : 'respuesta no reconocida')
      throw new Error(`SES anulación — error de comunicación (${causa})${descripcion ? ` — ${descripcion}` : ''}`)
    }
    throw new Error(`SES anulación error ${codigo}: ${descripcion}`)
  }
}
