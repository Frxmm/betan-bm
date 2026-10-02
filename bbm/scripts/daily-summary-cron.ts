// Resumen diario del hotel por email, diseñado para ejecutarse como cron.
// Llama al endpoint /api/ai/daily-summary usando un JWT de sistema efímero
// (con propertyId del tenant) — toda la lógica de negocio (qué datos reunir,
// quién lo redacta, a quién se envía) vive en la app, este script solo dispara
// la llamada y registra el resultado.
//
// Tenant: --tenant=<slug> (o env TENANT / TENANT_SLUG) → solo ese hotel. Sin
// tenant, itera TODOS los tenants activos con el módulo 'ai' (cada hotel con su
// zona horaria: si quieres enviarlo a las 23:00 locales de cada uno, programa un
// cron por tenant con su --tenant).
//
// La app debe estar corriendo en APP_URL (por defecto http://localhost:3000).
//
// Uso:
//   bun scripts/daily-summary-cron.ts --tenant=<slug>
//   bun scripts/daily-summary-cron.ts                    (todos los tenants)
//
// Crontab (ejemplo, 23:00 hora del servidor):
//   0 23 * * * cd /ruta/a/bbm && bun scripts/daily-summary-cron.ts --tenant=<slug> >> /var/log/daily-summary.log 2>&1

import { sign } from 'hono/jwt'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { properties } from '../src/db/schema'
import { featureOf } from '../src/lib/property'
import { resolveTenant, tenantSlugFromArgs } from './lib/tenant'

const JWT_SECRET = process.env.JWT_SECRET
if (!JWT_SECRET) {
  console.error(`[${ts()}] ERROR: JWT_SECRET no configurado en .env`)
  process.exit(1)
}

const APP_URL = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')

function ts() { return new Date().toISOString() }

// Tenants objetivo: el indicado, o todos los activos con el módulo 'ai'.
const slug = tenantSlugFromArgs() ?? process.env.TENANT_SLUG?.trim()
const targets = slug
  ? [await resolveTenant(slug)]
  : (await db.select().from(properties).where(eq(properties.active, true))).filter(p => featureOf(p, 'ai'))

if (targets.length === 0) {
  console.error(`[${ts()}] No hay tenants con el módulo 'ai' activo`)
  process.exit(1)
}

let failed = 0
for (const t of targets) {
  const label = t.slug ?? t.name
  // JWT de sistema con TTL de 2 minutos — solo para esta llamada interna. roles
  // incluye 'direccion' porque el endpoint arranca al agente de IA con ese rol
  // para poder usar los tools de caja/piscina/agua/inventario restringidos.
  const token = await sign(
    { propertyId: t.id, isPrimary: true, roles: ['direccion'], exp: Math.floor(Date.now() / 1000) + 120 },
    JWT_SECRET,
    'HS256'
  )

  console.log(`[${ts()}] [${label}] Generando resumen diario…`)

  let resp: Response
  try {
    resp = await fetch(`${APP_URL}/api/ai/daily-summary`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    })
  } catch (err: any) {
    console.error(`[${ts()}] [${label}] ERROR de conexión: ${err.message} (¿está corriendo la app en ${APP_URL}?)`)
    failed++
    continue
  }

  const data: any = await resp.json().catch(() => ({}))

  if (!resp.ok) {
    console.error(`[${ts()}] [${label}] ERROR ${resp.status}: ${data?.error ?? 'respuesta inesperada'}`)
    failed++
    continue
  }

  const r = data.data ?? {}
  console.log(`[${ts()}] [${label}] Resumen diario enviado (${r.date ?? '?'}) a: ${(r.to ?? []).join(', ')} — coste: $${r.costUsd ?? '?'}`)
}

process.exit(failed ? 1 : 0)
