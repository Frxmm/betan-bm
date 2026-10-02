// ─── Stripe por tenant ─────────────────────────────────────────────────────────
// Cada hotel usa SU cuenta de Stripe: claves en properties.settings
// (secrets.STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET / STRIPE_PUBLIC_KEY, ver
// getSecret en lib/property.ts). Los clientes se cachean por propertyId y se
// recrean si la clave cambia. Todo exige contexto de tenant (getPropertyId).
import Stripe from 'stripe'
import { and, eq } from 'drizzle-orm'
import { db } from '../db'
import { financialAccounts, currencies, bookingChannels, properties } from '../db/schema'
import { getPropertyId, getProperty, getSecret, getSetting, getBranding, invalidateProperty, type Branding } from './property'
import { env } from './env'

const clients = new Map<number, { key: string; client: Stripe }>()

async function stripeDisabled(): Promise<boolean> {
  const p = await getProperty()
  return (p.features as Record<string, boolean> | null)?.stripe === false
}

/** Cliente de Stripe del tenant actual, o null si no tiene clave (o el módulo está apagado). */
export async function getStripe(): Promise<Stripe | null> {
  if (await stripeDisabled()) return null
  const key = await getSecret('STRIPE_SECRET_KEY')
  if (!key) return null
  const pid = getPropertyId()
  const hit = clients.get(pid)
  if (hit && hit.key === key) return hit.client
  const client = new Stripe(key, { apiVersion: '2025-05-28.basil' })
  clients.set(pid, { key, client })
  return client
}

export async function requireStripe(): Promise<Stripe> {
  const s = await getStripe()
  if (!s) throw new Error('Stripe no configurado para este hotel — añade STRIPE_SECRET_KEY en los ajustes de integraciones')
  return s
}

export async function getStripeWebhookSecret(): Promise<string | undefined> {
  return getSecret('STRIPE_WEBHOOK_SECRET')
}

/** Clave pública (publishable) del tenant — es pública por diseño, nunca la secreta. */
export async function getStripePublicKey(): Promise<string | null> {
  if (await stripeDisabled()) return null
  return (await getSecret('STRIPE_PUBLIC_KEY')) ?? null
}

/** Cuenta financiera donde se registran los cobros de Stripe (por id en settings, nunca por nombre). */
export async function getStripeAccountId(): Promise<number | null> {
  const id = await getSetting<number>('bookingEngine.stripeAccountId')
  if (id) return Number(id)
  // Sin ajuste: una cuenta activa cuyos métodos permitidos incluyan 'stripe'
  const accounts = await db.select().from(financialAccounts)
    .where(and(eq(financialAccounts.propertyId, getPropertyId()), eq(financialAccounts.active, true)))
  const match = accounts.find(a => ((a.allowedMethods as string[] | null) ?? []).includes('stripe'))
  return match?.id ?? null
}

/** Canal de venta del motor de reservas (setting bookingEngine.channelId). Si falta, crea uno y lo deja guardado. */
export async function getBookingChannelId(): Promise<number> {
  const id = await getSetting<number>('bookingEngine.channelId')
  if (id) {
    const ok = await db.query.bookingChannels.findFirst({
      where: and(eq(bookingChannels.id, Number(id)), eq(bookingChannels.propertyId, getPropertyId())),
      columns: { id: true },
    })
    if (ok) return ok.id
  }
  const b = await getBranding()
  const [ch] = await db.insert(bookingChannels).values({
    propertyId: getPropertyId(), name: `Web ${b.name}`, isDefault: false, active: true,
  }).returning({ id: bookingChannels.id })
  const p = await getProperty()
  await db.update(properties)
    .set({ settings: { ...((p.settings ?? {}) as Record<string, unknown>), 'bookingEngine.channelId': ch!.id } })
    .where(eq(properties.id, getPropertyId()))
  invalidateProperty(getPropertyId())
  return ch!.id
}

/** Id de la moneda del tenant (properties.currencyCode → currencies.id). */
export async function getCurrencyId(): Promise<number> {
  const { currencyCode } = await getBranding()
  const row = await db.query.currencies.findFirst({ where: eq(currencies.code, currencyCode) })
  if (!row) throw new Error(`Moneda ${currencyCode} no existe en la tabla currencies`)
  return row.id
}

/** Código ISO de moneda en minúsculas para Stripe. */
export async function getStripeCurrency(): Promise<string> {
  return (await getBranding()).currencyCode.toLowerCase()
}

/** URL base pública del tenant (su dominio si lo tiene; si no, PUBLIC_URL). */
export function publicBase(b: Branding): string {
  if (!b.publicDomain) return env.PUBLIC_URL
  return /^(localhost|127\.)/.test(b.publicDomain) ? `http://${b.publicDomain}` : `https://${b.publicDomain}`
}

/** Enlace público del tenant; añade ?tenant=slug solo si no tiene dominio propio (para resolver el tenant). */
export function publicUrl(b: Branding, path: string): string {
  const base = publicBase(b)
  if (b.publicDomain) return `${base}${path}`
  return `${base}${path}${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(b.slug)}`
}
