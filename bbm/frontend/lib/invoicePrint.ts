export const DEFAULT_INVOICE_TEMPLATE = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>Factura {{invoiceNumber}}</title>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans&display=swap" rel="stylesheet">
<style>
body { font-family: 'Open Sans', Arial, sans-serif; margin: 32px; font-size: 13px; color: #222; }
.invoice-items-table { width: 100%; border-collapse: collapse; border-spacing: 0; }
.invoice-items-table-header-tr { background: #F5F6F7; vertical-align: middle; }
.invoice-items-table-header-tr td, .invoice-items-table-body-tr td { border: 1px solid #D8D8D7; padding: 10px; }
.invoice-items-table-narrow-td { width: 1%; }
.invoice-items-table-wide-td { width: 90%; }
.invoice-items-table-number-td { text-align: right; white-space: nowrap; }
.invoice-items-table-footer-label-td { padding: 10px; text-align: right; }
.invoice-items-table-footer-value-td { padding: 10px; text-align: right; border: 1px solid #D8D8D7; }
hr { border: none; border-top: 1px solid #ccc; }
h1 { margin: 0 0 4px; font-size: 20px; }
h2 { margin: 4px 0; font-size: 16px; }
@media print { body { margin: 16px; } }
</style>
</head>
<body>

<table width="760"><tbody><tr>
<td style="width:20%; vertical-align:top">
  {{hotelLogoImg}}
</td>
<td style="vertical-align:top">
  <h1>{{hotelName}} {{hotelStars}}</h1>
  {{#hotelRta}}<p style="margin:4px 0">N&ordm; R.T.A.: {{hotelRta}}</p>{{/hotelRta}}
</td>
<td style="width:30%; text-align:left; vertical-align:top; font-size:12px">
  <p style="margin:0">{{hotelLegalName}}</p>
  <p style="margin:4px 0">{{#hotelVat}}CIF: {{hotelVat}}<br>{{/hotelVat}}
  {{hotelAddress}}<br>
  {{hotelEmail}}<br>
  {{hotelPhone}}<br>
  {{hotelWeb}}</p>
</td>
</tr></tbody></table>

<table width="765"><tbody><tr><td style="text-align:center">
  <hr><h2>FACTURA</h2><hr>
</td></tr></tbody></table>

<table style="width:765px"><tbody><tr>
<td style="vertical-align:top">
  Factura a<br>
  <b>{{guestFirstName}} {{guestLastName}}</b><br>
  {{#company}}<b>{{guestCompany}}</b><br>{{/company}}
  {{guestAddress1}}<br>
  {{#address2}}{{guestAddress2}}<br>{{/address2}}
  {{guestCity}}<br>
  {{guestPostalCode}}<br>
  {{guestCountry}}<br>
  {{#nif}}NIF/CIF: {{guestNif}}{{/nif}}
</td>
<td style="width:39%; vertical-align:top">
  <table width="245"><tbody>
  <tr><td><b>Factura&nbsp;#</b></td><td>{{invoiceNumber}}</td></tr>
  <tr><td><b>Fecha</b></td><td>{{date}}</td></tr>
  <tr><td><b>Condiciones</b></td><td>Contado</td></tr>
  <tr><td><b>Vencimiento</b></td><td>{{date}}</td></tr>
  </tbody></table>
</td>
</tr></tbody></table>

<table width="764"><tbody><tr>
<td>Tarifa: <b>{{rate}}</b></td>
<td>Pax: {{pax}}</td>
<td>Reserva: {{reservationCode}}</td>
<td>Check-in: {{checkIn}}</td>
<td>Check-out: {{checkOut}}</td>
</tr></tbody></table>

<table width="764"><tbody><tr><td>{{itemsTable}}</td></tr></tbody></table>

<p>&nbsp;</p>
<table width="765"><tbody>
<tr><td><b>Notas Adicionales</b></td></tr>
<tr><td>{{notes}}</td></tr>
<tr><td>
  <p>Condiciones de pago:</p>
  <p>{{paymentMethod}}</p>
</td></tr>
</tbody></table>

<footer style="color:gray; font-size:9px; margin-top:40px">
  <p align="center">{{hotelLegalName}}{{#hotelVat}} - CIF: {{hotelVat}}{{/hotelVat}}</p>
  {{#hotelRegistry}}<p align="center">{{hotelRegistry}}</p>{{/hotelRegistry}}
</footer>

</body>
</html>`

/** Datos del hotel para la cabecera/pie de la factura (vienen de useProperty() / branding del tenant). */
export interface InvoiceBranding {
  name?: string
  legalName?: string
  vatNumber?: string
  touristRegistryNumber?: string
  fullAddress?: string
  logoUrl?: string
  starLabel?: string
  email?: string
  receptionEmail?: string
  phone?: string
  websiteUrl?: string
  currencyCode?: string
  /** Línea libre del pie (ej. inscripción en el Registro Mercantil) */
  invoiceFooter?: string
}

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

export function brandingData(b?: InvoiceBranding | null): Record<string, string> {
  const x = b ?? {}
  return {
    '{{hotelName}}':      esc(x.name),
    '{{hotelLegalName}}': esc(x.legalName || x.name),
    '{{hotelVat}}':       esc(x.vatNumber),
    '{{hotelRta}}':       esc(x.touristRegistryNumber),
    '{{hotelAddress}}':   esc(x.fullAddress).replace(/\n/g, '<br>'),
    '{{hotelEmail}}':     esc(x.email || x.receptionEmail),
    '{{hotelPhone}}':     esc(x.phone),
    '{{hotelWeb}}':       esc((x.websiteUrl ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')),
    '{{hotelStars}}':     esc(x.starLabel),
    '{{hotelRegistry}}':  esc(x.invoiceFooter),
    '{{hotelLogoImg}}':   x.logoUrl ? `<img src="${esc(x.logoUrl)}" width="177" alt="${esc(x.name)}" style="max-width:177px;height:auto">` : '',
  }
}

/** Símbolo de la moneda del tenant (EUR por defecto). */
export function currencySymbol(code?: string): string {
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: code || 'EUR' })
      .formatToParts(0).find(p => p.type === 'currency')?.value ?? (code || '€')
  } catch { return code || '€' }
}

export function fmtEuro(n: number): string {
  return n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function fmtInvoiceDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

export function buildItemsTable(inv: any, currencyCode?: string): string {
  const cur = currencySymbol(currencyCode)
  const subtotal = parseFloat(inv.subtotal ?? '0')
  const taxAmt   = parseFloat(inv.taxAmount ?? '0')
  const total    = parseFloat(inv.total ?? '0')
  const taxPct   = taxAmt > 0 && subtotal > 0 ? Math.round((taxAmt / subtotal) * 100) : 0

  const customItems: Array<{ description: string; quantity: number; unitPrice: number }> | null =
    Array.isArray(inv.lineItems) && inv.lineItems.length > 0 ? inv.lineItems : null

  let bodyRows: string
  if (customItems) {
    bodyRows = customItems.map(item => {
      const lineTotal = (item.quantity || 0) * (item.unitPrice || 0)
      return `<tr class="invoice-items-table-body-tr">
    <td>${item.description}</td>
    <td class="invoice-items-table-narrow-td" style="text-align:center">${item.quantity}</td>
    <td class="invoice-items-table-number-td">${fmtEuro(item.unitPrice)} ${cur}</td>
    <td class="invoice-items-table-number-td">${fmtEuro(lineTotal)} ${cur}</td>
  </tr>`
    }).join('\n  ')
  } else {
    const nights        = inv.reservation?.nights ?? 1
    const rateName      = inv.reservation?.rate?.title ?? 'Alojamiento'
    const pricePerNight = nights > 0 ? subtotal / nights : subtotal
    bodyRows = `<tr class="invoice-items-table-body-tr">
    <td>Alojamiento — ${rateName}</td>
    <td class="invoice-items-table-narrow-td" style="text-align:center">${nights}</td>
    <td class="invoice-items-table-number-td">${fmtEuro(pricePerNight)} ${cur}</td>
    <td class="invoice-items-table-number-td">${fmtEuro(subtotal)} ${cur}</td>
  </tr>`
  }

  const colHeader = customItems
    ? `<td class="invoice-items-table-narrow-td" style="text-align:center">Cant.</td>
    <td class="invoice-items-table-number-td">P. unit.</td>`
    : `<td class="invoice-items-table-narrow-td" style="text-align:center">Noches</td>
    <td class="invoice-items-table-number-td">Precio/noche</td>`

  return `<table class="invoice-items-table">
  <thead><tr class="invoice-items-table-header-tr">
    <td class="invoice-items-table-wide-td">Descripción</td>
    ${colHeader}
    <td class="invoice-items-table-number-td">Importe</td>
  </tr></thead>
  <tbody>${bodyRows}</tbody>
  <tfoot>
    <tr><td colspan="3" class="invoice-items-table-footer-label-td"><b>BASE IMPONIBLE</b></td>
      <td class="invoice-items-table-footer-value-td">${fmtEuro(subtotal)} ${cur}</td></tr>
    <tr><td colspan="3" class="invoice-items-table-footer-label-td"><b>IVA (${taxPct}%)</b></td>
      <td class="invoice-items-table-footer-value-td">${fmtEuro(taxAmt)} ${cur}</td></tr>
    <tr><td colspan="3" class="invoice-items-table-footer-label-td" style="font-size:15px"><b>TOTAL</b></td>
      <td class="invoice-items-table-footer-value-td" style="font-size:15px"><b>${fmtEuro(total)} ${cur}</b></td></tr>
  </tfoot>
</table>`
}

function applyConditional(html: string, tag: string, show: boolean): string {
  if (show) return html.replace(new RegExp(`\\{\\{#${tag}\\}\\}([\\s\\S]*?)\\{\\{\\/${tag}\\}\\}`, 'g'), '$1')
  return html.replace(new RegExp(`\\{\\{#${tag}\\}\\}[\\s\\S]*?\\{\\{\\/${tag}\\}\\}`, 'g'), '')
}

export function renderTemplate(tpl: string, data: Record<string, string>): string {
  let out = tpl
  for (const [k, v] of Object.entries(data)) out = out.replaceAll(k, v)
  out = out.replace(/\{\{#\w+\}\}([\s\S]*?)\{\{\/\w+\}\}/g, '$1')
  return out
}

export async function fetchInvoiceTemplate(): Promise<string | null> {
  try {
    const r = await fetch('/api/financial/invoice-config', { credentials: 'include' })
    const d = await r.json()
    return d.data?.htmlTemplate ?? null
  } catch { return null }
}

// Construye el HTML final de la factura (plantilla ya rellenada) — sin nada
// de navegador, puro string building, así que también lo puede llamar un
// script de Node/Bun sin DOM y el resultado es IDÉNTICO al que ve el usuario al "Imprimir".
export function buildInvoiceHtml(inv: any, template: string | null, branding?: InvoiceBranding | null): string {
  const g = inv.guest ?? {}
  const r = inv.reservation ?? {}

  // Los campos de facturación tienen prioridad sobre los del huésped
  const billingName    = inv.billingName    || null   // nombre/empresa del destinatario
  const billingNif     = inv.billingNif     || null   // NIF/CIF
  const billingAddress = inv.billingAddress || null   // dirección completa (texto libre)

  // billingName reemplaza el nombre del huésped cuando está presente
  const resolvedFirstName = billingName ?? g.firstName ?? ''
  const resolvedLastName  = billingName ? '' : (g.lastName ?? '')
  const resolvedNif       = billingNif  ?? g.idDocNumber ?? ''
  // billingAddress reemplaza dirección; si está, no mostramos ciudad/CP del huésped (van en la misma línea)
  const resolvedAddress1  = billingAddress ?? g.address1 ?? ''
  const resolvedCity      = billingAddress ? '' : (g.city    ?? '')
  const resolvedPostal    = billingAddress ? '' : (g.zipCode ?? '')

  const data: Record<string, string> = {
    '{{invoiceNumber}}':   inv.invoiceNumber ?? '',
    '{{date}}':            fmtInvoiceDate(inv.issuedAt),
    '{{guestFirstName}}':  resolvedFirstName,
    '{{guestLastName}}':   resolvedLastName,
    '{{guestCompany}}':    '',
    '{{guestAddress1}}':   resolvedAddress1,
    '{{guestAddress2}}':   '',
    '{{guestCity}}':       resolvedCity,
    '{{guestPostalCode}}': resolvedPostal,
    '{{guestCountry}}':    g.nationality  ?? '',
    '{{guestNif}}':        resolvedNif,
    '{{reservationCode}}': r.externalCode ?? (r.id ? `#${r.id}` : ''),
    '{{checkIn}}':         fmtInvoiceDate(r.checkInDate  ?? ''),
    '{{checkOut}}':        fmtInvoiceDate(r.checkOutDate ?? ''),
    '{{nights}}':          String(r.nights ?? ''),
    '{{pax}}':             String(r.people ?? ''),
    '{{rate}}':            r.rate?.title  ?? '',
    '{{subtotal}}':        fmtEuro(parseFloat(inv.subtotal  ?? '0')),
    '{{taxAmount}}':       fmtEuro(parseFloat(inv.taxAmount ?? '0')),
    '{{total}}':           fmtEuro(parseFloat(inv.total     ?? '0')),
    '{{paymentMethod}}':   'Contado',
    '{{notes}}':           inv.notes ?? '',
    '{{itemsTable}}':      buildItemsTable(inv, branding?.currencyCode),
    ...brandingData(branding),
  }

  let html = template ?? DEFAULT_INVOICE_TEMPLATE
  for (const [k, v] of Object.entries(data)) html = html.replaceAll(k, v)

  html = applyConditional(html, 'company',  false)
  html = applyConditional(html, 'address2', false)
  html = applyConditional(html, 'nif',      !!resolvedNif)
  for (const tag of ['hotelRta', 'hotelVat', 'hotelRegistry']) html = applyConditional(html, tag, !!data[`{{${tag}}}`])
  html = html.replace(/\{\{#\w+\}\}[\s\S]*?\{\{\/\w+\}\}/g, '')

  return html
}

export function printInvoice(inv: any, template: string | null, branding?: InvoiceBranding | null): void {
  const html = buildInvoiceHtml(inv, template, branding) + '<script>window.onload=()=>window.print()<\/script>'
  const w = window.open('', '_blank')
  if (w) { w.document.write(html); w.document.close() }
}
