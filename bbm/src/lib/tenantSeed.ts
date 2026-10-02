// Alta de un tenant nuevo: crea lo mínimo para operar. IDEMPOTENTE — se puede
// ejecutar varias veces sobre el mismo tenant sin duplicar nada (solo rellena lo
// que falte). No lleva datos de ningún hotel concreto.
import { eq } from 'drizzle-orm'
import { db } from '../db'
import {
  properties, currencies, financialAccounts, paymentMethodConfigs, bookingChannels,
  invoiceSettings, messageSettings, alertConfigs, reservationFieldRules, rates,
} from '../db/schema'
import { MESSAGE_CATALOG } from './messaging'
import { invalidateProperty } from './property'

const NOMBRE_MONEDAS: Record<string, string> = { EUR: 'Euro', USD: 'US Dollar', GBP: 'British Pound' }

const CUENTAS_BASE = [
  { name: 'Caja efectivo',          isDefault: true,  isCreditCard: false, isBankAccount: false, countInShift: true  },
  { name: 'TPV tarjeta',            isDefault: false, isCreditCard: true,  isBankAccount: false, countInShift: true  },
  { name: 'Transferencia bancaria', isDefault: false, isCreditCard: false, isBankAccount: true,  countInShift: false },
  { name: 'Pagos online',           isDefault: false, isCreditCard: false, isBankAccount: false, countInShift: false },
]

const METODOS_PAGO = [
  { key: 'cash',          label: 'Efectivo',          color: '#22c55e' },
  { key: 'credit_card',   label: 'Tarjeta',           color: '#4f7cff' },
  { key: 'bank_transfer', label: 'Transferencia',     color: '#06b6d4' },
  { key: 'stripe',        label: 'Pago online',       color: '#a855f7' },
  { key: 'deposit',       label: 'Depósito efectivo', color: '#f97316' },
  { key: 'deposit_cc',    label: 'Depósito CC',       color: '#fb923c' },
  { key: 'other',         label: 'Otro',              color: '#64748b' },
]

const ALERTAS = [
  ['breakfast-unconfirmed',     'Desayunos sin confirmar (11:00–13:00)'],
  ['hk-unassigned',             'Habitaciones de limpieza sin asignar (desde 12:00)'],
  ['drawer-missing-first',      'Primer arqueo de caja pendiente (desde 15:15)'],
  ['drawer-missing-second',     'Segundo arqueo de caja pendiente (desde 23:15)'],
  ['drawer-mismatch',           'Descuadre en caja de cambio'],
  ['checkout-pending',          'Check-out pendiente después de las 14:00'],
  ['unpaid-reservation',        'Reservas en el hotel sin cobrar'],
  ['zero-total-reservation',    'Reservas con total 0'],
  ['stolen-items',              'Posibles objetos robados marcados'],
  ['checkin-abandoned',         'Check-in abandonado hoy'],
  ['unassigned-room',           'Reservas sin habitación asignada (check-in ≥ hoy)'],
  ['new-extras-web-directa',    'Extras nuevos de reservas web directa (hoy/mañana) sin revisar'],
  ['laundry-process-missing',   'Procesado de lavandería sin declarar (16:30–19:00)'],
  ['no-show-booking',           'Reservas de OTA sin marcar No Show en la extranet'],
  ['breakfast-inventory-stale', 'Inventario de desayunos desactualizado (>4 días o >25 desayunos servidos)'],
  ['blocked-room-no-incident',  'Habitación bloqueada sin incidencia de mantenimiento abierta'],
  ['stale-room-incident',       'Incidencias de habitación abiertas +3 días con cliente dentro'],
] as const

const REGLAS_CAMPOS = [
  { fieldKey: 'price',         label: 'Precio total' },
  { fieldKey: 'channel',       label: 'Canal de reserva' },
  { fieldKey: 'external_code', label: 'Código externo' },
]

// Nombre por defecto del canal de venta directa que se siembra en un tenant nuevo (editable después)
const DIRECT_CHANNEL_NAME = 'Venta directa'

export interface SeedResult {
  channelId: number
  stripeAccountId: number
  rootRateId: number | null
  created: string[]
}

