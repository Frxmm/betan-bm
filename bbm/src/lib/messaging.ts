// ─── Control central de canales por tipo de mensaje ───────────────────────────
// El admin decide en Ajustes qué mensajes salen por email y cuáles por WhatsApp.
// Cada punto de envío pregunta channelEnabled(key, canal) antes de mandar nada.

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { messageSettings, messageTemplates, customerTokens } from '../db/schema'
import { env } from './env'
import { getPropertyId, getBranding, getSetting, type Branding } from './property'

export type MessageKey =
  | 'booking_confirmation'   // confirmación de reserva nueva (web propia o cualquier canal sincronizado)
  | 'lock_code'              // código de cerradura
  | 'checkin_link'           // enlace de check-in online
  | 'payment_reminder'       // recordatorio de saldo pendiente
  | 'cart_recovery'          // recuperación de carrito con descuento
  | 'cancellation_recovery'  // reenganche de reserva cancelada con descuento
  | 'guest_thank_you'        // agradecimiento + petición de reseña (check-out con valoración 5★)

// Qué canales tiene implementados cada mensaje (los no implementados no se
// muestran como configurables en el panel)
export const MESSAGE_CATALOG: Record<MessageKey, { label: string; email: boolean; whatsapp: boolean }> = {
  booking_confirmation: { label: 'Confirmación de reserva',       email: true,  whatsapp: true  },
  lock_code:            { label: 'Código de cerradura',           email: true,  whatsapp: true  },
  checkin_link:         { label: 'Enlace de check-in online',     email: true,  whatsapp: true  },
  payment_reminder:     { label: 'Recordatorio de pago pendiente', email: true,  whatsapp: true },
  cart_recovery:        { label: 'Recuperación de carrito (10%)', email: true,  whatsapp: true  },
  cancellation_recovery: { label: 'Reenganche de reserva cancelada', email: true, whatsapp: true },
  guest_thank_you:      { label: 'Agradecimiento + reseña (check-out 5★)', email: true, whatsapp: false },
}

type Setting = { email: boolean; whatsapp: boolean; excludedChannelIds: number[] }
// Cachés por tenant (clave = propertyId)
const cache = new Map<number, { rows: Map<string, Setting>; at: number }>()

async function loadSettings(): Promise<Map<string, Setting>> {
  const pid = getPropertyId()
  const hit = cache.get(pid)
  if (hit && Date.now() - hit.at < 60_000) return hit.rows
  const rows = await db.select().from(messageSettings).where(eq(messageSettings.propertyId, pid))
  const entry = {
    rows: new Map(rows.map(r => [r.key, {
      email: r.email, whatsapp: r.whatsapp,
      excludedChannelIds: (r.excludedChannelIds as number[]) ?? [],
    }])),
    at: Date.now(),
  }
  cache.set(pid, entry)
  return entry.rows
}

// Sin argumento limpia la caché del tenant del contexto (o todas si no hay contexto)
export function clearMessagingCache() {
  try {
    const pid = getPropertyId()
    cache.delete(pid); tplCache.delete(pid)
  } catch { cache.clear(); tplCache.clear() }
}

// Base pública del portal/web del tenant: su dominio público, o PUBLIC_URL como respaldo
export async function publicBaseUrl(): Promise<string> {
  const b = await getBranding()
  if (b.publicDomain) return /^https?:\/\//.test(b.publicDomain) ? b.publicDomain.replace(/\/$/, '') : `https://${b.publicDomain}`
  return env.PUBLIC_URL
}

// Enlace al portal del cliente con token de acceso directo (48 h)
export async function portalLink(email: string): Promise<string> {
  const token = crypto.randomUUID()
  await db.insert(customerTokens).values({
    email, token, expiresAt: new Date(Date.now() + 48 * 3_600_000),
  })
  return `${await publicBaseUrl()}/portal?token=${token}`
}

// ─── Plantillas de email ───────────────────────────────────────────────────────
// Editables por el admin ({{variable}} se sustituye al enviar); si no hay
// plantilla guardada se usa la de fábrica.

export const EMAIL_TEMPLATE_VARS: Record<string, string[]> = {
  booking_confirmation: ['name', 'checkIn', 'checkOut', 'room', 'total', 'balance', 'resId', 'portalUrl'],
  checkin_link:         ['name', 'checkIn', 'checkOut', 'resId', 'portalUrl'],
  lock_code:            ['guestName', 'roomCode', 'code', 'checkIn', 'checkOut'],
  payment_reminder:     ['name', 'due', 'resId', 'portalUrl'],
  cart_recovery:        ['name', 'checkIn', 'checkOut', 'total', 'discounted', 'discountPct', 'url'],
  cancellation_recovery: ['name', 'checkIn', 'checkOut', 'total', 'discounted', 'discountPct', 'url'],
  guest_thank_you:      ['name'],
}

