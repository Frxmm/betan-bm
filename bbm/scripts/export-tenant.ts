/**
 * Exporta TODOS los datos de un tenant (por properties.id) a NDJSON, uno por tabla.
 * Sirve para entregar los datos a un cliente que se va, auditoría o restaurar un
 * solo tenant. Para el backup completo de la plataforma usa scripts/backup-db.sh.
 *
 * Uso:
 *   bun scripts/export-tenant.ts --tenant=<slug> [--out=./exports] [--include-secrets]
 *
 * Qué incluye:
 *   · cada tabla con columna property_id (filas del tenant)
 *   · tablas hijas sin property_id, alcanzadas por FK desde una tabla ya incluida
 *     (p.ej. reservation_nights → reservations), por JOIN en cascada
 *   · la fila de `properties` (con settings.secrets y password_hash REDACTADOS
 *     salvo --include-secrets)
 * Salida: <out>/<slug>-<YYYYMMDD-HHMMSS>/<tabla>.ndjson + manifest.json
 */
import { mkdir } from 'node:fs/promises'
import { resolveTenant } from './lib/tenant'

const out = process.argv.slice(2).find(a => a.startsWith('--out='))?.slice(6) ?? './exports'
const includeSecrets = process.argv.includes('--include-secrets')
const tenant = await resolveTenant()
const sql = Bun.sql  // DATABASE_URL del entorno

const q = (s: string, params: any[] = []) => sql.unsafe(s, params) as Promise<any[]>
const ident = (s: string) => '"' + s.replace(/"/g, '""') + '"'

// Tablas con property_id
const direct = (await q(`
  SELECT table_name FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'property_id' ORDER BY table_name`)).map(r => r.table_name as string)

// FKs hijo → padre (una columna)
const fks = await q(`
  SELECT c.conrelid::regclass::text AS child, a.attname AS child_col,
         c.confrelid::regclass::text AS parent, af.attname AS parent_col
  FROM pg_constraint c
  JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
  JOIN pg_attribute af ON af.attrelid = c.confrelid AND af.attnum = c.confkey[1]
  WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
    AND c.connamespace = 'public'::regnamespace`)

// "SELECT … FROM tabla WHERE <condición de tenant>" por tabla
const where = new Map<string, string>()
for (const t of direct) where.set(t, `${ident(t)}.property_id = ${tenant.id}`)
where.delete('properties')
// hijas: BFS (hasta 4 niveles) con subconsulta IN al padre ya resuelto
const sel = new Map<string, string>()  // tabla → SQL completo
for (const [t, w] of where) sel.set(t, `SELECT * FROM ${ident(t)} WHERE ${w}`)
for (let lvl = 0; lvl < 4; lvl++) {
  for (const f of fks) {
    if (sel.has(f.child) || f.child === 'properties' || !sel.has(f.parent)) continue
    sel.set(f.child, `SELECT * FROM ${ident(f.child)} WHERE ${ident(f.child_col)} IN (SELECT ${ident(f.parent_col)} FROM (${sel.get(f.parent)}) p)`)
  }
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6}).*$/, '$1-$2')
const dir = `${out}/${tenant.slug}-${stamp}`
await mkdir(dir, { recursive: true })

const manifest: Record<string, number> = {}
const redact = (table: string, row: any) => {
  if (includeSecrets) return row
  if (table === 'users') delete row.password_hash
  return row
}

// properties
{
  const [p] = await q(`SELECT * FROM properties WHERE id = $1`, [tenant.id])
  if (!includeSecrets && p?.settings) { const s = { ...p.settings }; delete s.secrets; p.settings = s }
  await Bun.write(`${dir}/properties.ndjson`, JSON.stringify(p) + '\n')
  manifest.properties = 1
}
for (const [table, query] of [...sel].sort()) {
  const rows = await q(query)
  if (rows.length === 0) continue
  await Bun.write(`${dir}/${table}.ndjson`, rows.map(r => JSON.stringify(redact(table, r))).join('\n') + '\n')
  manifest[table] = rows.length
}
await Bun.write(`${dir}/manifest.json`, JSON.stringify({
  tenant: { id: tenant.id, slug: tenant.slug }, exportedAt: new Date().toISOString(), includeSecrets, tables: manifest,
}, null, 2))

console.log(`✔ ${Object.keys(manifest).length} tablas, ${Object.values(manifest).reduce((a, b) => a + b, 0)} filas → ${dir}`)
process.exit(0)