export async function seedTenant(propertyId: number, opts: { rootRate?: boolean } = {}): Promise<SeedResult> {
  const prop = await db.query.properties.findFirst({ where: eq(properties.id, propertyId) })
  if (!prop) throw new Error(`Tenant ${propertyId} no existe`)
  const created: string[] = []
  const settings: Record<string, unknown> = { ...(prop.settings ?? {}) }

  // Moneda (tabla global): se asegura que exista la del tenant
  const code = (prop.currencyCode || 'EUR').toUpperCase()
  await db.insert(currencies).values({ code, name: NOMBRE_MONEDAS[code] ?? code }).onConflictDoNothing()

  // Cuentas financieras base
  const cuentas = await db.select().from(financialAccounts).where(eq(financialAccounts.propertyId, propertyId))
  for (const c of CUENTAS_BASE) {
    if (cuentas.some(x => x.name === c.name)) continue
    const [row] = await db.insert(financialAccounts).values({ propertyId, ...c, active: true }).returning()
    cuentas.push(row!)
    created.push(`cuenta:${c.name}`)
  }
  const stripeAcc = cuentas.find(x => x.name === 'Pagos online')!
  // Si el tenant ya tenía una cuenta de pagos online configurada, se respeta
  const stripeAccountId = Number(settings['bookingEngine.stripeAccountId']) || stripeAcc.id
  settings['bookingEngine.stripeAccountId'] = stripeAccountId

  // Métodos de pago (sin restricción única en la tabla: se comprueba a mano)
  const metodos = await db.select().from(paymentMethodConfigs).where(eq(paymentMethodConfigs.propertyId, propertyId))
  let orden = 1
  for (const m of METODOS_PAGO) {
    if (!metodos.some(x => x.key === m.key)) {
      await db.insert(paymentMethodConfigs).values({ propertyId, ...m, sortOrder: orden })
      created.push(`metodoPago:${m.key}`)
    }
    orden++
  }

  // Canal de venta directo (el del motor de reservas) + canales habituales
  const canales = await db.select().from(bookingChannels).where(eq(bookingChannels.propertyId, propertyId))
  let canalDirecto = canales.find(x => x.id === Number(settings['bookingEngine.channelId']))
    ?? canales.find(x => x.isDefault) ?? canales.find(x => x.name === DIRECT_CHANNEL_NAME)
  if (!canalDirecto) {
    const [row] = await db.insert(bookingChannels)
      .values({ propertyId, name: DIRECT_CHANNEL_NAME, isDefault: true, active: true }).returning()
    canalDirecto = row!
    created.push(`canal:${DIRECT_CHANNEL_NAME}`)
  }
  settings['bookingEngine.channelId'] = canalDirecto.id

  // Facturación: serie por defecto
  const inv = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, propertyId) })
  if (!inv) {
    await db.insert(invoiceSettings).values({ propertyId, numberFormat: '{N:7}/{YYYY}', nextNumber: 1, taxRate: '10' })
    created.push('facturacion')
  }

  // Mensajes: qué canales usa cada comunicación (las plantillas HTML usan el
  // texto por defecto del código hasta que el tenant las personalice)
  const msgs = await db.select().from(messageSettings).where(eq(messageSettings.propertyId, propertyId))
  for (const [key, m] of Object.entries(MESSAGE_CATALOG)) {
    if (msgs.some(x => x.key === key)) continue
    await db.insert(messageSettings).values({ propertyId, key, email: m.email, whatsapp: m.whatsapp })
    created.push(`mensaje:${key}`)
  }

  // Alertas
  const alertas = await db.select().from(alertConfigs).where(eq(alertConfigs.propertyId, propertyId))
  for (const [alertType, label] of ALERTAS) {
    if (alertas.some(x => x.alertType === alertType)) continue
    await db.insert(alertConfigs).values({ propertyId, alertType, label, enabled: true })
    created.push(`alerta:${alertType}`)
  }

  // Reglas de edición de campos de reserva (sin restricción)
  for (const r of REGLAS_CAMPOS) {
    await db.insert(reservationFieldRules)
      .values({ propertyId, ...r, allowedRoles: [], allowedChannelIds: [] }).onConflictDoNothing()
  }

  // Tarifa raíz (opcional): de ella derivan el resto de tarifas
  let rootRateId = Number(settings['pricing.rootRateId']) || null
  if (!rootRateId && opts.rootRate !== false) {
    const existentes = await db.select().from(rates).where(eq(rates.propertyId, propertyId))
    const raiz = existentes.find(r => r.baseRateId == null)
    if (raiz) rootRateId = raiz.id
    else {
      const [row] = await db.insert(rates)
        .values({ propertyId, title: 'Tarifa base', code: 'BASE', active: true, activeForBookingEngine: true }).returning()
      rootRateId = row!.id
      created.push('tarifa:BASE')
    }
  }
  if (rootRateId) settings['pricing.rootRateId'] = rootRateId

  await db.update(properties).set({ settings, updatedAt: new Date() }).where(eq(properties.id, propertyId))
  invalidateProperty(propertyId)

  return { channelId: canalDirecto.id, stripeAccountId, rootRateId, created }
}
