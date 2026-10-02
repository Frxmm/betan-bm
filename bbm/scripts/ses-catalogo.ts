/**
 * Consulta una tabla maestra del catálogo de SES Hospedajes (operación catalogo).
 *
 * Uso:
 *   SES_USERNAME=xxx SES_PASSWORD=yyy bun scripts/ses-catalogo.ts [TABLA] [prod]
 *
 * TABLA (default: TIPO_DOCUMENTO):
 *   SEXO | TIPO_COLOR | TIPO_DOCUMENTO | TIPO_ESTABLECIMIENTO |
 *   TIPO_MARCA_VEHICULO | TIPO_PAGO | TIPO_PARENTESCO |
 *   TIPO_PERMISO_CONDUCIR | TIPO_VEHICULO
 *   (sin argumento → lista todas las tablas disponibles)
 *
 * Entorno: segundo arg "prod" usa producción, cualquier otro (o nada) usa pre
 */

const ENDPOINT_PRE  = 'https://hospedajes.pre-ses.mir.es/hospedajes-web/ws/v1/comunicacion'
const ENDPOINT_PROD = 'https://hospedajes.ses.mir.es/hospedajes-web/ws/v1/comunicacion'

const tabla   = process.argv[2] ?? 'TIPO_DOCUMENTO'
const entorno = process.argv[3] === 'prod' ? 'prod' : 'pre'
const endpoint = entorno === 'prod' ? ENDPOINT_PROD : ENDPOINT_PRE

if (!process.env.SES_USERNAME || !process.env.SES_PASSWORD) {
  console.error('\nFaltan credenciales SES.')
  console.error('  Uso: SES_USERNAME=<usuario> SES_PASSWORD=<contraseña> bun scripts/ses-catalogo.ts [TABLA] [prod]\n')
  process.exit(1)
}

const token = Buffer.from(`${process.env.SES_USERNAME}:${process.env.SES_PASSWORD}`).toString('base64')

const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:com="http://www.soap.servicios.hospedajes.mir.es/comunicacion">
  <soapenv:Header/>
  <soapenv:Body>
    <com:catalogoRequest>
      <peticion>
        ${tabla ? `<catalogo>${tabla}</catalogo>` : ''}
      </peticion>
    </com:catalogoRequest>
  </soapenv:Body>
</soapenv:Envelope>`

const label = tabla || '(todas las tablas)'
console.log(`\n→ Catálogo "${label}"  ·  ${entorno.toUpperCase()}  ·  ${endpoint}\n`)

const res = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'Content-Type':  'text/xml; charset=UTF-8',
    'SOAPAction':    '',
    'Authorization': `Basic ${token}`,
  },
  body: soap,
  // @ts-ignore — certificado FNMT puede no estar en el bundle de Bun
  tls: { rejectUnauthorized: false },
})

const xml = await res.text()

if (!res.ok) {
  console.error(`✗ HTTP ${res.status} ${res.statusText}\n`)
  console.error(xml)
  process.exit(1)
}

// Verificar código de respuesta del servicio (primer bloque <resultado>)
const matchEstado = xml.match(/<resultado>\s*<codigo>(\d+)<\/codigo>\s*<descripcion>(.*?)<\/descripcion>/s)
if (matchEstado) {
  const [, code, desc] = matchEstado
  if (code !== '0') {
    console.error(`✗ Error del servicio — código ${code}: ${desc.trim()}\n`)
    process.exit(1)
  }
}

// Extraer tuplas del catálogo (<tupla> está bajo respuesta/resultado, no en el bloque de estado)
const tuplas = [...xml.matchAll(/<tupla>([\s\S]*?)<\/tupla>/g)]

if (tuplas.length === 0) {
  console.log('Sin resultados. Respuesta completa:\n')
  console.log(xml)
  process.exit(0)
}

const COL = 18
console.log(`✓ ${tuplas.length} entrada${tuplas.length !== 1 ? 's' : ''}\n`)
console.log('Código'.padEnd(COL) + 'Descripción')
console.log('─'.repeat(64))

for (const [, body] of tuplas) {
  const code = body.match(/<codigo>(.*?)<\/codigo>/)?.[1]?.trim() ?? ''
  const desc = body.match(/<descripcion>(.*?)<\/descripcion>/)?.[1]?.trim() ?? ''
  console.log(code.padEnd(COL) + desc)
}

console.log()
