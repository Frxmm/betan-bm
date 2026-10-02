// ─── Imprimir los QR de acceso de todas las habitaciones (PDF, A5) ────────────
// Uno por habitación activa: logo, "Habitación X", el QR (mismo token estable
// de rooms.qr_token — no cambia con los despliegues, ver src/lib/roomAccess.ts)
// y una explicación corta de para qué sirve. Pensado para imprimir y plastificar
// una vez por habitación. Uso: bun scripts/print-room-qrs.ts [-o salida.pdf]
import { Resvg } from '@resvg/resvg-js'
import { PDFDocument } from 'pdf-lib'
import QRCode from 'qrcode'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db'
import { rooms } from '../src/db/schema'
import { ensureRoomQrToken } from '../src/lib/roomAccess'
import { env } from '../src/lib/env'
import { getBranding, getPropertyId } from '../src/lib/property'
import { withTenant } from './lib/tenant'

const outArg = process.argv.indexOf('-o')
const OUT_PATH = (outArg !== -1 ? process.argv[outArg + 1] : undefined) ?? 'qr-habitaciones.pdf'

// Canvas en proporción exacta A5 (1:√2) — resvg lo rasteriza a este tamaño en
// píxeles y pdf-lib lo coloca a tamaño real A5 (148×210mm) en la página.
const W = 1000, H = 1414
const A5_PT_W = 419.53, A5_PT_H = 595.28

function escapeXml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

async function logoDataUri(): Promise<string> {
  const file = Bun.file(`${process.cwd()}/public/img/logo.png`)
  const buf = await file.arrayBuffer()
  return `data:image/png;base64,${Buffer.from(buf).toString('base64')}`
}

function buildCardSvg(roomCode: string, qrDataUrl: string, logoUri: string, footer: string): string {
  const code = escapeXml(roomCode)
  const logoW = 170, logoH = Math.round(logoW / (706 / 469))
  const badgeSize = 220, badgeX = (W - badgeSize) / 2, badgeY = 230
  const logoX = (W - logoW) / 2, logoY = badgeY + (badgeSize - logoH) / 2

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <defs>
      <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3b82f6"/>
        <stop offset="1" stop-color="#1e3a8a"/>
      </linearGradient>
      <filter id="cardShadow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="14" result="blur"/>
        <feOffset in="blur" dx="0" dy="10" result="off"/>
        <feComponentTransfer in="off" result="shadow"><feFuncA type="linear" slope="0.28"/></feComponentTransfer>
        <feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="badgeShadow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="10" result="blur"/>
        <feOffset in="blur" dx="0" dy="6" result="off"/>
        <feComponentTransfer in="off" result="shadow"><feFuncA type="linear" slope="0.3"/></feComponentTransfer>
        <feMerge><feMergeNode in="shadow"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <rect width="${W}" height="${H}" fill="#f8fafc" />
    <rect x="0" y="0" width="${W}" height="340" fill="url(#brand)" />
    <circle cx="900" cy="40" r="180" fill="#ffffff" opacity="0.07" />
    <circle cx="60" cy="300" r="110" fill="#ffffff" opacity="0.07" />

    <rect x="${badgeX}" y="${badgeY}" width="${badgeSize}" height="${badgeSize}" rx="40" fill="#ffffff" filter="url(#badgeShadow)" />
    <image href="${logoUri}" x="${logoX}" y="${logoY}" width="${logoW}" height="${logoH}" />

    <text x="500" y="505" font-size="22" font-weight="700" fill="#2563eb" text-anchor="middle" letter-spacing="4" font-family="Arial, sans-serif">BIENVENIDO A LA</text>
    <text x="500" y="575" font-size="58" font-weight="800" fill="#0f172a" text-anchor="middle" font-family="Arial, sans-serif">Habitación ${code}</text>

    <rect x="325" y="605" width="350" height="64" rx="32" fill="url(#brand)" />
    <!-- Icono de teléfono dibujado a mano (rects/circle) en vez de un emoji: resvg
         rasteriza el SVG en el servidor y no siempre tiene una fuente de emoji a
         color disponible — el glyph salía en blanco/sin decodificar en el PDF. -->
    <rect x="360" y="622" width="18" height="30" rx="3.5" fill="none" stroke="#ffffff" stroke-width="2.2" />
    <circle cx="369" cy="646" r="1.4" fill="#ffffff" />
    <text x="512" y="647" font-size="27" font-weight="600" fill="#ffffff" text-anchor="middle" font-family="Arial, sans-serif">Tu reserva, aquí</text>

    <rect x="290" y="703" width="420" height="440" rx="28" fill="#ffffff" filter="url(#cardShadow)" />
    <rect x="290" y="703" width="420" height="10" rx="5" fill="url(#brand)" />
    <image href="${qrDataUrl}" x="315" y="738" width="370" height="370" />

    <text x="500" y="1203" font-size="24" fill="#475569" text-anchor="middle" font-family="Arial, sans-serif">Escanea, confirma tu apellido y accede</text>
    <text x="500" y="1237" font-size="24" fill="#475569" text-anchor="middle" font-family="Arial, sans-serif">a tu reserva, extras y más</text>

    <rect x="0" y="1314" width="${W}" height="100" fill="url(#brand)" />
    <text x="500" y="1372" font-size="22" font-weight="600" fill="#ffffff" text-anchor="middle" letter-spacing="1" font-family="Arial, sans-serif">${footer}</text>
  </svg>`
}

async function main() {
  const logoUri = await logoDataUri()
  const b = await getBranding()
  const footer = [b.name, b.city].filter(Boolean).join(' · ').toUpperCase().replace(/&/g, '&amp;')
  const baseUrl = b.publicDomain ? `https://${b.publicDomain}` : env.PUBLIC_URL
  const list = await db.query.rooms.findMany({ where: and(eq(rooms.active, true), eq(rooms.propertyId, getPropertyId())) })
  list.sort((a, b) => {
    const na = parseInt(a.code), nb = parseInt(b.code)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    if (!isNaN(na)) return -1
    if (!isNaN(nb)) return 1
    return a.code.localeCompare(b.code)
  })

  if (list.length === 0) {
    console.log('No hay habitaciones activas.')
    return
  }

  const pdf = await PDFDocument.create()

  for (const room of list) {
    const token = await ensureRoomQrToken(room.id)
    const url = `${baseUrl}/room?t=${token}`
    const qrDataUrl = await QRCode.toDataURL(url, { width: 500, margin: 1, color: { dark: '#111827', light: '#ffffff' } })

    const svg = buildCardSvg(room.code, qrDataUrl, logoUri, footer)
    const png = new Resvg(svg, { font: { loadSystemFonts: true }, fitTo: { mode: 'width', value: W } }).render().asPng()

    const image = await pdf.embedPng(png)
    const page = pdf.addPage([A5_PT_W, A5_PT_H])
    page.drawImage(image, { x: 0, y: 0, width: A5_PT_W, height: A5_PT_H })

    console.log(`✓ Habitación ${room.code} → ${url}`)
  }

  const bytes = await pdf.save()
  await Bun.write(OUT_PATH, bytes)
  console.log(`\n${list.length} habitación(es) — PDF generado en ${OUT_PATH}`)
}

withTenant(main).then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
