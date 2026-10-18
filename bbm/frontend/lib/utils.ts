export function fmtDate(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function fmtDateTime(d?: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function fmtMoney(n?: string | number | null, currency = 'EUR') {
  if (n == null) return '—'
  return Number(n).toLocaleString('es-ES', { style: 'currency', currency })
}

export const STATUS_LABEL: Record<string, string> = {
  tentative:    'Provisional',   // web sin pagar / FDM sin confirmar
  arriving:     'Por llegar',    // llega hoy, aún sin check-in
  confirmed:    'Confirmada',
  checked_in:   'En casa',
  checking_out: 'Saliendo',
  checked_out:  'Ha salido',
  cancelled:    'Cancelada',
  no_show:      'No show',
}

export const STATUS_COLOR: Record<string, string> = {
  confirmed:    '#4f7cff',
  tentative:    '#9ca3af',
  arriving:     '#f59e0b',
  checked_in:   '#22c55e',
  checking_out: '#fb923c',
  checked_out:  '#6b7280',
  cancelled:    '#ef4444',
  no_show:      '#a855f7',
}

// Cajas compatibles con una forma de pago, según los flags de cada cuenta:
// Tarjeta/Stripe → cajas isCreditCard · Efectivo → cajas sin flag ·
// Si la caja tiene allowedMethods configurado → solo aparece para esos métodos.
// Si allowedMethods está vacío/null → fallback al comportamiento por flags (isCreditCard, isBankAccount).
// Si el filtro dejara la lista vacía, se devuelven todas (nunca bloquear).
export function accountsForMethod(accounts: any[], method: string): any[] {
  const m = (method ?? '').toLowerCase()
  const filtered = accounts.filter(a => {
    const allowed: string[] | null | undefined = a.allowedMethods
    if (allowed && allowed.length > 0) return allowed.includes(m)
    // fallback a flags legacy
    if (m === 'credit_card' || m === 'stripe') return a.isCreditCard
    if (m === 'bank_transfer')                 return a.isBankAccount
    if (m === 'cash')                          return !a.isCreditCard && !a.isBankAccount
    return true
  })
  return filtered.length > 0 ? filtered : accounts
}

export function today() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date())
}

export function addDays(iso: string, n: number) {
  const d = new Date(iso + 'T12:00:00')
  d.setDate(d.getDate() + n)
  return d.toISOString().slice(0, 10)
}

export function relativeDate(iso?: string | null) {
  if (!iso) return '—'
  if (iso === today()) return 'Hoy'
  if (iso === addDays(today(), 1)) return 'Mañana'
  return fmtDate(iso)
}

export function getDays(from: string, to: string) {
  const days: string[] = []
  const cur = new Date(from + 'T12:00:00')
  const end = new Date(to   + 'T12:00:00')
  while (cur <= end) { days.push(cur.toISOString().slice(0, 10)); cur.setDate(cur.getDate() + 1) }
  return days
}

export function sortRoomsByCode<T extends { code: string }>(rooms: T[]) {
  return [...rooms].sort((a, b) => {
    const na = parseInt(a.code), nb = parseInt(b.code)
    if (!isNaN(na) && !isNaN(nb)) return na - nb
    if (!isNaN(na)) return -1
    if (!isNaN(nb)) return  1
    return a.code.localeCompare(b.code)
  })
}

export function toast(msg: string, type: 'ok' | 'err' | 'warn' = 'ok') {
  const t = document.createElement('div')
  t.textContent = msg
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', right: '24px',
    background: type === 'ok' ? '#22c55e' : type === 'warn' ? '#f59e0b' : '#ef4444',
    color: '#fff', padding: '10px 18px', borderRadius: '8px',
    fontSize: '13px', fontWeight: '500', zIndex: '9999',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)', transition: 'opacity 0.3s',
  })
  document.body.appendChild(t)
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300) }, 2500)
}

/**
 * Tarifa raíz del tenant (la de la que derivan las demás y sobre la que actúa el
 * motor de reglas). Usa `isRoot` si el catálogo lo expone; si no, la primera tarifa
 * sin tarifa base (mismo criterio que el backend cuando no hay pricing.rootRateId).
 */
export function rootRateOf<T extends { baseRateId?: number | null; isRoot?: boolean }>(rates: T[]): T | undefined {
  return rates.find(r => r.isRoot) ?? rates.find(r => r.baseRateId == null)
}
