// ─── Planos del establecimiento (vista "Tiempo Real") ────────────────────────
// Los planos son datos del TENANT, no del producto: viven en
//   $FLOORPLANS_DIR/<slug>/<planta>.svg   (plano base, paredes)
//   $FLOORPLANS_DIR/<slug>/<planta>.json  (posiciones de habitación sobre el plano)
// (FLOORPLANS_DIR por defecto ./data/floorplans, ignorado por git). Requiere el
// módulo 'liveMap'. Montado tras requireAuth: el tenant sale del JWT.
import { Hono } from 'hono'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getProperty, hasFeature } from '../lib/property'
import { serverError } from '../lib/errors'

const app = new Hono()
const BASE = process.env.FLOORPLANS_DIR ?? './data/floorplans'
const SAFE = /^[A-Za-z0-9_-]+$/

async function tenantDir(): Promise<string | null> {
  const slug = (await getProperty()).slug
  return slug && SAFE.test(slug) ? join(BASE, slug) : null
}

app.use('*', async (c, next) => {
  if (!await hasFeature('liveMap')) return c.json({ error: 'Módulo no activado' }, 404)
  return next()
})

// GET /api/floorplans — plantas disponibles (las que tienen .svg y .json)
app.get('/', async (c) => {
  try {
    const dir = await tenantDir()
    if (!dir) return c.json({ data: [] })
    const files = await readdir(dir).catch(() => [] as string[])
    const floors = [...new Set(files.filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)))]
      .filter(f => files.includes(`${f}.json`))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    return c.json({ data: floors })
  } catch (err) { return serverError(c, err) }
})

// GET /api/floorplans/:floor/:kind  (kind = svg | json)
app.get('/:floor/:kind', async (c) => {
  try {
    const floor = c.req.param('floor'), kind = c.req.param('kind')
    if (!SAFE.test(floor) || (kind !== 'svg' && kind !== 'json')) return c.json({ error: 'No encontrado' }, 404)
    const dir = await tenantDir()
    if (!dir) return c.json({ error: 'No encontrado' }, 404)
    const file = Bun.file(join(dir, `${floor}.${kind}`))
    if (!await file.exists()) return c.json({ error: 'Plano no configurado' }, 404)
    return new Response(file, { headers: {
      'Content-Type': kind === 'svg' ? 'image/svg+xml' : 'application/json',
      'Cache-Control': 'private, max-age=300',
    } })
  } catch (err) { return serverError(c, err) }
})

export default app
