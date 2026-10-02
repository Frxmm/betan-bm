// ─── Plantilla del contrato de admisión de huésped ─────────────────────────────
// Genera HTML autocontenido: sin firma (preview para firmar) o con firma embebida
// en base64 (documento final que se archiva en BD).

import type { Branding } from './property'

const ID_DOC_LABELS: Record<string, string> = {
  dni: 'DNI', nie: 'NIE', passport: 'PASAPORTE', driving_license: 'CARNET DE CONDUCIR',
  residence_permit: 'PERMISO DE RESIDENCIA', eu_id: 'DOC. IDENTIDAD UE', other: 'OTRO',
}

export interface ContractData {
  guestName:    string
  idDocType:    string | null
  idDocNumber:  string | null
  checkIn:      string
  checkOut:     string
  roomCode:     string
  roomTypeName: string
  people:       number
  rateTitle:    string
  total:        string
  reservationId: number
}

export interface SignatureData {
  signaturePng: string   // data:image/png;base64,...
  signedAt:     Date
  signedIp:     string
}

const fmtDate = (iso: string) => {
  const [y, m, d] = iso.split('-')
  return `${d}/${m}/${y}`
}

// Plantilla genérica de condiciones de admisión (si el tenant no ha definido
// properties.admissionTermsHtml). Variables: {{hotel}}, {{legalName}}, {{cif}},
// {{rta}}, {{address}}, {{phone}}, {{email}}, {{web}}.
export const DEFAULT_ADMISSION_TERMS_HTML = `
<p><strong>Condiciones generales de admisión / General admission terms</strong></p>
<p>El acceso y la estancia en {{hotel}} ({{legalName}}, CIF {{cif}}) implican la aceptación de estas condiciones y del reglamento de régimen interior, disponible en recepción.
Access to and stay at {{hotel}} imply acceptance of these terms and of the house rules, available at reception.</p>
<p>El huésped se compromete a hacer un uso adecuado de las instalaciones, a respetar el descanso del resto de clientes y a abandonar la habitación en la fecha y hora de salida acordadas.
The guest agrees to make proper use of the facilities, to respect other guests and to vacate the room at the agreed check-out date and time.</p>
<p>Para cualquier consulta: {{phone}} · {{email}}.</p>`

/** Sustituye {{variables}} por datos del tenant (escapados) y sanea el HTML de términos. */
export function renderAdmissionTerms(branding: Branding, termsHtml?: string | null): string {
  const tpl = (termsHtml && termsHtml.trim()) ? termsHtml : DEFAULT_ADMISSION_TERMS_HTML
  const vars: Record<string, string> = {
    hotel: branding.name, legalName: branding.legalName, cif: branding.vatNumber,
    rta: branding.touristRegistryNumber, address: branding.fullAddress, phone: branding.phone,
    email: branding.receptionEmail, web: branding.websiteUrl,
  }
  const filled = tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => esc(vars[k] ?? ''))
  return sanitizeHtml(filled)
}

// Saneado básico: los términos los escribe el admin del tenant y se muestran en
// una página pública — se quitan scripts, iframes, manejadores on* y javascript:.
function sanitizeHtml(html: string): string {
  return html
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi, '')
    .replace(/<\s*(script|iframe|object|embed|link|meta|base|form)\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')/gi, '$1="#"')
}

/** Página HTML autocontenida con las condiciones de admisión del tenant. */
export function renderAdmissionTermsPage(branding: Branding, termsHtml?: string | null): string {
  return `<!doctype html>
<html lang="${esc(branding.localeDefault)}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(branding.name)}</title>
<style>body{font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto;padding:24px 20px;font-size:14px;line-height:1.55;color:#111}</style>
</head><body><h2>${esc(branding.name)}</h2>${renderAdmissionTerms(branding, termsHtml)}</body></html>`
}

