// Cliente de la API de solo lectura del sistema de mantenimiento/piscina
// (app Flask aparte, una por tenant: secretos POOL_API_URL / POOL_API_KEY; módulo 'pool').
// Autenticación por API key fija en la cabecera X-API-Key. Todos los
// endpoints son GET y no escriben nada — este cliente tampoco.

import { getSecret, hasFeature } from './property'

export async function isConfigured(): Promise<boolean> {
  if (!await hasFeature('pool')) return false
  return !!(await getSecret('POOL_API_URL')) && !!(await getSecret('POOL_API_KEY'))
}

async function poolFetch(path: string, params?: Record<string, string | number | undefined>): Promise<any> {
  const BASE_URL = await getSecret('POOL_API_URL')
  const API_KEY  = await getSecret('POOL_API_KEY')
  if (!await hasFeature('pool')) throw new Error('Módulo piscina no activado')
  if (!BASE_URL || !API_KEY) throw new Error('POOL_API_URL / POOL_API_KEY no configuradas')
  const url = new URL(path, BASE_URL)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url.toString(), { headers: { 'X-API-Key': API_KEY } })
  if (!res.ok) throw new Error(`API de piscina/mantenimiento: HTTP ${res.status}`)
  return res.json()
}

// ── Inventario de desayunos ─────────────────────────────────────────────────
export function getBreakfastInventory(fecha?: string) {
  return poolFetch('/api/inventario', { fecha })
}

// Catálogo de productos: unidad en la que se registra cada uno (cajas,
// paquetes, unidades, kg, L) y, cuando se conoce, la referencia real de
// peso/volumen de una unidad de compra (p.ej. "1 paquete = 200 g"). Sirve
// para traducir el recuento de get_breakfast_inventory (en cajas/paquetes/
// unidades) a peso/volumen real.
export function getInventoryCatalog() {
  return poolFetch('/api/inventario/catalogo')
}

// ── Incidencias de habitaciones ─────────────────────────────────────────────
export function getPendingIncidents() {
  return poolFetch('/api/incidencias/pendientes')
}
export function getResolvedIncidents() {
  return poolFetch('/api/incidencias/resueltas')
}

// ── Gas y cloro (garrafas) ──────────────────────────────────────────────────
// Actividad del personal (quién hizo cada registro) — para el rating de implicación.
export function getHygieneRecords(desde?: string, hasta?: string) {
  return poolFetch('/api/higiene', { desde, hasta })
}
export function getCompletedTasks(desde?: string, hasta?: string) {
  return poolFetch('/api/tareas-completadas', { desde, hasta })
}

export function getGasLevel() {
  return poolFetch('/api/gas')
}
export function getChlorineLevel() {
  return poolFetch('/api/cloro')
}

// ── Registros de piscina y agua corriente (AFC / ACS) ───────────────────────
export function getPoolReadings() {
  return poolFetch('/api/piscina')
}
export function getColdWaterReadings() {
  return poolFetch('/api/afc')
}
export function getHotWaterReadings() {
  return poolFetch('/api/acs')
}

// ── Aljibe / tanque de agua ──────────────────────────────────────────────────
export function getWaterTankStatus(rango?: 'dia' | 'semana' | 'mes', anio?: number, mes?: number) {
  return poolFetch('/api/tanque', { rango, anio, mes })
}
