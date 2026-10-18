// Actividad del personal registrada en la plataforma de mantenimiento
// (app de mantenimiento/piscina del tenant), leída SOLO con los
// endpoints de lectura que ya existen (ver poolControl.ts) — sin tocar esa app:
//   - /api/inventario?fecha=…   → items[].empleado_nombre (1 acción por
//                                 inventario = fecha + empleado)
//   - /api/incidencias/pendientes → usuario, fecha (quien abre la incidencia)
//   - /api/incidencias/resueltas  → resuelta_por, fecha_resolucion
//   - /api/higiene?desde&hasta          → registros de higiene (neveras,
//                                         congeladores, superficies…), con empleado_nombre
//   - /api/tareas-completadas?desde&hasta → tareas programadas completadas
// (estos dos se añadieron a la app de mantenimiento, también de solo lectura).
// Los registros de piscina/AFC/ACS no guardan autor, así que esos NO se computan. Los nombres (empleado_nombre) no son IDs de esta app: se
// emparejan con los usuarios por nombre normalizado (ver matchUserByName).
import * as poolControl from './poolControl'
import { getPropertyId, getBranding } from './property'

export type ExternalEvent = { name: string; kind: 'inventario' | 'incidencias' | 'higiene' | 'tareas'; day: string }

const CACHE_MS = 10 * 60_000

// Acepta YYYY-MM-DD[...] o DD/MM/YYYY[...] → YYYY-MM-DD, o null.
export function normDay(v: unknown): string | null {
  const s = String(v ?? '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/)
  if (m) return `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`
  return null
}

export const normName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()

// Empareja un nombre externo con un usuario, probando tres niveles cada vez
// más permisivos — en cuanto uno da UN único candidato, se usa ese; si da
// varios (ambiguo) o ninguno, no se adivina y se pasa al siguiente nivel (o
// se devuelve null si ya era el último):
//   1. Nombre completo exacto (normalizado: sin acentos, mayúsculas, símbolos).
//   2. Uno empieza por el otro + espacio (cubre un segundo nombre/apellido
//      de más al final, p.ej. "Juan Pérez" ↔ "Juan Pérez García").
//   3. Mismo conjunto de palabras con como mucho 1 de diferencia, sin
//      importar el orden (cubre apellidos en otro orden, o un nombre/
//      apellido de más o de menos en cualquier posición, no solo al final).
export function matchUserByName(ext: string, people: { id: number; name: string }[]): number | null {
  const n = normName(ext)
  if (!n) return null

  const exact = people.filter(p => normName(p.name) === n)
  if (exact.length === 1) return exact[0]!.id
  if (exact.length > 1) return null

  const loose = people.filter(p => {
    const pn = normName(p.name)
    return pn.startsWith(n + ' ') || n.startsWith(pn + ' ')
  })
  if (loose.length === 1) return loose[0]!.id
  if (loose.length > 1) return null

  const extWords = new Set(n.split(' ').filter(Boolean))
  const wordsMatch = people.filter(p => {
    const pWords = new Set(normName(p.name).split(' ').filter(Boolean))
    let diff = 0
    for (const w of extWords) if (!pWords.has(w)) diff++
    for (const w of pWords) if (!extWords.has(w)) diff++
    return diff <= 1
  })
  return wordsMatch.length === 1 ? wordsMatch[0]!.id : null
}

async function fetchAll(from: string, to: string): Promise<ExternalEvent[]> {
  const out: ExternalEvent[] = []
  const inRange = (d: string | null): d is string => !!d && d >= from && d <= to

  // Inventarios: una llamada por fecha disponible dentro del rango.
  const first: any = await poolControl.getBreakfastInventory()
  const dates: string[] = ((first?.fechas_disponibles ?? []) as string[]).map(d => normDay(d)).filter(inRange)
  const perDate = await Promise.all([...new Set(dates)].map(async d => {
    try { return { d, res: d === normDay(first?.fecha) ? first : await poolControl.getBreakfastInventory(d) } }
    catch { return null }
  }))
  for (const r of perDate) {
    if (!r) continue
    const who = new Set<string>()
    for (const it of (r.res?.items ?? [])) if (it?.empleado_nombre) who.add(String(it.empleado_nombre))
    for (const name of who) out.push({ name, kind: 'inventario', day: r.d })
  }

  // Incidencias: abrir (usuario, fecha) y resolver (resuelta_por, fecha_resolucion).
  const [pending, resolved]: any[] = await Promise.all([poolControl.getPendingIncidents(), poolControl.getResolvedIncidents()])
  for (const it of [...(pending?.items ?? []), ...(resolved?.items ?? [])]) {
    const d = normDay(it.fecha)
    if (it.usuario && inRange(d)) out.push({ name: String(it.usuario), kind: 'incidencias', day: d })
  }
  for (const it of (resolved?.items ?? [])) {
    const d = normDay(it.fecha_resolucion)
    if (it.resuelta_por && inRange(d)) out.push({ name: String(it.resuelta_por), kind: 'incidencias', day: d })
  }

  // Higiene y tareas completadas: filtran por fecha en el propio endpoint.
  // Si esta app aún no tiene desplegados esos endpoints, se ignoran sin romper lo demás.
  try {
    const h: any = await poolControl.getHygieneRecords(from, to)
    for (const it of (h?.items ?? [])) { const d = normDay(it.fecha); if (it.empleado_nombre && inRange(d)) out.push({ name: String(it.empleado_nombre), kind: 'higiene', day: d }) }
  } catch (e) { console.error('[externalStaffActivity] higiene no disponible:', (e as Error).message) }
  try {
    const t: any = await poolControl.getCompletedTasks(from, to)
    for (const it of (t?.items ?? [])) { const d = normDay(it.fecha_completada) ?? normDay(it.fecha); if (it.empleado_nombre && inRange(d)) out.push({ name: String(it.empleado_nombre), kind: 'tareas', day: d }) }
  } catch (e) { console.error('[externalStaffActivity] tareas no disponibles:', (e as Error).message) }
  return out
}

// Eventos externos en [from,to]. Nunca lanza: si la API no está configurada o
// falla, devuelve [] (el rating sigue calculándose solo con lo de esta app).
// Se cachea (10 min) UNA descarga de los últimos 120 días, compartida por todas
// las ventanas que pide el rating (evita descargas repetidas y carreras entre
// peticiones simultáneas); rangos más antiguos van directos.
const WIDE_DAYS = 120
const wideCache = new Map<number, { at: number; from: string; to: string; p: Promise<ExternalEvent[]> }>()

const localDay = (tz: string, offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
}

export async function getExternalStaffActivity(from: string, to: string): Promise<ExternalEvent[]> {
  if (!await poolControl.isConfigured()) return []
  try {
    const pid = getPropertyId()
    const tz = (await getBranding()).timezone
    const wideFrom = localDay(tz, -WIDE_DAYS), wideTo = localDay(tz, 1)
    if (from < wideFrom || to > wideTo) return await fetchAll(from, to)
    let wc = wideCache.get(pid)
    if (!wc || Date.now() - wc.at > CACHE_MS || wc.to !== wideTo) {
      const p = fetchAll(wideFrom, wideTo)
      wc = { at: Date.now(), from: wideFrom, to: wideTo, p }
      wideCache.set(pid, wc)
      p.catch(() => { wideCache.delete(pid) })
    }
    return (await wc.p).filter(e => e.day >= from && e.day <= to)
  } catch (e) {
    console.error('[externalStaffActivity] no disponible:', (e as Error).message)
    return []
  }
}
