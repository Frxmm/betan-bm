// ─── Precios de hoteles competidores ────────────────────────────────────────
// Lee el precio público directamente de la API que el propio motor de
// reservas de cada competidor expone (la que usa su web para pintar el
// calendario de precios) — nunca de Booking.com u otra OTA: además de ser
// mucho más frágil de mantener (HTML cambia sin aviso), scrapear Booking.com
// incumple sus términos de uso. Cada motor soportado tiene su propio parser
// aquí; añadir un competidor con un motor nuevo requiere añadir su función.
import { db } from '../db'
import { competitorHotels, competitorPrices } from '../db/schema'
import { eq, and, sql } from 'drizzle-orm'
import { getPropertyId, forEachActiveProperty } from './property'

export type DailyPrice = { date: string; price: number | null }

// El precio que se lee de la web del competidor es su tarifa pública "de
// mostrador" — pero un cliente cualquiera puede sacar bastante menos en
// Booking.com (Genius + rebaja adicional, variable según el hotel). Para
// comparar contra un precio que de verdad compite, se guarda ya dividido por
// este factor (competitorHotels.bookingEffectiveDivisor, configurable por
// competidor — 1.38 por defecto ≈ Genius + 10%). 1 = sin ajuste.
const DEFAULT_BOOKING_EFFECTIVE_DIVISOR = 1.38

function toEffectivePrice(raw: number, divisor: number): number {
  return Math.round((raw / divisor) * 100) / 100
}

// ── Paraty (motor "online-secure-booking.appspot.com", muy usado por
// hoteles pequeños/medianos en España) — según el hotel, el endpoint puede
// estar en ese dominio genérico de Paraty (namespace-dot-online-secure-
// booking.appspot.com) o servido directamente desde el dominio propio del
// hotel (proxy inverso) — por eso apiBaseUrl es explícito, no se adivina.
async function fetchParatyMonth(namespace: string, websiteUrl: string, apiBaseUrl: string, year: number, month: number, divisor: number): Promise<DailyPrice[]> {
  const sid = crypto.randomUUID()
  const pad = (n: number) => String(n).padStart(2, '0')
  const lastDay = new Date(year, month, 0).getDate()
  const site = websiteUrl.replace(/\/$/, '')
  const url = `${apiBaseUrl.replace(/\/$/, '')}/calendar-handler-endpoint`
    + `?action=retreive_month_prices&month=${month}&year=${year}&language=es&namespace=${namespace}`
    + `&numRooms=1&adultsRoom1=2&childrenRoom1=0&babiesRoom1=0`
    + `&startDate=01/${pad(month)}/${year}&endDate=${pad(lastDay)}/${pad(month)}/${year}`
    + `&country=es&roomFilter=.*&promocode=&sid=${sid}`
  const res = await fetch(url, {
    headers: {
      accept: '*/*',
      origin: site,
      referer: `${site}/`,
      'user-agent': 'Mozilla/5.0 (compatible; PMSPriceCheck/1.0)',
    },
  })
  if (!res.ok) throw new Error(`Paraty ${namespace}: HTTP ${res.status}`)
  const data = await res.json() as any
  const days: any[] = data?.first_month_prices?.all ?? []
  // El precio agregado del calendario de Paraty ya es el de la habitación de
  // baño privado en estos hoteles (no tienen alternativa de baño compartido
  // en su motor) — no hace falta filtrar por tipo de habitación aquí.
  return days.map(d => ({
    date: `${year}-${pad(month)}-${pad(d.day)}`,
    // 0 se trata como "sin disponibilidad", no como precio real.
    price: typeof d.price === 'number' && d.price > 0 ? toEffectivePrice(d.price, divisor) : null,
  }))
}

