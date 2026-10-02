/**
 * Tests de integración contra el entorno de PRUEBAS de SES Hospedajes
 * Endpoint pruebas: https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion
 *
 * Uso:
 *   bun scripts/ses-test.ts
 *
 * Variables de entorno necesarias (en .env o exportadas):
 *   SES_USERNAME
 *   SES_PASSWORD
 *   SES_CODIGO_ARRENDADOR
 *   SES_CODIGO_ESTABLECIMIENTO
 */

// Forzar entorno de pruebas
process.env.SES_PRODUCCION = 'false'

import { isConfigured, validateGuest, buildInnerXml, xmlToZipBase64, toIso3, type SesGuest, type SesStay } from '../src/lib/ses'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ENDPOINT = 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion'

let passed = 0
let failed = 0

function ok(label: string, value?: any) {
  console.log(`  ✓ ${label}`)
  if (value !== undefined) console.log(`    → ${JSON.stringify(value)}`)
  passed++
}

function fail(label: string, err?: any) {
  console.error(`  ✗ ${label}`)
  if (err) console.error(`    → ${err instanceof Error ? err.message : JSON.stringify(err)}`)
  failed++
}

function section(name: string) {
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`)
}

function basicAuth(): string {
  const u = process.env.SES_USERNAME ?? ''
  const p = process.env.SES_PASSWORD ?? ''
  return 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64')
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function callSes(innerXml: string, tipoOperacion: string, tipoComunicacion?: string) {
  const base64     = xmlToZipBase64(innerXml)
  const arrendador = process.env.SES_CODIGO_ARRENDADOR!
  const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:com="http://www.soap.servicios.hospedajes.mir.es/comunicacion">
  <soapenv:Header/>
  <soapenv:Body>
    <com:comunicacionRequest>
      <peticion>
        <cabecera>
          <codigoArrendador>${esc(arrendador)}</codigoArrendador>
          <aplicacion>PMS Test</aplicacion>
          <tipoOperacion>${tipoOperacion}</tipoOperacion>${tipoComunicacion ? `\n          <tipoComunicacion>${tipoComunicacion}</tipoComunicacion>` : ''}
        </cabecera>
        <solicitud>${base64}</solicitud>
      </peticion>
    </com:comunicacionRequest>
  </soapenv:Body>
</soapenv:Envelope>`

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type':  'text/xml; charset=UTF-8',
      'Authorization': basicAuth(),
      'SOAPAction':    '',
      'Connection':    'close',  // forzar TCP fresco — el proxy del MIR cierra mal las conexiones persistentes
    },
    body: soap,
    // El entorno de pre-producción del MIR usa CA del Gobierno de España no incluida en el trust store por defecto
    // @ts-ignore — extensión Bun
    tls: { rejectUnauthorized: false },
  })

  const xml = await res.text()
  // El XSD define <codigo> pero el PDF de ejemplo usa <codigoRetorno> — intentamos ambos
  const codigoStr = xml.match(/<codigoRetorno>(\d+)<\/codigoRetorno>/)?.[1]
                 ?? xml.match(/<codigo>(\d+)<\/codigo>/)?.[1]
  const desc  = xml.match(/<descripcion>(.*?)<\/descripcion>/s)?.[1]?.trim() ?? ''
  const lote  = xml.match(/<lote>([\w-]+)<\/lote>/)?.[1]
  return { httpStatus: res.status, codigoRetorno: codigoStr ? parseInt(codigoStr) : -1, descripcion: desc, lote, xml }
}

// ─── Datos de prueba ──────────────────────────────────────────────────────────

const GUEST_ADULTO_NIF: SesGuest = {
  firstName:           'Juan',
  lastName:            'García',
  secondLastName:      'López',
  gender:              'male',
  dateOfBirth:         '1985-06-15',
  nationality:         'ES',
  idDocType:           'dni',
  idDocNumber:         '00000000T',
  idDocSupportNumber:  '999999999',
  email:               'test@example.com',
  phone:               '666666666',
  address1:            'C/ Prueba 1',
  zipCode:             '18001',
  city:                'Granada',
  cityIneCode:         '18087',
}