export const DEFAULT_EMAIL_TEMPLATES: Record<string, { subject: string; html: string }> = {
  booking_confirmation: {
    subject: 'Reserva confirmada — {{hotelName}}',
    html: `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; padding:0; background:#f4f6f8; font-family: Arial, sans-serif; }
  .container { max-width:600px; margin:auto; background:#ffffff; }
  .header { text-align:center; padding:30px 20px; }
  .logo { max-width:180px; }
  .hero { background:#0f172a; color:#ffffff; text-align:center; padding:30px 20px; }
  .hero h1 { margin:0; font-size:24px; }
  .hero p { margin:10px 0 0; font-size:16px; opacity:0.9; }
  .button { display:inline-block; margin-top:20px; padding:14px 24px; background:#10b981; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold; }
  .card { padding:20px; border-bottom:1px solid #eee; }
  .card h2 { font-size:18px; margin-bottom:10px; color:#111827; }
  .details { width:100%; font-size:14px; }
  .details td { padding:6px 0; }
  .label { color:#6b7280; }
  .value { font-weight:bold; color:#111827; }
  .warning { background:#fff7ed; border-left:4px solid #f97316; padding:15px; border-radius:6px; }
  .footer { text-align:center; font-size:13px; color:#6b7280; padding:20px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <img src="{{hotelLogo}}" class="logo" />
    <p>{{hotelWeb}}</p>
  </div>
  <div class="hero">
    <h1>Gracias {{name}} 👋</h1>
    <p>Tu reserva en <strong>{{hotelName}}</strong> está confirmada</p>
    <a href="{{portalUrl}}" class="button">Gestionar reserva / Check-in online</a>
  </div>
  <div class="card">
    <h2>📄 Detalles de la reserva</h2>
    <table class="details">
      <tr><td class="label">Número</td><td class="value">#{{resId}}</td></tr>
      <tr><td class="label">Huésped</td><td class="value">{{name}}</td></tr>
      <tr><td class="label">Check-in</td><td class="value">{{checkIn}}</td></tr>
      <tr><td class="label">Check-out</td><td class="value">{{checkOut}}</td></tr>
      <tr><td class="label">Habitación</td><td class="value">{{room}}</td></tr>
    </table>
  </div>
  <div class="card">
    <h2>💳 Precio</h2>
    <table class="details">
      <tr><td>Total</td><td class="value">{{total}} €</td></tr>
      <tr><td>Pendiente en llegada</td><td class="value">{{balance}} €</td></tr>
    </table>
    <p style="font-size:12px;color:#6b7280">IVA incluido</p>
  </div>
  {{policyHtml}}
  <div class="footer">
    <p>{{hotelName}} · {{hotelAddress}}</p>
    <p>{{hotelEmail}}</p>
    <p>Has recibido este email por tu reserva en {{hotelName}}</p>
  </div>
</div>
</body>
</html>`,
  },
  checkin_link: {
    subject: 'Completa tu check-in online — {{hotelName}}',
    html: `<!doctype html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin:0; padding:0; background:#f4f6f8; font-family: Arial, sans-serif; }
  .container { max-width:600px; margin:auto; background:#ffffff; }
  .header { text-align:center; padding:25px 20px; border-bottom:1px solid #eee; }
  .logo { max-width:150px; }
  .hero { background:#0f172a; color:#ffffff; text-align:center; padding:30px 20px; }
  .hero h1 { margin:0; font-size:24px; }
  .hero p { margin:10px 0 0; font-size:16px; opacity:0.9; }
  .button { display:inline-block; margin-top:20px; padding:14px 24px; background:#10b981; color:#fff; text-decoration:none; border-radius:6px; font-weight:bold; }
  .card { padding:20px; border-bottom:1px solid #eee; }
  .card h2 { font-size:18px; margin-bottom:10px; color:#111827; }
  .details { font-size:14px; color:#374151; }
  .highlight { background:#f9fafb; padding:15px; border-radius:6px; }
  .steps { background:#f0fdf4; border-left:4px solid #10b981; padding:15px; border-radius:6px; }
  .footer { text-align:center; font-size:13px; color:#6b7280; padding:20px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <img src="{{hotelLogo}}" class="logo" />
    <p>{{hotelWeb}}</p>
  </div>
  <div class="hero">
    <h1>Hola {{name}} 👋</h1>
    <p>Prepárate para tu estancia en <strong>{{hotelName}}</strong></p>
    <a href="{{portalUrl}}" class="button">Completar check-in online</a>
  </div>
  <div class="card">
    <h2>📄 Tu reserva</h2>
    <div class="highlight details">
      <p><strong>Reserva:</strong> #{{resId}}</p>
      <p><strong>Check-in:</strong> {{checkIn}}</p>
      <p><strong>Check-out:</strong> {{checkOut}}</p>
    </div>
  </div>
  <div class="card">
    <h2>🧾 Cómo hacer el check-in</h2>
    <div class="steps details">
      <p>1. Ten a mano tu documento de identidad</p>
      <p>2. Pulsa el botón de arriba</p>
      <p>3. Rellena tus datos</p>
    </div>
  </div>
  <div class="card" style="text-align:center">
    <a href="{{portalUrl}}" class="button">Empezar check-in</a>
  </div>
  <div class="card">
    <h2>📞 Contacto</h2>
    <p class="details">📧 <a href="mailto:{{hotelEmail}}">{{hotelEmail}}</a></p>
  </div>
  <div class="footer">
    <p>{{hotelName}} · {{hotelAddress}}</p>
  </div>
</div>
</body>
</html>`,
  },
  lock_code: {
    subject: 'Tu código de acceso — {{hotelName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">{{hotelName}}</h2>
  <p style="color:#555;margin-top:0">Tu código de acceso a la habitación</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola <strong>{{guestName}}</strong>,</p>
  <p>Aquí tienes el código de acceso para tu habitación:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:24px;text-align:center;margin:24px 0">
    <div style="font-size:13px;color:#777;margin-bottom:8px">Habitación <strong>{{roomCode}}</strong></div>
    <div style="font-size:42px;font-weight:700;letter-spacing:8px;font-family:monospace">{{code}}</div>
    <div style="font-size:12px;color:#999;margin-top:8px">Introduce este código en el teclado de la cerradura</div>
  </div>
  <p style="font-size:13px;color:#555">Válido del <strong>{{checkIn}}</strong> al <strong>{{checkOut}}</strong></p>
  <p style="font-size:12px;color:#aaa;margin-top:32px">{{hotelName}} · Si tienes problemas contacta con recepción</p>
</div>`,
  },
  payment_reminder: {
    subject: 'Saldo pendiente en tu reserva — {{hotelName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">{{hotelName}}</h2>
  <p style="color:#555;margin-top:0">Tienes un saldo pendiente</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola <strong>{{name}}</strong>,</p>
  <p>Tu reserva <strong>#{{resId}}</strong> tiene un saldo pendiente de pago:</p>
  <div style="background:#fff7ed;border-left:4px solid #f97316;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
    <div style="font-size:26px;font-weight:700">{{due}} €</div>
  </div>
  <div style="text-align:center;margin:24px 0">
    <a href="{{portalUrl}}" style="background:#1d4ed8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700">
      Pagar saldo pendiente
    </a>
  </div>
  <p style="font-size:12px;color:#999">Si ya has realizado el pago, ignora este mensaje.</p>
</div>`,
  },
  cart_recovery: {
    subject: '10% de descuento para completar tu reserva — {{hotelName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">{{hotelName}}</h2>
  <p style="color:#555;margin-top:0">Tu reserva te está esperando</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola <strong>{{name}}</strong>,</p>
  <p>Hemos visto que empezaste una reserva del <strong>{{checkIn}}</strong> al <strong>{{checkOut}}</strong> y no llegaste a completar el pago.</p>
  <p>Si la completas en las próximas 24 horas te aplicamos un <strong>{{discountPct}}% de descuento</strong>:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
    <div style="font-size:14px;color:#777"><s>{{total}} €</s></div>
    <div style="font-size:26px;font-weight:700">{{discounted}} €</div>
  </div>
  <div style="text-align:center;margin:24px 0">
    <a href="{{url}}" style="background:#1d4ed8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700">
      Completar mi reserva con descuento
    </a>
  </div>
  <p style="font-size:12px;color:#999">El descuento caduca en 24 horas y está sujeto a disponibilidad. Si ya no te interesa, ignora este mensaje.</p>
</div>`,
  },
  cancellation_recovery: {
    subject: '{{discountPct}}% de descuento para volver a reservar — {{hotelName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">{{hotelName}}</h2>
  <p style="color:#555;margin-top:0">¿Cambio de planes? Aún tienes hueco</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola <strong>{{name}}</strong>,</p>
  <p>Vimos que tuviste que cancelar tu estancia del <strong>{{checkIn}}</strong> al <strong>{{checkOut}}</strong>. Si al final te viene bien, te guardamos un <strong>{{discountPct}}% de descuento</strong> sobre tu precio:</p>
  <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:20px 0;text-align:center">
    <div style="font-size:14px;color:#777"><s>{{total}} €</s></div>
    <div style="font-size:26px;font-weight:700">{{discounted}} €</div>
  </div>
  <div style="text-align:center;margin:24px 0">
    <a href="{{url}}" style="background:#1d4ed8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700">
      Reservar con descuento
    </a>
  </div>
  <p style="font-size:12px;color:#999">Oferta sujeta a disponibilidad y caduca pronto. Si ya no te interesa, ignora este mensaje.</p>
</div>`,
  },
  guest_thank_you: {
    subject: 'Gracias por tu estancia — {{hotelName}}',
    html: `<div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">{{hotelName}}</h2>
  <p style="color:#555;margin-top:0">¡Gracias por tu visita!</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola <strong>{{name}}</strong>,</p>
  <p>Ha sido un placer tenerte con nosotros. Esperamos que hayas disfrutado tu estancia en {{hotelName}}.</p>
  <div style="text-align:center;margin:24px 0">
    <a href="{{hotelMaps}}" style="background:#1d4ed8;color:#fff;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700">
      Déjanos tu reseña
    </a>
  </div>
  <p style="font-size:13px;color:#555">Si algo no estuvo a la altura, escríbenos y lo solucionamos — tu opinión nos ayuda a mejorar.</p>
  <p style="font-size:12px;color:#aaa;margin-top:32px">{{hotelName}} · Gracias por elegirnos</p>
</div>`,
  },
}

