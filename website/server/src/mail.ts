import nodemailer, { type Transporter } from 'nodemailer'
import { config, smtpConfigured } from './config'
import { escapeHtml } from './util'

export interface LeadMail {
  id: number; name: string; email: string; hotel: string
  rooms: number | null; phone: string | null; plan: string | null; message: string | null; source: string | null
}

let transport: Transporter | null = null
function tx(): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  })
  return transport
}

/** Sustituible en tests. */
export const mailer = {
  async send(opts: { to: string; subject: string; text: string; html?: string; replyTo?: string }) {
    await tx().sendMail({ from: config.mail.from, ...opts })
  },
}

const row = (k: string, v: string | number | null) => (v == null || v === '' ? '' : `${k}: ${v}\n`)

export async function notifyLead(l: LeadMail): Promise<void> {
  const text =
    `Nueva solicitud de demo desde www.betanbm.com (#${l.id})\n\n` +
    row('Nombre', l.name) + row('Email', l.email) + row('Hotel', l.hotel) + row('Habitaciones', l.rooms) +
    row('Teléfono', l.phone) + row('Plan', l.plan) + row('Origen', l.source) +
    (l.message ? `\nMensaje:\n${l.message}\n` : '') +
    `\nResponde a este correo para contestar directamente al hotel.`
  await mailer.send({ to: config.mail.to, subject: `[Betan] Demo: ${l.hotel} (${l.name})`, text, replyTo: l.email })
}

export async function autoReply(l: LeadMail): Promise<void> {
  const text =
    `Hola ${l.name}:\n\n` +
    `Hemos recibido tu solicitud para ${l.hotel}. Te respondo personalmente en menos de un día laborable para concretar una demo de 15 minutos, en tu hotel o por videollamada.\n\n` +
    `Mientras tanto puedes ver cómo funciona Betan en ${config.siteUrl}\n\n` +
    `Un saludo,\nFran Rubio\nBetan Booking Manager · ${config.siteUrl}\n\n` +
    `Recibes este correo porque has pedido información en betanbm.com. No volveremos a escribirte salvo para contestar a tu solicitud. ` +
    `Responsable: Francisco Rubio Ortega. Puedes ejercer tus derechos escribiendo a ${config.mail.to}.`
  const html = `<p>Hola ${escapeHtml(l.name)}:</p><p>Hemos recibido tu solicitud para <b>${escapeHtml(l.hotel)}</b>. Te respondo personalmente en menos de un día laborable para concretar una demo de 15 minutos, en tu hotel o por videollamada.</p><p>Mientras tanto puedes ver cómo funciona Betan en <a href="${config.siteUrl}">${config.siteUrl}</a>.</p><p>Un saludo,<br>Fran Rubio<br>Betan Booking Manager</p><p style="color:#666;font-size:12px">Recibes este correo porque has pedido información en betanbm.com. No volveremos a escribirte salvo para contestar a tu solicitud. Responsable: Francisco Rubio Ortega. Puedes ejercer tus derechos escribiendo a ${escapeHtml(config.mail.to)}.</p>`
  await mailer.send({ to: l.email, subject: 'Hemos recibido tu solicitud · Betan', text, html, replyTo: config.mail.to })
}

export async function deliver(l: LeadMail, setStatus: (s: 'sent' | 'failed' | 'not_configured') => void): Promise<void> {
  if (!smtpConfigured()) {
    console.warn(`[mail] SMTP no configurado: lead #${l.id} (${l.hotel}) solo guardado en BD`)
    return setStatus('not_configured')
  }
  try {
    await notifyLead(l)
    setStatus('sent')
    if (config.mail.autoReply) await autoReply(l).catch(e => console.error('[mail] autorespuesta falló:', e?.message))
  } catch (e: any) {
    console.error(`[mail] aviso del lead #${l.id} falló:`, e?.message)
    setStatus('failed')
  }
}

export async function sendDocsLink(l: { name: string; email: string; hotel: string }, url: string, days: number): Promise<void> {
  const text =
    `Hola ${l.name}:\n\n` +
    `Aquí tienes la guía de usuario de Betan Booking Manager (recepción, housekeeping, facturación, tarifas, motor de reservas, agente IA y configuración):\n\n${url}\n\n` +
    `El enlace es personal y funciona durante ${days} días. Si caduca, vuelve a pedirla en ${config.siteUrl}/documentacion\n\n` +
    `Si quieres verlo funcionando con ${l.hotel}, respóndeme a este correo y quedamos 15 minutos.\n\n` +
    `Un saludo,\nFran Rubio\nBetan Booking Manager · ${config.siteUrl}\n\n` +
    `Recibes este correo porque has pedido la guía en betanbm.com. Responsable: Francisco Rubio Ortega. Derechos: ${config.mail.to}.`
  const html = `<p>Hola ${escapeHtml(l.name)}:</p><p>Aquí tienes la guía de usuario de <b>Betan Booking Manager</b> (recepción, housekeeping, facturación, tarifas, motor de reservas, agente IA y configuración):</p><p><a href="${escapeHtml(url)}">Abrir la guía de usuario</a></p><p>El enlace es personal y funciona durante ${days} días. Si caduca, vuelve a pedirla en <a href="${config.siteUrl}/documentacion">${config.siteUrl}/documentacion</a>.</p><p>Si quieres verlo funcionando con <b>${escapeHtml(l.hotel)}</b>, respóndeme a este correo y quedamos 15 minutos.</p><p>Un saludo,<br>Fran Rubio<br>Betan Booking Manager</p><p style="color:#666;font-size:12px">Recibes este correo porque has pedido la guía en betanbm.com. Responsable: Francisco Rubio Ortega. Derechos: ${escapeHtml(config.mail.to)}.</p>`
  await mailer.send({ to: l.email, subject: 'Tu guía de usuario de Betan', text, html, replyTo: config.mail.to })
}

export async function notifyDocs(l: { id: number; name: string; email: string; hotel: string; role: string | null; marketing: boolean }): Promise<void> {
  await mailer.send({
    to: config.mail.to, replyTo: l.email, subject: `[Betan] Guía de usuario pedida: ${l.hotel} (${l.name})`,
    text: `Solicitud de documentación (#${l.id})\n\nNombre: ${l.name}\nEmail: ${l.email}\nHotel: ${l.hotel}\nPuesto: ${l.role ?? '-'}\nAcepta novedades: ${l.marketing ? 'sí' : 'no'}\n\nEs un buen momento para escribirle y ofrecerle una demo.`,
  })
}

/** Envío del enlace de la guía + aviso al propietario. */
export async function deliverDocs(l: { id: number; name: string; email: string; hotel: string; role: string | null; marketing: boolean }, url: string, days: number,
  setStatus: (s: 'sent' | 'failed' | 'not_configured') => void): Promise<void> {
  if (!smtpConfigured()) {
    console.warn(`[mail] SMTP no configurado: enlace de documentación para ${l.email}: ${url}`)
    return setStatus('not_configured')
  }
  try {
    await sendDocsLink(l, url, days)
    setStatus('sent')
    await notifyDocs(l).catch(e => console.error('[mail] aviso de documentación falló:', e?.message))
  } catch (e: any) {
    console.error(`[mail] enlace de documentación #${l.id} falló:`, e?.message)
    setStatus('failed')
  }
}
