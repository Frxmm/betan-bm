import { getPropertyId, getSecret, getSetting, hasFeature } from './property'

const FDM_REPORTS_DEFAULT = 'https://api-reports-premium.frontdeskmaster.com'

export interface FdmRoomUse { id: number; label: string; contains: string }
export interface FdmRate    { fdmRateId: number; localCode: string }

// Configuración FDM del tenant (settings fdm.*): sin defaults de ningún hotel
//   fdm.baseUrl     — host API del hotel en FDM (https://xxxx-api-premium.frontdeskmaster.com)
//   fdm.reportsUrl  — opcional
//   fdm.propertyId  — id de propiedad en FDM
//   fdm.currencyId  — id de moneda en FDM
//   fdm.rates       — [{ fdmRateId, localCode }]  (tarifa FDM → code de tarifa local)
//   fdm.roomUses    — [{ id, label, contains }]   (RoomUseId FDM → substring del nombre del tipo local)
//   fdm.accountMap  — { local: {fdmAccountId: localAccountId}, payMethod: {fdmAccountId: método} }
export interface FdmConfig {
  base: string; reports: string; property: number; currencyId: number
  roomUses: FdmRoomUse[]; rates: FdmRate[]
  accountLocal: Record<number, number>; accountPayMethod: Record<number, string>
}

export async function getFdmConfig(): Promise<FdmConfig> {
  if (!await hasFeature('fdm')) throw new Error('Módulo FDM no activado')
  const base = await getSetting<string>('fdm.baseUrl')
  const property = await getSetting<number>('fdm.propertyId')
  const currencyId = await getSetting<number>('fdm.currencyId')
  if (!base || !property || !currencyId) throw new Error('FDM sin configurar (settings fdm.baseUrl / fdm.propertyId / fdm.currencyId)')
  const acc = (await getSetting<{ local?: Record<number, number>; payMethod?: Record<number, string> }>('fdm.accountMap', {})) ?? {}
  return {
    base: base.replace(/\/$/, ''),
    reports: ((await getSetting<string>('fdm.reportsUrl')) ?? FDM_REPORTS_DEFAULT).replace(/\/$/, ''),
    property: Number(property), currencyId: Number(currencyId),
    roomUses: (await getSetting<FdmRoomUse[]>('fdm.roomUses', [])) ?? [],
    rates: (await getSetting<FdmRate[]>('fdm.rates', [])) ?? [],
    accountLocal: acc.local ?? {}, accountPayMethod: acc.payMethod ?? {},
  }
}

export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('fdm')) return false
  if (!await getSetting('fdm.baseUrl') || !await getSetting('fdm.propertyId')) return false
  return !!(await getSecret('FDM_CM_TOKEN')) || !!(await getSecret('FDM_USERNAME') && await getSecret('FDM_PASSWORD'))
}

function toWCF(dateISO: string): string {
  return `/Date(${new Date(dateISO + 'T00:00:00Z').getTime()})/`
}

function parseWCF(wcf: string): number {
  const m = wcf.match(/\/Date\((-?\d+)\)\//)
  return m ? parseInt(m[1]) : 0
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization:  `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'Accept':       'application/json, text/plain, */*',
    'Origin':       'https://app-premium.frontdeskmaster.com',
    'Referer':      'https://app-premium.frontdeskmaster.com/',
    'User-Agent':   'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
  }
}

// Token OAuth cacheado por tenant (clave = propertyId)
const tokenCache = new Map<number, { token: string; exp: number }>()

export async function getToken(): Promise<string> {
  const cm = await getSecret('FDM_CM_TOKEN')
  if (cm) return cm
  const pid = getPropertyId()
  const hit = tokenCache.get(pid)
  if (hit && Date.now() < hit.exp - 60_000) return hit.token
  const { base } = await getFdmConfig()
  const username = await getSecret('FDM_USERNAME'), password = await getSecret('FDM_PASSWORD')
  if (!username || !password) throw new Error('FDM_USERNAME / FDM_PASSWORD no configurados')
  const resp = await fetch(`${base}/OAuthService.svc/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'password',
      username,
      password,
      scope:      '*',
    }),
  })
  if (!resp.ok) throw new Error(`FDM auth: ${resp.status} ${await resp.text()}`)
  const { access_token, expires_in } = await resp.json() as { access_token: string; expires_in?: number }
  tokenCache.set(pid, { token: access_token, exp: Date.now() + (Number(expires_in) || 600) * 1000 })
  return access_token
}

