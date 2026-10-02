/**
 * Crea un usuario en un tenant.
 *
 * Uso:
 *   bun scripts/create-user.ts --tenant=<slug> --email=a@b.com --first=Ana --last="Pérez" \
 *        --roles=recepcion,limpieza [--password=xxx] [--primary] [--platform-admin]
 *
 *   --tenant          slug del tenant (o env TENANT)
 *   --roles           uno o más de: recepcion, conserje, mantenimiento, direccion, limpieza, cocina
 *   --primary         usuario primario (dirección) del tenant
 *   --platform-admin  administrador de la plataforma (gestiona tenants)
 *   --password        si se omite se genera una aleatoria y se muestra al final
 */
import { db } from '../src/db'
import { users, userRoles } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { resolveTenant } from './lib/tenant'

const ROLES = ['recepcion', 'conserje', 'mantenimiento', 'direccion', 'limpieza', 'cocina'] as const
type Role = typeof ROLES[number]

function arg(name: string): string | undefined {
  const a = process.argv.slice(2).find(x => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}
const flag = (name: string) => process.argv.slice(2).includes(`--${name}`)

const email = arg('email')?.toLowerCase().trim()
const firstName = arg('first')
const lastName = arg('last') ?? ''
const roles = (arg('roles') ?? '').split(',').map(r => r.trim()).filter(Boolean) as Role[]
const isPrimary = flag('primary')
const isPlatformAdmin = flag('platform-admin')

if (!email || !firstName) {
  console.error('Uso: bun scripts/create-user.ts --tenant=<slug> --email=… --first=… [--last=…] [--roles=a,b] [--primary] [--platform-admin] [--password=…]')
  process.exit(1)
}
for (const r of roles) if (!ROLES.includes(r)) { console.error(`Rol inválido "${r}" (${ROLES.join(' | ')})`); process.exit(1) }

const tenant = await resolveTenant()
const password = arg('password') ??
  Math.random().toString(36).slice(2, 7) + Math.random().toString(36).toUpperCase().slice(2, 7)

const existing = await db.query.users.findFirst({ where: eq(users.email, email) })
if (existing) {
  console.error(`\n❌ Ya existe un usuario con email ${email} (id=${existing.id})`)
  process.exit(1)
}

const [user] = await db.insert(users).values({
  propertyId: tenant.id,
  email,
  firstName,
  lastName,
  passwordHash: await Bun.password.hash(password),
  active: true,
  isPrimary,
  isPlatformAdmin,
}).returning()

if (roles.length) await db.insert(userRoles).values(roles.map(role => ({ userId: user!.id, role })))

console.log(`\n✔ Usuario creado en "${tenant.slug}"`)
console.log(`  ID: ${user!.id}  Email: ${email}  Roles: ${roles.join(', ') || '(ninguno)'}`)
console.log(`  Primario: ${isPrimary}  Platform admin: ${isPlatformAdmin}`)
console.log(`  Contraseña inicial: ${password}`)
process.exit(0)
