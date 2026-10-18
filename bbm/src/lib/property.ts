// ─── Tenants (propiedades) ─────────────────────────────────────────────────────
// Un "tenant" es una fila de `properties`. Toda petición/tarea corre dentro de
// un contexto (AsyncLocalStorage) que dice a qué tenant pertenece; el resto del
// código NUNCA escribe un id literal, siempre getPropertyId().
//
// Resolución del tenant (ver src/middleware/tenant.ts):
//   · rutas de staff:   propertyId del JWT
//   · rutas públicas:   dominio (properties.public_domain) → ?tenant=slug / cabecera X-Tenant
//                       → si solo existe un tenant activo, ese
//   · schedulers:       forEachActiveProperty() ejecuta cada pasada por tenant
// Fuera de un contexto getPropertyId() LANZA error: nunca devuelve un id por defecto.
import { AsyncLocalStorage } from 'node:async_hooks'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { properties, type Property } from '../db/schema'

const als = new AsyncLocalStorage<{ propertyId: number }>()

export function runWithProperty<T>(propertyId: number, fn: () => T): T {
  return als.run({ propertyId }, fn)
}

export function getPropertyId(): number {
  const ctx = als.getStore()
  if (!ctx) throw new Error('getPropertyId() fuera de un contexto de tenant (middleware o scheduler)')
  return ctx.propertyId
}

export function hasPropertyContext(): boolean {
  return !!als.getStore()
}

// ── Caché de propiedades (TTL corto + invalidación al editar) ────────────────
const TTL_MS = 60_000
const cache = new Map<number, { at: number; row: Property }>()

export function invalidateProperty(id?: number) {
  if (id == null) cache.clear(); else cache.delete(id)
}

export async function loadProperty(id: number): Promise<Property> {
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row
  const row = await db.query.properties.findFirst({ where: eq(properties.id, id) })
  if (!row) throw new Error(`Tenant ${id} no existe`)
  cache.set(id, { at: Date.now(), row })
  return row
}

export async function getProperty(): Promise<Property> {
  return loadProperty(getPropertyId())
}

// ── Branding: lo que el huésped ve (emails, contrato, factura, widgets) ──────
export interface Branding {
  id: number
  slug: string
  name: string
  legalName: string
  vatNumber: string
  touristRegistryNumber: string
  address: string
  postalCode: string
  city: string
  region: string
  countryCode: string
  phone: string
  email: string
  receptionEmail: string
  fromEmail: string
  websiteUrl: string
  publicDomain: string
  mapsUrl: string
  logoUrl: string
  starLabel: string
  localeDefault: string
  currencyCode: string
  timezone: string
  /** Prefijo de plantillas WhatsApp (`${slug}_checkin`…). */
  waPrefix: string
  /** Dirección de una línea para facturas/contratos. */
  fullAddress: string
}

export function brandingOf(p: Property): Branding {
  const s = (v: string | null | undefined) => v ?? ''
  const slug = s(p.slug) || `hotel${p.id}`
  const fullAddress = [s(p.address), [s(p.postalCode), s(p.city)].filter(Boolean).join(' '), s(p.region)]
    .filter(Boolean).join(', ')
  return {
    id: p.id, slug, name: p.name, legalName: s(p.legalName) || p.name,
    vatNumber: s(p.vatNumber), touristRegistryNumber: s(p.touristRegistryNumber),
    address: s(p.address), postalCode: s(p.postalCode), city: s(p.city), region: s(p.region),
    countryCode: s(p.countryCode) || 'ES', phone: s(p.phone), email: s(p.email),
    receptionEmail: s(p.receptionEmail) || s(p.email), fromEmail: s(p.fromEmail) || s(p.email),
    websiteUrl: s(p.websiteUrl), publicDomain: s(p.publicDomain), mapsUrl: s(p.mapsUrl),
    logoUrl: s(p.logoUrl), starLabel: s(p.starLabel), localeDefault: s(p.localeDefault) || 'es',
    currencyCode: p.currencyCode, timezone: p.timezone,
    waPrefix: slug, fullAddress,
  }
}

export async function getBranding(): Promise<Branding> {
  return brandingOf(await getProperty())
}

