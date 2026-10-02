// Recuperación de contraseña de personal — generar el token, guardarlo y
// mandar el correo, compartido entre el autoservicio (POST /api/auth/forgot-password)
// y el botón de dirección en Usuarios (POST /api/users/:id/send-password-reset).
// El cooldown es EN MEMORIA (se reinicia si el proceso se reinicia) y por
// email — compartido entre ambos puntos de entrada, así que pedirlo tú mismo
// y que dirección te lo mande a la vez (o al revés) también respeta el límite.
import { db } from '../db'
import { passwordResetTokens } from '../db/schema'
import { env } from './env'
import { sendPasswordResetEmail } from './email'

const COOLDOWN_MS = 15 * 60_000
const RESET_LINK_TTL_MS = 60 * 60_000 // 1h de validez del enlace una vez enviado

const lastSentAt = new Map<string, number>()

function normalize(email: string): string {
  return email.toLowerCase().trim()
}

export function isResetOnCooldown(email: string): boolean {
  const last = lastSentAt.get(normalize(email))
  return !!last && Date.now() - last < COOLDOWN_MS
}

// No comprueba el cooldown (lo hace el llamador, para poder responder según
// el caso) — sí lo marca al enviar con éxito, antes de que el correo
// termine de salir (si el envío falla, igualmente se cuenta como usado el
// cupo de 15 min — evita reintentos en bucle si Resend está caído).
export async function sendPasswordResetLink(user: { id: number; email: string; firstName: string }) {
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')
  const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS)
  await db.insert(passwordResetTokens).values({ userId: user.id, token, expiresAt })
  lastSentAt.set(normalize(user.email), Date.now())
  await sendPasswordResetEmail({
    to:       user.email,
    name:     user.firstName,
    resetUrl: `${env.PUBLIC_URL}/reset-password?token=${token}`,
  })
}