const GUEST_ADULTO_PAS: SesGuest = {
  firstName:   'Marie',
  lastName:    'Dupont',
  gender:      'female',
  dateOfBirth: '1990-03-22',
  nationality: 'FR',
  idDocType:   'passport',
  idDocNumber: 'AB123456',
  email:       'marie@test.fr',
  address1:    '10 Rue de la Paix',
  zipCode:     '75001',
  city:        'Paris',
}

const HOY    = new Date().toISOString().slice(0, 10)
const MANANA = new Date(Date.now() + 86400_000).toISOString().slice(0, 10)

const STAY_TEST: SesStay = {
  referencia:   `TEST-${Date.now()}`,
  checkInDate:  HOY,
  checkOutDate: MANANA,
  numPersonas:  1,
  tipoPago:     'EFECT',
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function runTests() {
  console.log('SES Hospedajes — Tests entorno de PRUEBAS')
  console.log(`Endpoint: ${ENDPOINT}`)
  console.log(`Fecha: ${new Date().toLocaleString('es-ES')}`)

  // ── 1. Comprobación de configuración ──────────────────────────────────────

  section('1. Configuración')

  if (!isConfigured()) {
    fail('Variables de entorno', 'Faltan SES_USERNAME, SES_PASSWORD, SES_CODIGO_ARRENDADOR o SES_CODIGO_ESTABLECIMIENTO')
    console.log('\n  Añade al .env:')
    console.log('    SES_USERNAME=tu_usuario')
    console.log('    SES_PASSWORD=tu_contraseña')
    console.log('    SES_CODIGO_ARRENDADOR=XXXXXXXXXX')
    console.log('    SES_CODIGO_ESTABLECIMIENTO=XXXXXXXXXX')
    console.log('\nAbortando tests — sin credenciales no es posible continuar.')
    process.exit(1)
  }

  ok('Variables de entorno presentes', {
    usuario:          process.env.SES_USERNAME,
    arrendador:       process.env.SES_CODIGO_ARRENDADOR,
    establecimiento:  process.env.SES_CODIGO_ESTABLECIMIENTO,
  })

  // ── 2. Validación local ───────────────────────────────────────────────────

  section('2. Validación local de campos')

  const errorsCompleto = validateGuest(GUEST_ADULTO_NIF, HOY)
  if (errorsCompleto.length === 0) {
    ok('Huésped adulto NIF — sin errores de validación')
  } else {
    fail('Huésped adulto NIF tiene errores', errorsCompleto)
  }

  const errorsVacio = validateGuest({ firstName: '', lastName: '' }, HOY)
  if (errorsVacio.length > 0) {
    ok(`Huésped vacío detecta ${errorsVacio.length} error(es)`, errorsVacio.map(e => e.field))
  } else {
    fail('Huésped vacío debería tener errores de validación')
  }

  const errorsNIFsinSoporte = validateGuest({ ...GUEST_ADULTO_NIF, idDocSupportNumber: undefined }, HOY)
  const hasSoporteError = errorsNIFsinSoporte.some(e => e.field === 'idDocSupportNumber')
  if (hasSoporteError) {
    ok('NIF sin nº soporte detectado correctamente')
  } else {
    fail('Debería detectar NIF sin nº soporte')
  }

  // ── 3. Construcción del XML interno ──────────────────────────────────────

  section('3. Generación del XML interno')

  const xmlNIF = buildInnerXml(GUEST_ADULTO_NIF, STAY_TEST)
  if (xmlNIF.includes('<tipoDocumento>NIF</tipoDocumento>')) {
    ok('tipoDocumento DNI → NIF correcto')
  } else {
    fail('tipoDocumento DNI debería mapear a NIF', xmlNIF.match(/<tipoDocumento>(.*?)<\/tipoDocumento>/)?.[0])
  }

  const xmlPAS = buildInnerXml(GUEST_ADULTO_PAS, STAY_TEST)
  if (xmlPAS.includes('<tipoDocumento>PAS</tipoDocumento>')) {
    ok('tipoDocumento passport → PAS correcto')
  } else {
    fail('tipoDocumento passport debería mapear a PAS')
  }

  if (xmlNIF.includes('<nacionalidad>ESP</nacionalidad>')) {
    ok('Nacionalidad ES → ESP (Alfa-3) correcto')
  } else {
    fail('Conversión ISO Alfa-2→Alfa-3 fallida')
  }

  if (xmlPAS.includes('<nacionalidad>FRA</nacionalidad>')) {
    ok('Nacionalidad FR → FRA correcto')
  } else {
    fail('Conversión FR→FRA fallida')
  }

  if (xmlNIF.includes('<codigoMunicipio>18087</codigoMunicipio>')) {
    ok('CodigoMunicipio INE presente para España')
  } else {
    fail('Debería usar codigoMunicipio para huésped español')
  }

  if (xmlPAS.includes('<nombreMunicipio>Paris</nombreMunicipio>')) {
    ok('NombreMunicipio presente para huésped extranjero')
  } else {
    fail('Debería usar nombreMunicipio para huésped extranjero', xmlPAS.slice(0, 500))
  }

  // Comprobar que XML tiene el orden correcto del XSD (personaHospedajeType sequence)
  const rolPos = xmlNIF.indexOf('<rol>')
  const nombrePos = xmlNIF.indexOf('<nombre>')
  const docPos = xmlNIF.indexOf('<tipoDocumento>')
  const fechaNacPos = xmlNIF.indexOf('<fechaNacimiento>')
  const dirPos = xmlNIF.indexOf('<direccion>')
  if (rolPos < nombrePos && docPos < fechaNacPos && fechaNacPos < dirPos) {
    ok('Orden de elementos XML sigue la secuencia del XSD')
  } else {
    fail('Orden de elementos XML no coincide con personaHospedajeType sequence')
  }

  // Comprobar que ZIP+Base64 funciona
  try {
    const b64 = xmlToZipBase64(xmlNIF)
    if (b64.length > 0 && /^[A-Za-z0-9+/]+=*$/.test(b64)) {
      ok(`ZIP+Base64 generado (${b64.length} chars)`)
    } else {
      fail('ZIP+Base64 tiene formato inválido')
    }
  } catch (e) {
    fail('Error al comprimir XML', e)
  }

  // Mostrar XML generado para revisión manual
  console.log('\n  XML alta NIF generado:')
  xmlNIF.split('\n').forEach(l => console.log(`    ${l}`))

  // ── 4. Conexión con SES entorno de pruebas ────────────────────────────────

  section('4. Conectividad con SES (entorno de PRUEBAS)')

  // Probar conectividad con credenciales incorrectas a propósito
  // → esperamos código de error de auth (no error de red)
  try {
    const badAuth = 'Basic ' + Buffer.from('usuario_invalido:contraseña_invalida').toString('base64')
    const innerXml = buildInnerXml(GUEST_ADULTO_NIF, { ...STAY_TEST, referencia: 'TEST-CONN' })
    const base64   = xmlToZipBase64(innerXml)
    const arrendador = process.env.SES_CODIGO_ARRENDADOR!
    const soap = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:com="http://www.soap.servicios.hospedajes.mir.es/comunicacion">
  <soapenv:Header/>
  <soapenv:Body>
    <com:comunicacionRequest>
      <peticion>
        <cabecera>
          <codigoArrendador>${arrendador}</codigoArrendador>
          <aplicacion>PMS Test</aplicacion>
          <tipoOperacion>A</tipoOperacion>
          <tipoComunicacion>PV</tipoComunicacion>
        </cabecera>
        <solicitud>${base64}</solicitud>
      </peticion>
    </com:comunicacionRequest>
  </soapenv:Body>
</soapenv:Envelope>`
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', 'Authorization': badAuth, 'SOAPAction': '', 'Connection': 'close' },
      body: soap,
      // @ts-ignore
      tls: { rejectUnauthorized: false },
    })
    const xml = await res.text()
    if (res.status === 401 || xml.includes('401') || xml.includes('nauthorized')) {
      ok('Conectividad OK — servidor responde (auth incorrecto esperado con credenciales falsas)')
    } else if (res.status === 200) {
      const codigoStr = xml.match(/<codigoRetorno>(\d+)<\/codigoRetorno>/)?.[1] ?? xml.match(/<codigo>(\d+)<\/codigo>/)?.[1]
      const desc = xml.match(/<descripcion>(.*?)<\/descripcion>/s)?.[1]?.trim() ?? ''
      if (codigoStr && codigoStr !== '0') {
        ok(`Conectividad OK — servidor responde con código ${codigoStr}: ${desc}`)
      } else {
        ok(`Conectividad OK — HTTP ${res.status}`)
      }
    } else {
      fail(`HTTP ${res.status} inesperado`, xml.slice(0, 200))
    }
  } catch (e) {
    fail('Error de red al conectar con SES', e)
  }

  // ── 5. Alta de parte de viajeros — adulto español NIF ────────────────────

  section('5. Alta PV — adulto español (NIF)')

  let loteNIF: string | undefined
  try {
    const stay5 = { ...STAY_TEST, referencia: `TEST-NIF-${Date.now()}` }
    const xml5  = buildInnerXml(GUEST_ADULTO_NIF, stay5)
    const r = await callSes(xml5, 'A', 'PV')

    if (r.codigoRetorno === 0 && r.lote) {
      ok(`Alta aceptada — lote: ${r.lote}`)
      loteNIF = r.lote
    } else {
      fail(`Código ${r.codigoRetorno}: ${r.descripcion}`)
      const errors = [...r.xml.matchAll(/<error>(.*?)<\/error>/gs)].map(m => m[1])
      if (errors.length) {
        console.log(`    Errores de validación SES:`)
        errors.forEach(e => console.log(`      · ${e}`))
      } else {
        console.log(`    Respuesta completa:`)
        r.xml.split('\n').forEach(l => console.log(`      ${l}`))
      }
    }
  } catch (e) {
    fail('Error inesperado en alta NIF', e)
  }

  // ── 6. Alta de parte de viajeros — adulto extranjero pasaporte ───────────

  section('6. Alta PV — adulto extranjero (Pasaporte)')

  let lotePAS: string | undefined
  try {
    const stay6 = { ...STAY_TEST, referencia: `TEST-PAS-${Date.now()}` }
    const xml6  = buildInnerXml(GUEST_ADULTO_PAS, stay6)
    const r = await callSes(xml6, 'A', 'PV')

    if (r.codigoRetorno === 0 && r.lote) {
      ok(`Alta aceptada — lote: ${r.lote}`)
      lotePAS = r.lote
    } else {
      fail(`Código ${r.codigoRetorno}: ${r.descripcion}`)
      const errors = [...r.xml.matchAll(/<error>(.*?)<\/error>/gs)].map(m => m[1])
      if (errors.length) errors.forEach(e => console.log(`      · ${e}`))
    }
  } catch (e) {
    fail('Error inesperado en alta PAS', e)
  }

  // ── 7. Consulta de lote ───────────────────────────────────────────────────

  section('7. Consulta de lote')

  const loteAConsultar = loteNIF ?? lotePAS
  if (!loteAConsultar) {
    console.log('  ⚠ Sin lote para consultar (ambas altas fallaron)')
  } else {
    try {
      // namespace según consultarComunicacion.xsd
      const innerXmlConsulta = `<?xml version="1.0" encoding="UTF-8"?>
<lotes xmlns="http://www.neg.hospedajes.mir.es/consultarComunicacion">
  <lote>${loteAConsultar}</lote>
</lotes>`
      const r = await callSes(innerXmlConsulta, 'C')

      const ESTADOS: Record<string, string> = {
        '1': 'Tramitado sin errores',
        '2': 'Errores en cabecera/formato',
        '3': 'Error inesperado',
        '4': 'En proceso',
        '5': 'Pendiente',
        '6': 'Tramitado con errores parciales',
      }

      if (r.codigoRetorno === 0) {
        const estado  = r.xml.match(/<codigoEstado>(\d+)<\/codigoEstado>/)?.[1]
        const descEst = r.xml.match(/<descEstado>(.*?)<\/descEstado>/s)?.[1]?.trim() ?? ''
        ok(`Lote ${loteAConsultar} — Estado ${estado}: ${ESTADOS[estado ?? ''] ?? descEst}`)
      } else {
        fail(`Consulta fallida ${r.codigoRetorno}: ${r.descripcion}`)
      }
    } catch (e) {
      fail('Error al consultar lote', e)
    }
  }

  // ── Resumen ───────────────────────────────────────────────────────────────

  section('Resumen')
  console.log(`  Pasados: ${passed}   Fallidos: ${failed}`)
  if (failed > 0) process.exit(1)
}

runTests().catch(e => {
  console.error('Error fatal:', e)
  process.exit(1)
})