// ── Registro de pricing (temporada/rango) obtenido del GET ───────────────────
export interface PricingRecord {
  id:          number
  priceInfoId: number
  currencyId:  number
  rateId:      number
  roomUseId:   number
  startMs:     number | null  // null = registro de temporada sin fecha específica
  endMs:       number | null
  dailyPrices: number[]       // [Dom, Lun, Mar, Mié, Jue, Vie, Sáb]
}

export async function fetchPricingRecords(token: string, from: string, to: string): Promise<PricingRecord[]> {
  const cfg = await getFdmConfig()
  const url = `${cfg.base}/HSOPService.svc/properties/${cfg.property}/roomPricingCategories/-1/pricing` +
    `?startDate=${from}&endDate=${to}&currencyId=${cfg.currencyId}` +
    `&includeInactiveSeasons=false` +
    `&expand=RoomUseId%2CSeasonId%2CRateId%2CPrices(CurrencyId)&limit=8000`

  const resp = await fetch(url, { headers: authHeaders(token) })
  if (!resp.ok) throw new Error(`pricing GET: ${resp.status} ${await resp.text()}`)
  const raw: any = await resp.json()
  const list: any[] = Array.isArray(raw) ? raw : (raw.Collection ?? raw.value ?? raw.Items ?? raw.Data ?? [])

  return list
    .filter(r => r.Prices?.length > 0 && r.RateId && r.RoomUseId)
    .map(r => ({
      id:          r.Id,
      priceInfoId: r.Prices[0].Id,
      currencyId:  r.Prices[0].CurrencyId ?? cfg.currencyId,
      rateId:      r.RateId,
      roomUseId:   r.RoomUseId,
      startMs:     r.StartDate ? parseWCF(r.StartDate) : null,
      endMs:       r.EndDate   ? parseWCF(r.EndDate)   : null,
      dailyPrices: r.Prices[0].DailyPrices ?? [],
    }))
}

// Prefiere el registro con fecha específica que cubra dateISO; si no, usa el de temporada
function findRecord(
  records:   PricingRecord[],
  rateId:    number,
  roomUseId: number,
  dateISO:   string,
): PricingRecord | undefined {
  const dateMs     = new Date(dateISO + 'T00:00:00Z').getTime()
  const candidates = records.filter(r => r.rateId === rateId && r.roomUseId === roomUseId)
  return (
    candidates.find(r => r.startMs !== null && r.startMs <= dateMs && r.endMs! >= dateMs) ??
    candidates.find(r => r.startMs === null)
  )
}

async function postPricingInfo(
  token:     string,
  rec:       PricingRecord,
  dateISO:   string,
  price:     number,
): Promise<void> {
  const dow = new Date(dateISO + 'T12:00:00').getDay()
  const dailyPrices = [0, 0, 0, 0, 0, 0, 0]
  dailyPrices[dow]  = price

  const cfg = await getFdmConfig()
  const resp = await fetch(
    `${cfg.base}/HSOPService.svc/properties/${cfg.property}/pricingInfo?expand=Prices(CurrencyId)`,
    {
      method:  'POST',
      headers: authHeaders(token),
      body:    JSON.stringify([{
        StartDate: toWCF(dateISO),
        EndDate:   toWCF(dateISO),
        RoomUseId: rec.roomUseId,
        RateId:    rec.rateId,
        id:        'HSO.data.model.PricingInfo-1',
        Id:        rec.id,
        Prices: [{
          Id:          rec.priceInfoId,
          NumGuests:   0,
          CurrencyId:  rec.currencyId,
          id:          'HSO.data.model.PriceInfo-2',
          DailyPrices: dailyPrices,
          Prices:      '',
        }],
      }]),
    },
  )
  if (!resp.ok) throw new Error(`pricingInfo: ${resp.status} ${await resp.text()}`)
}

async function postAvailability(token: string, dateISO: string, avail: number, fdmRoomUseId: number): Promise<void> {
  const cfg = await getFdmConfig()
  const resp = await fetch(
    `${cfg.base}/HSOPService.svc/properties/${cfg.property}/availability`,
    {
      method:  'POST',
      headers: authHeaders(token),
      body:    JSON.stringify([{
        Id:                null,
        Href:              '',
        Date:              toWCF(dateISO),
        Availability:      avail,
        RoomUseId:         fdmRoomUseId,
        AvailabilityLevel: 1,
        CreateInfo:        '',
        Availabilities:    '',
        AvailabilityData:  '',
      }]),
    },
  )
  if (!resp.ok) throw new Error(`availability: ${resp.status} ${await resp.text()}`)
}

