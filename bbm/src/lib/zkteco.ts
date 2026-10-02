import { getSecret, hasFeature } from './property'

// Puente (bridge_win) por tenant: secretos ZKTECO_BRIDGE_URL / ZKTECO_BRIDGE_KEY; módulo 'zkteco'
export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('zkteco')) return false
  return !!(await getSecret('ZKTECO_BRIDGE_URL'))
}

async function bridgeFetch(path: string, opts: RequestInit = {}): Promise<any> {
  const BRIDGE_URL = (await getSecret('ZKTECO_BRIDGE_URL'))?.replace(/\/$/, '')
  const BRIDGE_KEY = (await getSecret('ZKTECO_BRIDGE_KEY')) ?? ''
  if (!BRIDGE_URL) throw new Error('ZKTECO_BRIDGE_URL no configurado')
  const r = await fetch(`${BRIDGE_URL}${path}`, {
    ...opts,
    headers: { 'X-API-Key': BRIDGE_KEY, ...(opts.headers ?? {}) },
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body?.detail ?? `bridge_win error ${r.status}`)
  return body
}

export async function revokeCard(userId: string): Promise<void> {
  await bridgeFetch(`/api/cards/${userId}`, { method: 'DELETE' })
}

export async function getStatus()                         { return bridgeFetch('/api/status') }
export async function openDoor(door: number)              { return bridgeFetch(`/api/doors/${door}/open`, { method: 'POST' }) }
export async function getCards()                          { return bridgeFetch('/api/cards') }
export async function syncCards()                         { return bridgeFetch('/api/sync', { method: 'POST' }) }
export async function getEvents(limit = 100, offset = 0)  { return bridgeFetch(`/api/events?limit=${limit}&offset=${offset}`) }