export function renderContract(data: ContractData, branding: Branding, termsHtml?: string | null, sig?: SignatureData): string {
  const docLabel = data.idDocType ? (ID_DOC_LABELS[data.idDocType] ?? data.idDocType.toUpperCase()) : ''

  const signatureBlock = sig
    ? `<div class="sig-box">
        <img src="${sig.signaturePng}" alt="Firma del cliente" style="max-width:320px;max-height:140px" />
        <div class="sig-meta">
          Firmado electrónicamente el ${sig.signedAt.toLocaleString('es-ES', { timeZone: branding.timezone })}
          · IP ${sig.signedIp} · Reserva #${data.reservationId}
        </div>
      </div>`
    : `<div class="sig-box sig-empty">(pendiente de firma)</div>`

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contrato de admisión — ${esc(branding.name)} — Reserva #${data.reservationId}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #111; margin: 0 auto; max-width: 720px; padding: 24px 20px; font-size: 14px; line-height: 1.5; background: #fff; }
  h2 { margin: 0; font-size: 18px; }
  hr { border: none; border-top: 1px solid #ccc; margin: 14px 0; }
  .head { display: flex; align-items: center; gap: 14px; }
  .head img { width: 75px; height: 50px; object-fit: contain; }
  .field { margin: 6px 0; }
  .field strong { display: inline-block; min-width: 210px; }
  .total { text-decoration: underline; font-weight: bold; }
  .legal { font-size: 12.5px; color: #333; margin-top: 18px; }
  .sig-box { margin-top: 24px; border: 1px solid #999; border-radius: 6px; padding: 12px; min-height: 120px; }
  .sig-empty { color: #999; display: flex; align-items: center; justify-content: center; }
  .sig-meta { font-size: 11px; color: #555; margin-top: 8px; border-top: 1px dashed #ccc; padding-top: 6px; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="head">
    ${branding.logoUrl ? `<img src="${esc(branding.logoUrl)}" alt="${esc(branding.name)}" />` : ''}
    <h2>${esc(branding.name.toUpperCase())} — ADMISSION DOCUMENT</h2>
  </div>
  <hr />
  <p style="font-size:12.5px">
    HOTEL INFORMATION: ${esc(branding.legalName)}${branding.fullAddress ? ', ' + esc(branding.fullAddress) : ''}.<br/>
    ${[branding.phone && `PHONE: ${esc(branding.phone)}`, branding.vatNumber && `CIF: ${esc(branding.vatNumber)}`,
       `${esc(branding.name.toUpperCase())}${branding.starLabel ? ' ' + esc(branding.starLabel) : ''}${branding.touristRegistryNumber ? ' Nº ' + esc(branding.touristRegistryNumber) : ''}`]
      .filter(Boolean).join(' · ')}
  </p>
  <hr />
  <div class="field"><strong>CLIENT:</strong> ${esc(data.guestName)}</div>
  <div class="field"><strong>DOCUMENT CLIENT ID:</strong> ${docLabel} ${esc(data.idDocNumber ?? '—')}</div>
  <div class="field"><strong>DATE OF ENTRY:</strong> ${fmtDate(data.checkIn)}</div>
  <div class="field"><strong>DEPARTURE DATE:</strong> ${fmtDate(data.checkOut)}</div>
  <div class="field"><strong>ROOM:</strong> ${esc(data.roomCode)}</div>
  <div class="field"><strong>ROOM TYPE:</strong> ${esc(data.roomTypeName)}</div>
  <div class="field"><strong>PEOPLE:</strong> ${data.people}</div>
  <div class="field"><strong>RATE:</strong> ${esc(data.rateTitle)}</div>
  <div class="field"><strong>TOTAL AMOUNT OF STAY:</strong> <span class="total">${esc(data.total)} ${esc(currencySymbol(branding.currencyCode))}</span></div>
  <div class="legal">
    <p>
      The guest accepts the conditions of the contracted rate and the admission terms below, and declares
      having been duly informed of their rights and obligations as a user and of the existence of internal regulations.
    </p>
    <p>
      El huésped acepta las condiciones de la tarifa contratada y las condiciones de admisión que figuran a continuación,
      y declara haber sido debidamente informado de sus derechos y obligaciones como usuario y de la existencia del
      reglamento de régimen interior.
    </p>
    ${renderAdmissionTerms(branding, termsHtml)}
  </div>
  <div class="field" style="margin-top:20px"><strong>SIGNED CLIENT:</strong></div>
  ${signatureBlock}
</body>
</html>`
}

function currencySymbol(code: string): string {
  return ({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[code] ?? code
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
