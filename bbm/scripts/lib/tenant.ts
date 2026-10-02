// Helper común de los scripts: resuelve el tenant (slug) y ejecuta dentro de su
// contexto (runWithProperty), igual que lo haría una petición HTTP.
//
// Uso:
//   bun scripts/mi-script.ts --tenant=<slug>      (o env TENANT=<slug>)
//
//   import { withTenant } from './lib/tenant'
//   await withTenant(async (p) => { ... getPropertyId() ... })
import { eq } from 'drizzle-orm'
import { db } from '../../src/db'
import { properties, type Property } from '../../src/db/schema'
import { runWithProperty } from '../../src/lib/property'

/** Lee `--tenant=slug` (o `--tenant slug`) de argv; si no, env TENANT. */
export function tenantSlugFromArgs(argv: string[] = process.argv.slice(2)): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--tenant=')) return a.slice('--tenant='.length).trim() || undefined
    if (a === '--tenant') return argv[i + 1]?.trim() || undefined
  }
  return process.env.TENANT?.trim() || undefined
}

/** Devuelve la fila del tenant o termina el proceso con un mensaje claro. */
export async function resolveTenant(slug?: string): Promise<Property> {
  const s = slug ?? tenantSlugFromArgs()
  if (!s) {
    console.error('Falta el tenant: pasa --tenant=<slug> o define TENANT=<slug>')
    process.exit(1)
  }
  const row = await db.query.properties.findFirst({ where: eq(properties.slug, s) })
  if (!row) {
    console.error(`Tenant "${s}" no existe (properties.slug)`)
    process.exit(1)
  }
  return row
}

/** Ejecuta `fn` dentro del contexto del tenant (getPropertyId() disponible). */
export async function withTenant<T>(fn: (p: Property) => Promise<T>, slug?: string): Promise<T> {
  const p = await resolveTenant(slug)
  return runWithProperty(p.id, () => fn(p))
}

/** Quita `--tenant…` de argv para scripts que parsean posicionales. */
export function argsWithoutTenant(argv: string[] = process.argv.slice(2)): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') { i++; continue }
    if (argv[i]!.startsWith('--tenant=')) continue
    out.push(argv[i]!)
  }
  return out
}
