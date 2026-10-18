// Utilidades de fecha/hora en la zona horaria del establecimiento (properties.timezone),
// independientes de la zona del servidor (en UTC "14:00" a secas serían las 16:00 reales
// en verano en Madrid).
import { getBranding } from './property'

// Timestamp (ms) de una fecha+hora local en la zona `tz` (IANA).
export function zonedMs(dateStr: string, hour: number, minute: number, tz: string): number {
  const utcGuess = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`).getTime()
  const offsetName = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
    .formatToParts(new Date(utcGuess)).find(p => p.type === 'timeZoneName')?.value ?? 'GMT'
  const m = offsetName.match(/GMT(?:([+-])(\d{2}):(\d{2}))?/)
  const sign = m?.[1] === '-' ? -1 : 1
  const offsetMin = m?.[2] ? sign * (parseInt(m[2]) * 60 + parseInt(m[3]!)) : 0
  return utcGuess - offsetMin * 60_000
}

// Igual, con la zona del tenant del contexto actual.
export async function propertyMs(dateStr: string, hour: number, minute = 0): Promise<number> {
  return zonedMs(dateStr, hour, minute, (await getBranding()).timezone)
}

// Suma (o resta) días a una fecha YYYY-MM-DD, sin líos de zona horaria —
// usado para turnos que cruzan medianoche (hora_fin <= hora_inicio implica
// que hora_fin es del día siguiente a `dateStr`).
export function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
