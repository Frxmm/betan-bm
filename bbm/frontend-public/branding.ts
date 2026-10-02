// ─── Branding del tenant para las páginas públicas ────────────────────────────
// Todo el texto de marca sale de GET /api/public/property (tenant por dominio,
// ?tenant=slug o cabecera X-Tenant). Se carga ANTES de montar React (ver `boot`),
// así que `branding` es síncrono para el resto del código.

export interface PublicBranding {
  name: string
  location: string              // "Ciudad, Región" (opcional)
  websiteUrl: string            // web del hotel (enlace "volver al sitio")
  logoUrl: string
  currencyCode: string
  timezone: string
  phone: string
  email: string
  mapsUrl: string
  linkerDomains: string[]       // dominios para el linker de gtag
  analytics: { adsId: string; conversionLabel: string } | null
}

const EMPTY: PublicBranding = {
  name: '', location: '', websiteUrl: '', logoUrl: '', currencyCode: 'EUR', timezone: '',
  phone: '', email: '', mapsUrl: '', linkerDomains: [], analytics: null,
}

export let branding: PublicBranding = { ...EMPTY }

// ─── Tenant ───────────────────────────────────────────────────────────────────
// ?tenant=slug en la URL (también en el src del iframe del widget). Si no viene,
// el backend resuelve por dominio / único tenant.
export const tenantSlug: string | null = (() => {
  try { return new URLSearchParams(location.search).get('tenant') || null } catch { return null }
})()

/** Añade ?tenant= a una URL relativa propia (enlaces entre páginas públicas). */
export function withTenant(url: string): string {
  if (!tenantSlug) return url
  return url + (url.includes('?') ? '&' : '?') + 'tenant=' + encodeURIComponent(tenantSlug)
}

/** fetch público: propaga el tenant (cabecera X-Tenant) cuando existe. */
export function pfetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!tenantSlug) return fetch(input, init)
  const headers = new Headers(init.headers)
  if (!headers.has('X-Tenant')) headers.set('X-Tenant', tenantSlug)
  return fetch(input, { ...init, headers })
}

/** Sustituye {{hotel}} / {{location}} en un texto (plantillas i18n y <title>). */
export function brand(str: string): string {
  return str
    .replace(/\{\{\s*hotel\s*\}\}|\{hotel\}/g, branding.name)
    .replace(/\s*[·—-]\s*(\{\{\s*location\s*\}\}|\{location\})/g, branding.location ? ' · ' + branding.location : '')
    .replace(/\{\{\s*location\s*\}\}|\{location\}/g, branding.location)
}

export async function loadBranding(): Promise<PublicBranding> {
  try {
    const r = await pfetch('/api/public/property')
    const d = (await r.json())?.data ?? {}
    branding = {
      ...EMPTY,
      name: d.name ?? '',
      location: d.location ?? [d.city, d.region].filter(Boolean).join(', '),
      websiteUrl: d.websiteUrl ?? '',
      logoUrl: d.logoUrl ?? '',
      currencyCode: d.currencyCode ?? 'EUR',
      timezone: d.timezone ?? '',
      phone: d.phone ?? '',
      email: d.email ?? d.receptionEmail ?? '',
      mapsUrl: d.mapsUrl ?? '',
      linkerDomains: Array.isArray(d.linkerDomains) ? d.linkerDomains : [d.websiteUrl, d.publicDomain].filter(Boolean).map(hostOf).filter(Boolean) as string[],
      analytics: d.analytics?.adsId && d.analytics?.conversionLabel ? d.analytics : null,
    }
  } catch { /* sin branding: la página funciona con textos genéricos */ }
  try { document.title = brand(document.title) } catch { /* ignorar */ }
  return branding
}

function hostOf(u: string): string {
  try { return new URL(u.includes('://') ? u : 'https://' + u).hostname } catch { return '' }
}

/** Carga el branding y después monta la app. */
export async function boot(mount: () => void): Promise<void> {
  await loadBranding()
  mount()
}

/**
 * postMessage al padre (web del hotel que embebe el iframe). Emite el tipo nuevo
 * `bm-<kind>` y, ADEMÁS, el antiguo `betania-<kind>` como alias de compatibilidad:
 * el JS de webs ya desplegadas (WordPress del hotel original) escucha los `betania-*`.
 * Los mensajes entrantes (reset, lang) aceptan ambos prefijos.
 */
export function postParent(kind: string, payload: Record<string, unknown> = {}): void {
  window.parent.postMessage({ type: 'bm-' + kind, ...payload }, '*')
  window.parent.postMessage({ type: 'betania-' + kind, ...payload }, '*')
}
