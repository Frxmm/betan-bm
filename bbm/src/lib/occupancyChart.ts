// ─── Gráfico de ocupación mensual (PNG) ────────────────────────────────────────
// Genera un gráfico de barras (% ocupación por día) para incrustar en el
// resumen diario por email — el mismo espíritu que el gráfico de Informes →
// Ocupación (mismos colores: occColor en PriceCalendarView.tsx) pero sin la
// tabla de abajo, exportado a PNG porque los clientes de correo no renderizan
// SVG de forma fiable (Gmail entre otros). No hay canvas/navegador en el
// servidor, así que se construye el SVG a mano y se rasteriza con resvg
// (@resvg/resvg-js — WASM/nativo, sin dependencias de sistema).
import { Resvg } from '@resvg/resvg-js'

function occColor(pct: number): string {
  if (pct >= 80) return '#22c55e'
  if (pct >= 60) return '#3b82f6'
  if (pct >= 40) return '#f59e0b'
  return '#94a3b8'
}

export function renderOccupancyChartPng(opts: {
  title: string
  days: { label: string; occupancyPct: number }[]
  totalRevenue: number
  /** Símbolo de moneda del tenant (por defecto €). */
  currencySymbol?: string
}): Buffer {
  const { title, days, totalRevenue } = opts
  const sym = opts.currencySymbol ?? '€'
  const W = 900, H = 380
  const padL = 44, padR = 20, padT = 60, padB = 46
  const chartW = W - padL - padR
  const chartH = H - padT - padB
  const n = Math.max(1, days.length)
  const slot = chartW / n
  const barGap = Math.min(4, slot * 0.2)
  const barW = Math.max(1, slot - barGap)

  const bars = days.map((d, i) => {
    const x = padL + i * slot + barGap / 2
    const h = Math.max(1, (Math.max(0, Math.min(100, d.occupancyPct)) / 100) * chartH)
    const y = padT + chartH - h
    const color = occColor(d.occupancyPct)
    // Con muchos días, una etiqueta por barra se amontona — se muestran como
    // mucho ~15 repartidas por todo el ancho.
    const labelStep = Math.max(1, Math.ceil(n / 15))
    const label = i % labelStep === 0
      ? `<text x="${(x + barW / 2).toFixed(1)}" y="${padT + chartH + 16}" font-size="10" fill="#64748b" text-anchor="middle" font-family="Arial, sans-serif">${d.label}</text>`
      : ''
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="1.5" />${label}`
  }).join('')

  const gridLines = [0, 25, 50, 75, 100].map(pct => {
    const y = padT + chartH - (pct / 100) * chartH
    return `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + chartW}" y2="${y.toFixed(1)}" stroke="#e2e8f0" stroke-width="1" />
      <text x="${padL - 8}" y="${(y + 3).toFixed(1)}" font-size="10" fill="#94a3b8" text-anchor="end" font-family="Arial, sans-serif">${pct}%</text>`
  }).join('')

  const fmtRevenue = totalRevenue.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="#ffffff" />
    <text x="${padL}" y="24" font-size="16" font-weight="700" fill="#111827" font-family="Arial, sans-serif">${title}</text>
    <text x="${padL}" y="42" font-size="12" fill="#475569" font-family="Arial, sans-serif">Ingresos totales del período: ${fmtRevenue} ${sym}</text>
    ${gridLines}
    ${bars}
  </svg>`

  const resvg = new Resvg(svg, { font: { loadSystemFonts: true }, fitTo: { mode: 'width', value: W } })
  return resvg.render().asPng()
}