// ── Ajustes y módulos por tenant (properties.settings / properties.features) ──
// settings: clave → valor libre (JSON). Claves previstas: pricing.rootRateId,
//   bookingEngine.channelId, bookingEngine.stripeAccountId, fdm.*, jumbo.*,
//   whatsapp.templates, events.queries, ai.assistantName, secrets.* (ver abajo).
// features: módulo → boolean. Módulos: ttlock, zkteco, ses, whatsapp, stripe,
//   nobeds, fdm, jumbo, pool, competitors, events, pricingRules, ai, voice,
//   bookingEngine, portal, laundry, cashDrawer, liveMap.
export type FeatureKey =
  | 'ttlock' | 'zkteco' | 'ses' | 'whatsapp' | 'stripe' | 'nobeds' | 'fdm' | 'jumbo'
  | 'pool' | 'competitors' | 'events' | 'pricingRules' | 'ai' | 'voice'
  | 'bookingEngine' | 'portal' | 'laundry' | 'cashDrawer' | 'liveMap'

export const ALL_FEATURES: FeatureKey[] = [
  'bookingEngine', 'portal', 'stripe', 'ses', 'ttlock', 'zkteco', 'whatsapp', 'nobeds',
  'fdm', 'jumbo', 'pricingRules', 'competitors', 'events', 'pool', 'ai', 'voice', 'laundry', 'cashDrawer', 'liveMap',
]

/** Módulos que un tenant NUEVO tiene activados de serie. */
export const DEFAULT_ON: FeatureKey[] = ['bookingEngine', 'portal', 'ses', 'ai', 'laundry', 'cashDrawer', 'pricingRules']

export function featureOf(p: Property, key: FeatureKey): boolean {
  const f = (p.features ?? {}) as Record<string, boolean>
  return key in f ? !!f[key] : DEFAULT_ON.includes(key)
}

export async function hasFeature(key: FeatureKey): Promise<boolean> {
  return featureOf(await getProperty(), key)
}

export function settingOf<T = unknown>(p: Property, key: string, fallback?: T): T | undefined {
  const s = (p.settings ?? {}) as Record<string, unknown>
  return key in s ? (s[key] as T) : fallback
}

export async function getSetting<T = unknown>(key: string, fallback?: T): Promise<T | undefined> {
  return settingOf(await getProperty(), key, fallback)
}

// ── Secretos por tenant (credenciales de integraciones) ──────────────────────
// Se guardan en properties.settings bajo `secrets.<NOMBRE_ENV>`; si el tenant no
// los tiene, se cae al `.env` global SOLO si `ALLOW_ENV_SECRET_FALLBACK=1`
// (modo un-solo-hotel). Nunca se devuelven al frontend (ver routes/tenants.ts).
export async function getSecret(name: string): Promise<string | undefined> {
  const p = await getProperty()
  const v = settingOf<string>(p, `secrets.${name}`)
  if (v) return v
  return process.env.ALLOW_ENV_SECRET_FALLBACK === '1' ? process.env[name] : undefined
}

// ── Schedulers: una pasada por tenant activo, con aislamiento de errores ─────
export async function forEachActiveProperty(
  label: string,
  fn: (p: Property) => Promise<void>,
  opts?: { feature?: FeatureKey },
) {
  const rows = await db.select().from(properties).where(eq(properties.active, true))
  for (const p of rows) {
    if (opts?.feature && !featureOf(p, opts.feature)) continue
    try {
      await runWithProperty(p.id, () => fn(p))
    } catch (e) {
      console.error(`[${label}] tenant ${p.id} (${p.slug ?? p.name}):`, e)
    }
  }
}

// ── Resolución para rutas públicas ───────────────────────────────────────────
export async function resolvePublicProperty(opts: { host?: string; slug?: string }): Promise<number | null> {
  const active = await db.select().from(properties).where(eq(properties.active, true))
  const host = (opts.host ?? '').toLowerCase().split(':')[0]
  if (opts.slug) { const p = active.find(x => x.slug === opts.slug); if (p) return p.id }
  if (host) { const p = active.find(x => (x.publicDomain ?? '').toLowerCase() === host); if (p) return p.id }
  if (active.length === 1) return active[0]!.id
  return null
}
