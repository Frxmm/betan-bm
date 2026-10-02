import { branding, loadBranding } from './branding'

// ─── Conversión de Google Ads (reserva pagada) ─────────────────────────────────
// Se dispara SOLO cuando /booking/confirm devuelve la reserva pagada.
// Deduplicación doble: transaction_id (lado Google) + localStorage (recargas).

declare global {
  interface Window { dataLayer: any[]; gtag: (...args: any[]) => void }
}

let loaded: Promise<{ id: string; label: string } | null> | null = null

async function ensureGtag(): Promise<{ id: string; label: string } | null> {
  if (loaded) return loaded
  loaded = (async () => {
    try {
      // El id de Ads y la etiqueta vienen del branding del tenant (/api/public/property)
      const b = branding.analytics ? branding : await loadBranding()
      const id    = b.analytics?.adsId
      const label = b.analytics?.conversionLabel
      if (!id || !label) return null

      window.dataLayer = window.dataLayer || []
      window.gtag = function gtag() { window.dataLayer.push(arguments) }
      window.gtag('js', new Date())
      // linker: mantiene la atribución entre la web principal y el dominio del motor
      window.gtag('config', id, { linker: { domains: branding.linkerDomains } })

      const s = document.createElement('script')
      s.async = true
      s.src = `https://www.googletagmanager.com/gtag/js?id=${id}`
      document.head.appendChild(s)

      return { id, label }
    } catch { return null }
  })()
  return loaded
}

export async function fireBookingConversion(reservation: {
  id: number
  total?: string | null
  amountPaid?: string | null
  status?: string
  guest?: { email?: string | null } | null
}) {
  try {
    // Solo reservas realmente pagadas
    const paid = parseFloat(String(reservation.amountPaid ?? '0'))
    if (!(paid > 0)) return

    // Anti-doble disparo en recargas de la página de éxito
    const guardKey = `bm-conv-${reservation.id}`
    if (localStorage.getItem(guardKey)) return

    const cfg = await ensureGtag()
    if (!cfg) return

    // Enhanced conversions: mejora la atribución con el email (Google lo hashea)
    if (reservation.guest?.email) {
      window.gtag('set', 'user_data', { email: reservation.guest.email })
    }

    window.gtag('event', 'conversion', {
      send_to:        `${cfg.id}/${cfg.label}`,
      value:          paid,
      currency:       branding.currencyCode || 'EUR',
      transaction_id: String(reservation.id),
    })
    localStorage.setItem(guardKey, '1')
  } catch {}
}
