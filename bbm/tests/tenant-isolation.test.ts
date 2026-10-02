// Aislamiento multi-tenant.
//  1. Análisis estático (siempre): src/routes/*.ts, index.ts y src/lib no pueden contener ids literales de propiedad,
//     datos del primer cliente ni nombres mágicos. Implementa el "test grep en CI" de docs/03-DESACOPLAMIENTO-HOTEL.md.
//  2. Integración (solo si hay DATABASE_URL_TEST): dos tenants no se ven entre sí ni en la resolución pública.
import { test, expect, describe } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = join(import.meta.dir, '..')

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, exts, out)
    else if (exts.some(e => n.endsWith(e)) && !n.endsWith('.test.ts')) out.push(p)
  }
  return out
}

// [nombre, regex]. Se ignoran las líneas que son solo comentario.
const RULES: [string, RegExp][] = [
  ['propertyId literal',        /propertyId.{0,6}[^a-zA-Z0-9_.]1\b(?!\d)/],
  ['property_id = 1',           /property_id\s*=\s*1\b/],
  ['PROPERTY_ID',               /PROPERTY_ID/],
  ['nombre del primer cliente', /betania/i],
  ['id FDM 9713',               /\b9713\b/],
  ['CIF del primer cliente',    /B-?93439339/],
  ["'Stripe online'",           /['"`]Stripe online['"`]/],
  ["'Web directa'",             /['"`]Web directa['"`]/],
  ["'Dir AL'",                  /['"`]Dir AL['"`]/],
  ['hotelbetania',              /hotelbetania/i],
]

// Allowlist por fichero (relativa a bbm/) → reglas toleradas. Añadir aquí SOLO con justificación.
const ALLOW: Record<string, string[]> = {}

function scan(files: string[]) {
  const hits: string[] = []
  for (const f of files) {
    const rel = relative(ROOT, f)
    const allowed = ALLOW[rel] ?? []
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      const t = line.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return   // comentarios
      for (const [name, re] of RULES) {
        if (allowed.includes(name)) continue
        if (re.test(line)) hits.push(`${rel}:${i + 1} [${name}] ${t.slice(0, 120)}`)
      }
    })
  }
  return hits
}

describe('análisis estático: sin acoplamientos al primer cliente', () => {
  const sets: [string, string[]][] = [
    ['src/routes', walk(join(ROOT, 'src/routes'), ['.ts'])],
    ['src/lib + middleware + db (sin schema)', [
      ...walk(join(ROOT, 'src/lib'), ['.ts']), ...walk(join(ROOT, 'src/middleware'), ['.ts']),
    ]],
    ['index.ts', [join(ROOT, 'index.ts')]],
    ['scripts (sin legacy-betania)', walk(join(ROOT, 'scripts'), ['.ts', '.sh']).filter(f => !f.includes('legacy-betania'))],
    ['src/db/seed.ts', [join(ROOT, 'src/db/seed.ts')]],
  ]
  for (const [label, files] of sets) {
    test(label, () => {
      const hits = scan(files)
      if (hits.length) console.log(`\n${label}: ${hits.length} infracción(es)\n` + hits.join('\n'))
      expect(hits).toEqual([])
    })
  }
})

describe('integración con BD de test', () => {
  const url = process.env.DATABASE_URL_TEST
  test.skipIf(!url)('dos tenants: resolución pública y contexto no se mezclan', async () => {
    process.env.DATABASE_URL = url!
    const { db } = await import('../src/db')
    const { properties } = await import('../src/db/schema')
    const { resolvePublicProperty, runWithProperty, getPropertyId } = await import('../src/lib/property')
    const { inArray } = await import('drizzle-orm')

    const sa = `iso-a-${Date.now()}`, sb = `iso-b-${Date.now()}`
    const [a, b] = await db.insert(properties).values([
      { name: 'Aislamiento A', slug: sa, publicDomain: `${sa}.test` },
      { name: 'Aislamiento B', slug: sb, publicDomain: `${sb}.test` },
    ] as any).returning()
    try {
      expect(await resolvePublicProperty({ slug: sa })).toBe(a!.id)
      expect(await resolvePublicProperty({ host: `${sb}.test` })).toBe(b!.id)
      const seen = await Promise.all([
        runWithProperty(a!.id, async () => { await Bun.sleep(5); return getPropertyId() }),
        runWithProperty(b!.id, async () => getPropertyId()),
      ])
      expect(seen).toEqual([a!.id, b!.id])
      // TODO: con un JWT de A, GET /api/<recurso>/:id de una fila de B debe dar 404 (requiere montar la app con hono test client).
    } finally {
      await db.delete(properties).where(inArray(properties.id, [a!.id, b!.id]))
    }
  })
})
