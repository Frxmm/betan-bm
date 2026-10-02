import postgres from 'postgres'
import { readFileSync } from 'fs'

const url = process.env.DATABASE_URL
if (!url) { console.error('DATABASE_URL no definida'); process.exit(1) }

const file = process.argv[2]
if (!file) { console.error('Uso: bun run scripts/apply-migration.ts <archivo.sql>'); process.exit(1) }

const sql_text = readFileSync(file, 'utf-8')
const client = postgres(url, { max: 1 })

try {
  await client.unsafe(sql_text)
  console.log(`✓ Migración aplicada: ${file}`)
} catch (e: any) {
  console.error('Error:', e.message)
  process.exit(1)
} finally {
  await client.end()
}
