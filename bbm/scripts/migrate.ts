import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL no definida')
  process.exit(1)
}

console.log('Conectando a:', url.replace(/:([^:@]+)@/, ':***@'))

const client = postgres(url, { max: 1 })
const db = drizzle(client)

try {
  await migrate(db, { migrationsFolder: './drizzle', migrationsSchema: 'public' })
  console.log('Migraciones aplicadas correctamente')
} catch (e) {
  console.error('Error al migrar:', e)
  process.exit(1)
} finally {
  await client.end()
}
