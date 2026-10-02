import { getSecret, hasFeature } from './property'

const BASE = 'https://api.nobeds.com/api'

export interface NobedBooking {
  order_id:   number
  hotel_id:   number
  room_id:    number
  checkin:    string
  checkout:   string
  nights:     number
  name:       string
  email?:     string | null
  phone?:     string | null
  country?:   string | null
  address?:   string | null
  guests:     number
  childrens?: number | null
  price?:     number | null
  total?:     number | null
  prepay?:    number | null
  commission?:number | null
  balance?:   number | null
  status?:    string | null
  comment?:   string | null
  created?:   string | null
  inserted?:  string | null
  updated?:   string | null
  canceled?:  string | null
  deleted?:   string | null
}

export interface NobedRental {
  id:           number
  hotel_id:     number
  title:        string
  description?: string | null
  type?:        string | null
  max_guests?:  number | null
  bedrooms?:    number | null
}

export async function isConfigured(): Promise<boolean> {
  return await hasFeature('nobeds') && !!(await getSecret('NOBEDS_API_TOKEN'))
}

async function getToken(): Promise<string> {
  if (!await hasFeature('nobeds')) throw new Error('Módulo Nobeds no activado')
  const t = await getSecret('NOBEDS_API_TOKEN')
  if (!t) throw new Error('NOBEDS_API_TOKEN no configurado')
  return t
}

async function apiFetch<T>(
  endpoint: string,
  qs?: Record<string, string | number>,
  options?: RequestInit,
): Promise<T> {
  const t = await getToken()
  const params = qs && Object.keys(qs).length
    ? '?' + new URLSearchParams(Object.entries(qs).map(([k, v]) => [k, String(v)]))
    : ''
  const url = `${BASE}/${endpoint}/${t}${params}`
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Nobeds ${res.status}: ${text.slice(0, 200)}`)
  }
  const json = await res.json()
  return json as T
}

export async function listBookings(params?: {
  order_id?: number
  fromdate?: string
  todate?:   string
}): Promise<NobedBooking[]> {
  const qs: Record<string, string | number> = {}
  if (params?.order_id) qs.order_id = params.order_id
  if (params?.fromdate) qs.fromdate = params.fromdate
  if (params?.todate)   qs.todate   = params.todate
  const data = await apiFetch<NobedBooking | NobedBooking[]>('Bookings', qs)
  return Array.isArray(data) ? data : data ? [data] : []
}

export async function createBooking(roomId: number, data: Partial<NobedBooking>): Promise<NobedBooking> {
  return apiFetch<NobedBooking>('Bookings', { room_id: roomId }, {
    method: 'POST',
    body: JSON.stringify(data),
  })
}

export async function updateBooking(orderId: number, data: Partial<NobedBooking>): Promise<NobedBooking> {
  return apiFetch<NobedBooking>('Bookings', { order_id: orderId }, {
    method: 'PUT',
    body: JSON.stringify(data),
  })
}

export async function listRentals(): Promise<NobedRental[]> {
  const data = await apiFetch<NobedRental | NobedRental[]>('Rentals')
  return Array.isArray(data) ? data : data ? [data] : []
}

export async function pushAvailability(
  roomId:   number,
  date:     string,
  quantity: number,
  price?:   number,
): Promise<void> {
  const body: Record<string, unknown> = { date, quantity }
  if (price !== undefined) body.price = price
  await apiFetch<unknown>('Availability', { room_id: roomId }, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function getDatesRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = []
  const cur = new Date(checkIn + 'T00:00:00Z')
  const end = new Date(checkOut + 'T00:00:00Z')
  while (cur < end) {
    dates.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return dates
}

export async function blockDates(nobedsRoomId: number, checkIn: string, checkOut: string): Promise<void> {
  for (const date of getDatesRange(checkIn, checkOut)) {
    await pushAvailability(nobedsRoomId, date, 0)
  }
}

export async function unblockDates(nobedsRoomId: number, checkIn: string, checkOut: string): Promise<void> {
  for (const date of getDatesRange(checkIn, checkOut)) {
    await pushAvailability(nobedsRoomId, date, 1)
  }
}
