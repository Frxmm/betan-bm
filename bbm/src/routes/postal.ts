import { Hono } from 'hono'
import rawData from '../lib/postal-es.json'

const cpToCity = rawData.cpToCity as unknown as Record<string, [string, string]>
// cities:  [nombre, cp_primario, provincia, ...cps_alternativos]
const cities  = rawData.cities  as unknown as [string, string, string, ...string[]][]
// barrios: [barrio, cp, ciudad, provincia]
const barrios = rawData.barrios as unknown as [string, string, string, string][]

const app = new Hono()

// GET /api/postal/cp/:cp → { city, province }
app.get('/cp/:cp', (c) => {
  const cp = c.req.param('cp').padStart(5, '0')
  const entry = cpToCity[cp]
  if (!entry) return c.json({ error: 'Not found' }, 404)
  return c.json({ city: entry[0], province: entry[1] })
})

// GET /api/postal/cities?q=...
// Devuelve ciudades y barrios. Tipo: 'city' | 'barrio'
// Barrios incluyen campo 'city' con el nombre de la ciudad padre.
app.get('/cities', (c) => {
  const q = (c.req.query('q') ?? '').trim()
  if (q.length < 2) return c.json({ data: [] })

  const isDigits = /^\d+$/.test(q)

  if (isDigits) {
    const data = cities
      .filter(([, cp, , ...alts]) => cp.startsWith(q) || alts.some(a => a.startsWith(q)))
      .slice(0, 50)
      .map(([display, cp, province]) => ({ type: 'city', display, cp, province }))
    return c.json({ data })
  }

  const ql = q.toLowerCase()
  const words = ql.split(/\s+/).filter(Boolean)
  const w1 = words[0]!
  const w2 = words[1]

  // ── Ciudades ──────────────────────────────────────────────────────────────
  let citySlice: [string, string, string, ...string[]][]
  if (!w2) {
    const byProvince = cities.filter(([, , prov]) => prov.toLowerCase().startsWith(w1))
    const byName     = cities.filter(([name, , prov]) =>
      name.toLowerCase().startsWith(w1) && !prov.toLowerCase().startsWith(w1)
    )
    citySlice = [...byProvince, ...byName].slice(0, 30)
  } else {
    const byProvince = cities.filter(([name, , prov]) =>
      prov.toLowerCase().startsWith(w1) && name.toLowerCase().startsWith(w2)
    )
    const byName = cities.filter(([name, , prov]) =>
      name.toLowerCase().startsWith(w1) && !prov.toLowerCase().startsWith(w1) &&
      name.toLowerCase().includes(w2)
    )
    citySlice = [...byProvince, ...byName].slice(0, 30)
  }

  // ── Barrios ───────────────────────────────────────────────────────────────
  const barrioSlice = barrios
    .filter(([b]) => b.toLowerCase().startsWith(ql))
    .slice(0, 20)

  const data = [
    ...citySlice.map(([display, cp, province]) => ({ type: 'city', display, cp, province })),
    ...barrioSlice.map(([display, cp, city, province]) => ({ type: 'barrio', display, cp, city, province })),
  ]

  return c.json({ data })
})

export default app
