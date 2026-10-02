import { createHash } from 'node:crypto'
import { getPropertyId, getSecret, hasFeature } from './property'

const BASE_V3  = 'https://euapi.ttlock.com/v3'
const BASE_AUTH = 'https://euapi.ttlock.com'

function md5(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

// Token de acceso cacheado por tenant (clave = propertyId)
const tokenCache = new Map<number, { token: string; exp: number }>()

async function creds() {
  if (!await hasFeature('ttlock')) throw new Error('Módulo TTLock no activado')
  const clientId = await getSecret('TTLOCK_CLIENT_ID')
  const clientSecret = await getSecret('TTLOCK_CLIENT_SECRET')
  const username = await getSecret('TTLOCK_USERNAME')
  const password = await getSecret('TTLOCK_PASSWORD')
  if (!clientId || !clientSecret || !username || !password) throw new Error('TTLock no configurado (TTLOCK_CLIENT_ID/SECRET/USERNAME/PASSWORD)')
  return { clientId, clientSecret, username, password }
}

async function getAuth(): Promise<{ token: string; clientId: string }> {
  const c = await creds()
  const pid = getPropertyId()
  const hit = tokenCache.get(pid)
  if (hit && Date.now() < hit.exp - 60_000) return { token: hit.token, clientId: c.clientId }

  const body = new URLSearchParams({
    clientId:     c.clientId,
    clientSecret: c.clientSecret,
    username:     c.username,
    password:     md5(c.password),
  })
  const r = await fetch(`${BASE_AUTH}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await r.json() as any
  if (data.errcode) throw new Error(`TTLock auth: ${data.errmsg}`)
  tokenCache.set(pid, { token: data.access_token, exp: Date.now() + data.expires_in * 1000 })
  return { token: data.access_token, clientId: c.clientId }
}

// Genera un código de acceso OFFLINE vía /keyboardPwd/get: el servidor lo
// calcula con el algoritmo de la cerradura, así que funciona SIN gateway ni
// bluetooth (a diferencia de /keyboardPwd/add, que exige sincronización).
// Restricciones de los códigos "period" (tipo 3):
//  - startDate/endDate deben ir alineados a la hora en punto (min/seg = 0)
//  - el código debe usarse al menos una vez en las 24h siguientes a startDate,
//    o queda invalidado por la cerradura
export async function createPasscode(opts: {
  lockId:    string
  name:      string   // e.g. "Reserva #42 - Juan García"
  startMs:   number   // check-in timestamp ms
  endMs:     number   // check-out timestamp ms
}): Promise<{ code: string; keyboardPwdId: string }> {
  const { token, clientId: CLIENT } = await getAuth()

  const HOUR  = 3_600_000
  const start = Math.floor(opts.startMs / HOUR) * HOUR   // hora en punto hacia abajo
  const end   = Math.ceil(opts.endMs / HOUR) * HOUR      // hora en punto hacia arriba

  const body = new URLSearchParams({
    clientId:           CLIENT,
    accessToken:        token,
    lockId:             opts.lockId,
    keyboardPwdVersion: '4',
    keyboardPwdType:    '3',        // period: válido entre startDate y endDate
    keyboardPwdName:    opts.name,
    startDate:          String(start),
    endDate:            String(end),
    date:               String(Date.now()),
  })
  const r = await fetch(`${BASE_V3}/keyboardPwd/get`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await r.json() as any
  if (data.errcode) throw new Error(`TTLock createPasscode: ${data.errmsg} (errcode ${data.errcode})`)
  return { code: String(data.keyboardPwd), keyboardPwdId: String(data.keyboardPwdId) }
}

// OJO sin gateway: esto borra el código de la nube (registro), pero un código
// offline sigue siendo VÁLIDO en la cerradura hasta su endDate — la cerradura
// no tiene forma de enterarse del borrado. "Revocar" sin gateway es cosmético.
export async function deletePasscode(lockId: string, keyboardPwdId: string): Promise<void> {
  const { token, clientId: CLIENT } = await getAuth()
  const body = new URLSearchParams({
    clientId:       CLIENT,
    accessToken:    token,
    lockId,
    keyboardPwdId,
    date:           String(Date.now()),
  })
  const r = await fetch(`${BASE_V3}/keyboardPwd/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await r.json() as any
  if (data.errcode && data.errcode !== 0) throw new Error(`TTLock deletePasscode: ${data.errmsg}`)
}

// Enrola una tarjeta IC (Mifare) en una cerradura vía gateway.
// cardNumberHex: UID completo de 4 bytes en hex, ej "4D7054FD"
//   → cardNumber para la API = parseInt(hex, 16) en decimal (formato BE confirmado)
// addType=2 → operación vía gateway/WiFi (requiere gateway online)
export async function enrollCard(opts: {
  lockId:      string
  cardNumberHex: string   // hex 8 chars, ej "4D7054FD"
  cardName:    string
  startMs:     number
  endMs:       number
}): Promise<{ cardId: string }> {
  const { token, clientId: CLIENT } = await getAuth()
  const cardNumber = String(parseInt(opts.cardNumberHex, 16))

  const body = new URLSearchParams({
    clientId:    CLIENT,
    accessToken: token,
    lockId:      opts.lockId,
    cardNumber,
    cardName:    opts.cardName,
    startDate:   String(opts.startMs),
    endDate:     String(opts.endMs),
    addType:     '2',
    date:        String(Date.now()),
  })
  const r = await fetch(`${BASE_V3}/identityCard/add`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await r.json() as any
  if (data.errcode && data.errcode !== 0)
    throw new Error(`TTLock enrollCard: ${data.errmsg} (errcode ${data.errcode})`)
  return { cardId: String(data.cardId ?? '') }
}

export async function deleteCard(lockId: string, cardId: string): Promise<void> {
  const { token, clientId: CLIENT } = await getAuth()
  const body = new URLSearchParams({
    clientId:    CLIENT,
    accessToken: token,
    lockId,
    cardId,
    date:        String(Date.now()),
  })
  const r = await fetch(`${BASE_V3}/identityCard/delete`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const data = await r.json() as any
  if (data.errcode && data.errcode !== 0)
    throw new Error(`TTLock deleteCard: ${data.errmsg} (errcode ${data.errcode})`)
}

export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('ttlock')) return false
  return !!(await getSecret('TTLOCK_CLIENT_ID') && await getSecret('TTLOCK_CLIENT_SECRET') && await getSecret('TTLOCK_USERNAME'))
}
