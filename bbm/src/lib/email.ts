import { Resend } from 'resend'
import { renderEmail } from './messaging'
import { getBranding, type Branding } from './property'

// Resend es de plataforma (clave en env); el remitente es el del tenant
const resend = new Resend(process.env.RESEND_API_KEY)

// Remitente del tenant: "Nombre <fromEmail>" (branding.fromEmail)
export function fromOf(b: Branding): string {
  if (!b.fromEmail) throw new Error('El tenant no tiene email remitente (fromEmail) configurado')
  return `${b.name} <${b.fromEmail}>`
}

async function from(): Promise<string> { return fromOf(await getBranding()) }

export async function sendBookingConfirmationEmail(opts: {
  to:        string
  name:      string
  checkIn:   string
  checkOut:  string
  room:      string
  total:     string
  balance:   string
  resId:     number
  portalUrl: string
}) {
  const { to, ...vars } = opts
  const { subject, html } = await renderEmail('booking_confirmation', vars)
  await resend.emails.send({ from: await from(), to, subject, html })
}

export async function sendCheckinLinkEmail(opts: {
  to:        string
  name:      string
  checkIn:   string
  checkOut:  string
  resId:     number
  portalUrl: string
}) {
  const { to, ...vars } = opts
  const { subject, html } = await renderEmail('checkin_link', vars)
  await resend.emails.send({ from: await from(), to, subject, html })
}

export async function sendPaymentReminderEmail(opts: {
  to:        string
  name:      string
  due:       string
  resId:     number
  portalUrl: string
}) {
  const { to, ...vars } = opts
  const { subject, html } = await renderEmail('payment_reminder', vars)
  await resend.emails.send({ from: await from(), to, subject, html })
}

export async function sendThankYouEmail(opts: {
  to:   string
  name: string
}) {
  const { to, ...vars } = opts
  const { subject, html } = await renderEmail('guest_thank_you', vars)
  await resend.emails.send({ from: await from(), to, subject, html })
}

// Resumen diario automático (cron a las 23:00, ver scripts/daily-summary-cron.ts
// y POST /api/ai/daily-summary). El cuerpo lo redacta el agente de IA en HTML —
// aquí solo se envuelve con la cabecera/pie estándar y se manda.
export async function sendDailySummaryEmail(opts: {
  to:       string[]
  date:     string
  bodyHtml: string
  // Imagen opcional incrustada (gráfico de ocupación del mes) — referenciada
  // en bodyHtml como <img src="cid:occupancy-chart">, mismo contentId que
  // el del adjunto. Resend la manda inline, no como attachment descargable.
  chartPng?: Buffer
}) {
  const b = await getBranding()
  const html = `<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">${b.name}</h2>
  <p style="color:#555;margin-top:0">Resumen del día — ${opts.date}</p>
  <hr style="border:none;border-top:1px solid #eee">
  ${opts.bodyHtml}
  <p style="font-size:11px;color:#aaa;margin-top:32px">Generado automáticamente por el agente de IA · ${b.name}</p>
</div>`
  await resend.emails.send({
    from: fromOf(b), to: opts.to, subject: `📊 Resumen del día — ${b.name} (${opts.date})`, html,
    ...(opts.chartPng ? { attachments: [{ content: opts.chartPng, filename: 'ocupacion.png', contentType: 'image/png', contentId: 'occupancy-chart' }] } : {}),
  })
}

// Recuperación de contraseña de personal (autoservicio desde Login, o
// disparado por dirección desde Usuarios) — ver POST /api/auth/forgot-password
// y POST /api/users/:id/send-password-reset. HTML propio en vez de
// renderEmail: no es un mensaje de huésped con toggles por canal/tarifa,
// es una acción de cuenta interna, igual que sendDailySummaryEmail.
export async function sendPasswordResetEmail(opts: {
  to:       string
  name:     string
  resetUrl: string
}) {
  const b = await getBranding()
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;color:#111">
  <h2 style="margin-bottom:4px">${b.name}</h2>
  <p style="color:#555;margin-top:0">Recuperación de contraseña</p>
  <hr style="border:none;border-top:1px solid #eee">
  <p>Hola ${opts.name},</p>
  <p>Se ha solicitado restablecer tu contraseña de acceso al panel. Pulsa el siguiente botón para elegir una nueva:</p>
  <p style="margin:24px 0"><a href="${opts.resetUrl}" style="background:#1d4ed8;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600">Restablecer contraseña</a></p>
  <p style="font-size:13px;color:#555">El enlace caduca en 1 hora. Si no has pedido esto, puedes ignorar el correo — tu contraseña actual sigue siendo válida.</p>
  <p style="font-size:11px;color:#aaa;margin-top:32px">${b.name}</p>
</div>`
  await resend.emails.send({ from: fromOf(b), to: opts.to, subject: `Recuperación de contraseña — ${b.name}`, html })
}

export async function sendLockCode(opts: {
  to:         string
  guestName:  string
  roomCode:   string
  code:       string
  checkIn:    string
  checkOut:   string
}) {
  const { to, ...vars } = opts
  const { subject, html } = await renderEmail('lock_code', vars)
  await resend.emails.send({ from: await from(), to, subject, html })
}
