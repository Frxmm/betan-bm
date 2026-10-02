import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { env } from '../lib/env'
import * as schema from './schema'

// El cliente SQL de bajo nivel — gestiona el pool de conexiones
const client = postgres(env.DATABASE_URL)

// La instancia de Drizzle — es lo que usamos en toda la app
export const db = drizzle(client, { schema })

// Re-exportamos el schema para que sea accesible desde src/db
export { schema }