// ── Cloudbeds (API propia expuesta por la web del hotel, no la de Cloudbeds
// directamente) — una llamada por noche, más barata habitación DE BAÑO
// PRIVADO disponible (roomId/roomName incluyen "privado"/"compartido" según
// el tipo de baño en estos hoteles) ──
function isPrivateBathroom(r: any): boolean {
  const id   = String(r.roomId   ?? '').toLowerCase()
  const name = String(r.roomName ?? '').toLowerCase()
  const tag  = `${id} ${name}`
  return tag.includes('privado') && !tag.includes('compartido')
}
async function fetchCloudbedsDay(baseUrl: string, date: string, divisor: number): Promise<number | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api/cloudbeds/rates?checkin=${date}&checkout=&guests=2&promo=`
  const res = await fetch(url, {
    headers: {
      accept: '*/*',
      referer: `${baseUrl.replace(/\/$/, '')}/`,
      'user-agent': 'Mozilla/5.0 (compatible; PMSPriceCheck/1.0)',
    },
  })
  if (!res.ok) throw new Error(`Cloudbeds ${baseUrl}: HTTP ${res.status}`)
  const data = await res.json() as any
  const rates = Object.values(data?.rates ?? {}) as any[]
  const available = rates.filter(r =>
    r.available && typeof r.pricePerNight === 'number' && r.pricePerNight > 0 && isPrivateBathroom(r))
  if (!available.length) return null
  return toEffectivePrice(Math.min(...available.map(r => r.pricePerNight)), divisor)
}

async function fetchCloudbedsRange(baseUrl: string, dates: string[], divisor: number): Promise<DailyPrice[]> {
  const out: DailyPrice[] = []
  for (const date of dates) {
    try {
      out.push({ date, price: await fetchCloudbedsDay(baseUrl, date, divisor) })
    } catch (e) {
      console.error(`[competitorPricing] Cloudbeds ${baseUrl} ${date}:`, e)
    }
    // Una petición por noche — pequeña pausa para no machacar su servidor.
    await new Promise(r => setTimeout(r, 300))
  }
  return out
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

// Trae los precios de un competidor para los próximos `daysAhead` días.
// Por defecto 365 — el máximo periodo seleccionable en la comparativa (ver
// CompetitorsPanel) — para que la gráfica siempre tenga datos sea cual sea
// el rango elegido, sin depender de cuándo se cambió el selector.
export async function fetchCompetitorPrices(
  hotel: { platform: string; config: any; bookingEffectiveDivisor?: string | number | null },
  daysAhead = 365,
): Promise<DailyPrice[]> {
  const divisor = Number(hotel.bookingEffectiveDivisor) || DEFAULT_BOOKING_EFFECTIVE_DIVISOR
  const today = new Date()
  if (hotel.platform === 'paraty') {
    const namespace  = hotel.config?.namespace
    const websiteUrl = hotel.config?.websiteUrl
    // Por defecto el dominio genérico de Paraty — algunos hoteles lo sirven
    // en cambio desde su propio dominio (proxy inverso), configurable aparte.
    const apiBaseUrl = hotel.config?.apiBaseUrl || `https://${namespace}-dot-online-secure-booking.appspot.com`
    if (!namespace || !websiteUrl) throw new Error('Falta namespace o websiteUrl en la configuración de Paraty')
    // Puede abarcar 1-2 meses según daysAhead — se piden todos los meses que toquen.
    const months = new Set<string>()
    for (let i = 0; i <= daysAhead; i++) {
      const d = new Date(today); d.setDate(d.getDate() + i)
      months.add(`${d.getFullYear()}-${d.getMonth() + 1}`)
    }
    const results: DailyPrice[] = []
    for (const key of months) {
      const [y, m] = key.split('-').map(Number)
      results.push(...await fetchParatyMonth(namespace, websiteUrl, apiBaseUrl, y!, m!, divisor))
    }
    const cutoff = isoDate(new Date(today.getTime() + daysAhead * 86400000))
    const todayIso = isoDate(today)
    return results.filter(r => r.date >= todayIso && r.date <= cutoff)
  }
  if (hotel.platform === 'cloudbeds') {
    const baseUrl = hotel.config?.baseUrl
    if (!baseUrl) throw new Error('Falta baseUrl en la configuración de Cloudbeds')
    const dates = Array.from({ length: daysAhead + 1 }, (_, i) => {
      const d = new Date(today); d.setDate(d.getDate() + i)
      return isoDate(d)
    })
    return fetchCloudbedsRange(baseUrl, dates, divisor)
  }
  throw new Error(`Plataforma de competidor no soportada: ${hotel.platform}`)
}

// Refresca un competidor y guarda sus precios (upsert por fecha).
export async function refreshCompetitor(hotelId: number): Promise<{ ok: boolean; error?: string; days?: number }> {
  const hotel = await db.query.competitorHotels.findFirst({
    where: and(eq(competitorHotels.id, hotelId), eq(competitorHotels.propertyId, getPropertyId())),
  })
  if (!hotel) return { ok: false, error: 'Competidor no encontrado' }
  try {
    const prices = await fetchCompetitorPrices(hotel)
    for (const p of prices) {
      await db.insert(competitorPrices)
        .values({ competitorId: hotelId, date: p.date, price: p.price != null ? p.price.toFixed(2) : null })
        .onConflictDoUpdate({
          target: [competitorPrices.competitorId, competitorPrices.date],
          set: { price: p.price != null ? p.price.toFixed(2) : null, fetchedAt: new Date() },
        })
    }
    await db.update(competitorHotels)
      .set({ lastFetchedAt: new Date(), lastError: null })
      .where(and(eq(competitorHotels.id, hotelId), eq(competitorHotels.propertyId, getPropertyId())))
    return { ok: true, days: prices.length }
  } catch (e: any) {
    await db.update(competitorHotels)
      .set({ lastFetchedAt: new Date(), lastError: e.message ?? String(e) })
      .where(and(eq(competitorHotels.id, hotelId), eq(competitorHotels.propertyId, getPropertyId())))
    return { ok: false, error: e.message ?? String(e) }
  }
}

// Refresca los competidores del tenant en curso (requiere contexto de property).
export async function refreshAllCompetitors(): Promise<void> {
  const hotels = await db.select({ id: competitorHotels.id, name: competitorHotels.name })
    .from(competitorHotels).where(and(eq(competitorHotels.propertyId, getPropertyId()), eq(competitorHotels.active, true)))
  for (const h of hotels) {
    const result = await refreshCompetitor(h.id)
    if (!result.ok) console.error(`[competitorPricing] fallo actualizando "${h.name}":`, result.error)
  }
}

// Lanza el scheduler: ejecuta ahora y luego cada día a las 06:00 (hora del
// servidor — poco tráfico, y da tiempo a que dirección lo vea al llegar).
export function startCompetitorPricingScheduler() {
  // Una pasada por tenant con el módulo 'competitors' activo.
  const refreshAllTenants = () => forEachActiveProperty('competitorPricing', refreshAllCompetitors, { feature: 'competitors' })
  refreshAllTenants().catch(e => console.error('[competitorPricing] error en arranque:', e))

  const msToNext6am = () => {
    const now  = new Date()
    const next = new Date(now)
    next.setHours(6, 0, 10, 0)
    if (next <= now) next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
  }

  const schedule = () => {
    setTimeout(() => {
      refreshAllTenants().catch(e => console.error('[competitorPricing] error en scheduler:', e))
      setInterval(() => {
        refreshAllTenants().catch(e => console.error('[competitorPricing] error en scheduler:', e))
      }, 24 * 60 * 60 * 1000)
    }, msToNext6am())
  }

  schedule()
  console.log('[competitorPricing] scheduler iniciado — próxima ejecución a las 06:00')
}
