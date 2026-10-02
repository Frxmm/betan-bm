/**
 * Crea un tenant (fila de `properties`) con su administrador y los datos base.
 *
 * Uso:
 *   bun scripts/create-tenant.ts --slug=hotel-sol --name="Hotel Sol" \
 *        --admin-email=dir@hotelsol.com [--admin-first=Dirección] [--admin-last=…] [--admin-password=…] \
 *        [--legal-name=…] [--vat=…] [--email=…] [--phone=…] [--address=…] [--city=…] \
 *        [--postal-code=…] [--region=…] [--country=ES] [--currency=EUR] [--timezone=Europe/Madrid] \
 *        [--domain=reservas.hotelsol.com] [--website=https://…] [--features=ttlock,ses,stripe]
 *
 * Los módulos por defecto son DEFAULT_ON (src/lib/property.ts); --features añade más.
 * Los datos base (tarifas, canales, cuentas, tipos…) los crea seedTenant() de
 * src/lib/tenantSeed.ts. Las credenciales de integraciones (secrets.*) se
 * cargan después desde la UI de plataforma (o con UPDATE de properties.settings).
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { properties, users, userRoles } from '../src/db/schema'
import { runWithProperty, DEFAULT_ON, ALL_FEATURES, invalidateProperty } from '../src/lib/property'

function arg(name: string): string | undefined {
  const a = process.argv.slice(2).find(x => x.startsWith(`--${name}=`))
  return a ? a.slice(name.length + 3) : undefined
}

const slug = arg('slug')?.toLowerCase()
const name = arg('name')
const adminEmail = arg('admin-email')?.toLowerCase().trim()
if (!slug || !name || !adminEmail || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error('Uso: bun scripts/create-tenant.ts --slug=<a-z0-9-> --name="Nombre" --admin-email=… [opciones, ver cabecera]')
  process.exit(1)
}

if (await db.query.properties.findFirst({ where: eq(properties.slug, slug) })) {
  console.error(`❌ Ya existe un tenant con slug "${slug}"`); process.exit(1)
}
if (await db.query.users.findFirst({ where: eq(users.email, adminEmail) })) {
  console.error(`❌ Ya existe un usuario con email ${adminEmail}`); process.exit(1)
}

const extra = (arg('features') ?? '').split(',').map(s => s.trim()).filter(Boolean)
for (const f of extra) if (!(ALL_FEATURES as string[]).includes(f)) { console.error(`Módulo desconocido "${f}" (${ALL_FEATURES.join(', ')})`); process.exit(1) }
const features: Record<string, boolean> = {}
for (const f of [...DEFAULT_ON, ...extra]) features[f] = true

const [prop] = await db.insert(properties).values({
  slug, name,
  legalName: arg('legal-name'),
  vatNumber: arg('vat'),
  email: arg('email') ?? adminEmail,
  phone: arg('phone'),
  address: arg('address'),
  city: arg('city'),
  postalCode: arg('postal-code'),
  region: arg('region'),
  countryCode: arg('country') ?? 'ES',
  currencyCode: arg('currency') ?? 'EUR',
  timezone: arg('timezone') ?? 'Europe/Madrid',
  publicDomain: arg('domain'),
  websiteUrl: arg('website'),
  features,
  settings: {},
} as any).returning()
const propertyId = prop!.id

const password = arg('admin-password') ??
  Math.random().toString(36).slice(2, 7) + Math.random().toString(36).toUpperCase().slice(2, 7)
const [admin] = await db.insert(users).values({
  propertyId,
  email: adminEmail,
  firstName: arg('admin-first') ?? 'Dirección',
  lastName: arg('admin-last') ?? name,
  passwordHash: await Bun.password.hash(password),
  isPrimary: true,
  active: true,
}).returning()
await db.insert(userRoles).values({ userId: admin!.id, role: 'direccion' })

// Datos base del tenant (tarifas, canales, cuentas financieras, catálogos…).
// NOTA: depende de src/lib/tenantSeed.ts (agente H); import dinámico para dar un error claro si aún no está.
try {
  const { seedTenant } = await import('../src/lib/tenantSeed')
  await runWithProperty(propertyId, () => seedTenant(propertyId))
  console.log('✔ Datos base creados (seedTenant)')
} catch (e: any) {
  console.error(`⚠ Tenant creado pero seedTenant falló o no existe: ${e.message}`)
  console.error('  Reintenta con seedTenant desde la UI de plataforma o revisa src/lib/tenantSeed.ts')
}
invalidateProperty(propertyId)

console.log(`\n✔ Tenant "${slug}" creado (id=${propertyId})`)
console.log(`  Módulos: ${Object.keys(features).join(', ')}`)
console.log(`  Admin: ${adminEmail}   Contraseña inicial: ${password}`)
console.log(`  Siguiente paso: DNS + nginx + certbot para ${arg('domain') ?? '(sin dominio propio: usa ?tenant=' + slug + ')'} (ver deploy/README.md)`)
process.exit(0)