async function postSetAvailability(token: string, dateISO: string, closed: boolean, fdmRateId: number, fdmRoomUseId: number): Promise<void> {
  const cfg = await getFdmConfig()
  const resp = await fetch(
    `${cfg.base}/HSOPService.svc/properties/${cfg.property}/setAvailability?desc=Price%20Matrix%20-%20Save%20Changes`,
    {
      method:  'POST',
      headers: authHeaders(token),
      body:    JSON.stringify({
        CMAvailabilities: [{
          Date:         toWCF(dateISO),
          RoomUseId:    fdmRoomUseId,
          RateId:       fdmRateId,
          TypeMask:     2,
          PriceChanged: true,
          ClosedRoom:   closed ? true : null,
        }],
        FDMAvailabilities: [{
          Date:      toWCF(dateISO),
          RoomUseId: fdmRoomUseId,
        }],
      }),
    },
  )
  if (!resp.ok) throw new Error(`setAvailability: ${resp.status} ${await resp.text()}`)
}

async function postSetAvailabilityRange(token: string): Promise<void> {
  const cfg = await getFdmConfig()
  const resp = await fetch(
    `${cfg.reports}/HSOPService.svc/properties/${cfg.property}/setAvailabilityRange?runAsync=true`,
    {
      method:  'POST',
      headers: authHeaders(token),
      body:    JSON.stringify({ ProfileId: -1, RangeDate: 3 }),
    },
  )
  if (!resp.ok) throw new Error(`setAvailabilityRange: ${resp.status} ${await resp.text()}`)
}

export interface PushEntry {
  date:         string
  price:        number
  avail:        number
  closed:       boolean
  fdmRateId:    number
  fdmRoomUseId: number
}

export interface PushResult {
  pushed:    number
  skipped:   number
  errors:    number
  errorList: string[]
  // Entradas que se enviaron con éxito (para que el caller pueda cachear el
  // estado empujado — ver fdm_push_state — y no reenviarlas la próxima vez
  // si no vuelven a cambiar).
  succeeded: PushEntry[]
}

const PUSH_CONCURRENCY = 8

async function runConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (queue.length) {
        const item = queue.shift()!
        await fn(item)
      }
    }),
  )
}

export async function pushPricesToFdm(
  entries: PushEntry[],
  from:    string,
  to:      string,
  mode:    'prices_only' | 'prices_and_avail' = 'prices_and_avail',
): Promise<PushResult> {
  if (!await isConfigured()) throw new Error('FDM no configurado (módulo, settings fdm.* y credenciales FDM_*)')

  const token   = await getToken()
  const records = await fetchPricingRecords(token, from, to)

  let pushed = 0, errors = 0
  const errorList: string[] = []
  const succeeded: PushEntry[] = []

  await runConcurrent(entries, PUSH_CONCURRENCY, async (e) => {
    if (errorList.length >= 30) return
    const label = `${e.date} R${e.fdmRateId}/RU${e.fdmRoomUseId}`
    try {
      const rec = findRecord(records, e.fdmRateId, e.fdmRoomUseId, e.date)
      if (!rec) throw new Error(`Sin registro de pricing en FDM para ${label}`)

      if (mode === 'prices_only') {
        await postPricingInfo(token, rec, e.date, e.price)
        await postSetAvailability(token, e.date, false, e.fdmRateId, e.fdmRoomUseId)
      } else if (e.closed) {
        await Promise.all([
          postAvailability(token, e.date, 0, e.fdmRoomUseId),
        ])
        await postSetAvailability(token, e.date, true, e.fdmRateId, e.fdmRoomUseId)
      } else {
        await Promise.all([
          postPricingInfo(token, rec, e.date, e.price),
          postAvailability(token, e.date, e.avail, e.fdmRoomUseId),
        ])
        await postSetAvailability(token, e.date, false, e.fdmRateId, e.fdmRoomUseId)
      }
      pushed++
      succeeded.push(e)
    } catch (err: any) {
      errors++
      errorList.push(`${label}: ${err.message}`)
    }
  })

  try {
    await postSetAvailabilityRange(token)
  } catch (err: any) {
    errorList.push(`setAvailabilityRange: ${err.message}`)
  }

  return { pushed, skipped: 0, errors, errorList, succeeded }
}
