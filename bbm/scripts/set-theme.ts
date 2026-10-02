/**
 * Asigna el tema 'light' (Claro) a todos los usuarios.
 * Crea la preferencia si no existe, la actualiza si ya existe.
 *
 * Uso: bun run scripts/set-theme.ts --tenant=<slug>
 */

import { db } from '../src/db'
import { users, userPreferences } from '../src/db/schema'
import { eq, sql } from 'drizzle-orm'
import { resolveTenant } from './lib/tenant'

const TENANT_ID = (await resolveTenant()).id   // --tenant=<slug>

const THEME = 'light'

const allUsers = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.propertyId, TENANT_ID))

const result = await db.insert(userPreferences)
  .values(allUsers.map(u => ({ userId: u.id, theme: THEME })))
  .onConflictDoUpdate({
    target: userPreferences.userId,
    set:    { theme: THEME, updatedAt: sql`now()` },
  })
  .returning({ userId: userPreferences.userId })

console.log(`✔ Tema '${THEME}' asignado a ${result.length} usuario(s)`)
allUsers.forEach(u => console.log(`  · ${u.email}`))