const tplCache = new Map<number, { rows: Map<string, { subject: string; html: string }>; at: number }>()

async function loadTemplates(): Promise<Map<string, { subject: string; html: string }>> {
  const pid = getPropertyId()
  const hit = tplCache.get(pid)
  if (hit && Date.now() - hit.at < 60_000) return hit.rows
  const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.propertyId, pid))
  const entry = { rows: new Map(rows.map(r => [r.key, { subject: r.subject, html: r.html }])), at: Date.now() }
  tplCache.set(pid, entry)
  return entry.rows
}

// Variables de marca que reciben TODAS las plantillas (además de las propias de cada mensaje)
export const BRANDING_TEMPLATE_VARS = ['hotelName', 'hotelAddress', 'hotelPhone', 'hotelEmail', 'hotelWeb', 'hotelLogo', 'hotelMaps', 'hotelSignature', 'policyHtml']

export function brandingVars(b: Branding, policyHtml = ''): Record<string, string> {
  const web = b.websiteUrl || (b.publicDomain ? `https://${b.publicDomain}` : '')
  const maps = b.mapsUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([b.name, b.city].filter(Boolean).join(' '))}`
  return {
    hotelName: b.name, hotelAddress: b.fullAddress, hotelPhone: b.phone, hotelEmail: b.receptionEmail,
    hotelWeb: web.replace(/^https?:\/\//, ''), hotelLogo: b.logoUrl, hotelMaps: maps,
    hotelSignature: `${b.name}${b.fullAddress ? ' · ' + b.fullAddress : ''}`,
    policyHtml,
  }
}

function interpolate(str: string, vars: Record<string, string | number>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''))
}

// Renderiza subject+html de un email: plantilla personalizada si existe, si no la de fábrica
export async function renderEmail(
  key: keyof typeof DEFAULT_EMAIL_TEMPLATES,
  vars: Record<string, string | number>,
): Promise<{ subject: string; html: string }> {
  let tpl = DEFAULT_EMAIL_TEMPLATES[key]!
  try {
    const custom = (await loadTemplates()).get(key)
    if (custom) tpl = custom
  } catch {}
  // Bloque opcional de políticas del hotel (check-in/out, cancelación, depósitos…) en settings email.policyHtml
  const policyHtml = (await getSetting<string>('email.policyHtml', '')) ?? ''
  const all = { ...brandingVars(await getBranding(), policyHtml), ...vars }
  // policyHtml puede contener variables ({{hotelName}}…): se interpola dos veces
  const render = (t: string) => interpolate(interpolate(t, all), all)
  return { subject: render(tpl.subject), html: render(tpl.html) }
}

// ¿Está habilitado este mensaje por este canal de salida, para una reserva de
// este canal de venta? (bookingChannelId opcional: sin él solo se comprueba el
// canal de salida). Defecto: habilitado. Ante error de BD, no bloquear.
export async function channelEnabled(
  key: MessageKey,
  channel: 'email' | 'whatsapp',
  bookingChannelId?: number | null,
): Promise<boolean> {
  if (!MESSAGE_CATALOG[key]?.[channel]) return false   // canal no implementado
  try {
    const rows = await loadSettings()
    const row = rows.get(key)
    if (!row) return true
    if (!row[channel]) return false
    if (bookingChannelId && row.excludedChannelIds.includes(bookingChannelId)) return false
    return true
  } catch {
    return true
  }
}
