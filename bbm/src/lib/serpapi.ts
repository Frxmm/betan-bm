// Cliente SerpAPI para búsqueda de eventos locales.
// Cachea el resultado por día y tenant (clave = property + fecha local) para no
// consumir cuota en cada llamada del agente. Las consultas salen del setting
// events.queries o, si falta, de la ciudad del hotel (properties.city).
import { getPropertyId, getProperty, getSetting, getSecret } from './property'

export interface LocalEvent {
  title:    string
  date:     string       // texto original de SerpAPI, p.ej. "Sábado, 9 de agosto · 21:00"
  venue:    string
  address?: string
  link?:    string
  // Inferido en nuestro lado
  impactLevel: 'high' | 'medium' | 'low'
}

// Keywords que elevan el nivel de impacto
const HIGH_KEYWORDS  = ['festival', 'concierto', 'feria', 'maratón', 'media maratón', 'triatlón', 'copa del rey', 'final', 'liga', 'copa', 'circo solar', 'cirque']
const MEDIUM_KEYWORDS = ['exposición', 'mercadillo', 'mercado', 'teatro', 'obra', 'espectáculo', 'competición', 'torneo', 'carrera', 'congreso', 'foro']

function classifyImpact(title: string): LocalEvent['impactLevel'] {
  const t = title.toLowerCase()
  if (HIGH_KEYWORDS.some(k  => t.includes(k))) return 'high'
  if (MEDIUM_KEYWORDS.some(k => t.includes(k))) return 'medium'
  return 'low'
}

// Caché día → eventos
const cache = new Map<string, { fetchedAt: number; events: LocalEvent[] }>()

function localToday(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date())
}

export async function fetchLocalEvents(queries?: string[]): Promise<LocalEvent[]> {
  const prop = await getProperty()
  const key = `${getPropertyId()}:${localToday(prop.timezone)}`
  const hit = cache.get(key)
  // Si tenemos datos de hoy de hace menos de 6 horas, devolvemos caché
  if (hit && Date.now() - hit.fetchedAt < 6 * 3600_000) return hit.events

  // Clave de plataforma (env) o, si el tenant trae la suya, secrets.SERPAPI_API_KEY.
  const apiKey = (await getSecret('SERPAPI_API_KEY')) ?? process.env.SERPAPI_API_KEY
  if (!apiKey) {
    console.warn('[serpapi] SERPAPI_API_KEY no configurada')
    return []
  }

  const configured = await getSetting<string[]>('events.queries')
  const city = prop.city?.trim()
  const searchQueries = queries
    ?? (Array.isArray(configured) && configured.length ? configured : null)
    ?? (city ? [`eventos ${city}`, `conciertos ${city}`, `festivales ${city}`] : [])
  if (searchQueries.length === 0) {
    console.warn('[serpapi] sin events.queries ni properties.city — no hay nada que buscar')
    return []
  }

  const allEvents: LocalEvent[] = []
  const seen = new Set<string>()

  for (const q of searchQueries) {
    try {
      const url = new URL('https://serpapi.com/search.json')
      url.searchParams.set('engine',   'google_events')
      url.searchParams.set('q',        q)
      url.searchParams.set('hl',       'es')
      url.searchParams.set('gl',       'es')
      url.searchParams.set('api_key',  apiKey)

      const res  = await fetch(url.toString())
      if (!res.ok) { console.error('[serpapi] HTTP', res.status, q); continue }
      const data = await res.json() as any

      const items: any[] = data.events_results ?? []
      for (const item of items) {
        const title = String(item.title ?? '').trim()
        if (!title || seen.has(title.toLowerCase())) continue
        seen.add(title.toLowerCase())

        allEvents.push({
          title,
          date:    String(item.date?.when ?? item.date ?? ''),
          venue:   String(item.venue?.name ?? item.venue ?? ''),
          address: item.address ? String(item.address) : undefined,
          link:    item.link ?? undefined,
          impactLevel: classifyImpact(title),
        })
      }
    } catch (e: any) {
      console.error('[serpapi] error en query:', q, e.message)
    }
  }

  cache.set(key, { fetchedAt: Date.now(), events: allEvents })
  return allEvents
}

export function isConfigured(): boolean {
  return !!process.env.SERPAPI_API_KEY
}
