// ─── Numeración y auto-facturación de facturas ─────────────────────────────────
// Helpers compartidos entre las rutas financieras y el motor de auto-facturación.

import { db } from '../db'
import { invoices, invoiceSettings, financialTransactions, reservations, currencies } from '../db/schema'
import { eq, and, like, max, inArray, sql } from 'drizzle-orm'
import { getPropertyId, getProperty, getSetting, hasFeature } from './property'

export const DEFAULT_FORMAT   = '{N:7}/{YYYY}'
export const DEFAULT_TEMPLATE = null  // null = usar plantilla hardcoded en el cliente
const DEFAULT_TAX_RATE = 10

export function resolveFormat(fmt: string): string {
  const y = new Date().getFullYear()
  return fmt.replace('{YYYY}', String(y)).replace('{YY}', String(y).slice(-2))
}

export function formatInvoiceNumber(fmt: string, num: number): string {
  return resolveFormat(fmt).replace(/\{N(?::(\d+))?\}/g, (_, pad) =>
    pad ? String(num).padStart(Number(pad), '0') : String(num)
  )
}

export function extractPrefix(fmt: string): string {
  return resolveFormat(fmt).replace(/\{N.*?\}.*$/, '')
}

export function extractNumber(fmt: string, invoiceNum: string): number {
  const prefix = extractPrefix(fmt)
  if (!invoiceNum.startsWith(prefix)) return 0
  return parseInt(invoiceNum.slice(prefix.length)) || 0
}

export async function getInvoiceConfig() {
  const cfg = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, getPropertyId()) })
  return {
    numberFormat: cfg?.numberFormat ?? DEFAULT_FORMAT,
    nextNumber:   cfg?.nextNumber   ?? 1,
    taxRate:      parseFloat(cfg?.taxRate ?? String(DEFAULT_TAX_RATE)),
    htmlTemplate: cfg?.htmlTemplate ?? DEFAULT_TEMPLATE,
  }
}

export async function nextInvoiceNumber(fmt: string, minNum: number): Promise<string> {
  const prefix = extractPrefix(fmt)
  const lastRow = await db.select({ n: max(invoices.invoiceNumber) })
    .from(invoices)
    .where(and(eq(invoices.propertyId, getPropertyId()), like(invoices.invoiceNumber, `${prefix}%`)))
  const lastNum = lastRow[0]?.n ? extractNumber(fmt, lastRow[0].n) : 0
  const num = Math.max(minNum, lastNum + 1)
  return formatInvoiceNumber(fmt, num)
}

export async function bumpInvoiceCounter(numberFormat: string, usedInvoiceNumber: string, taxRate: number) {
  const usedNum = extractNumber(numberFormat, usedInvoiceNumber)
  const cfgRow = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, getPropertyId()) })
  if (cfgRow) {
    await db.update(invoiceSettings)
      .set({ nextNumber: usedNum + 1, updatedAt: new Date() })
      .where(eq(invoiceSettings.propertyId, getPropertyId()))
  } else {
    await db.insert(invoiceSettings).values({
      propertyId: getPropertyId(), nextNumber: usedNum + 1, numberFormat, taxRate: String(taxRate),
    })
  }
}

// ─── Auto-facturación por pagos ────────────────────────────────────────────────
// Al registrar un pago se crea/actualiza automáticamente la factura de la
// reserva, contando SOLO los pagos con forma tarjeta, Stripe o Jumbo a crédito.
// La factura auto lleva el marcador [auto] en notes; una factura manual
// existente nunca se toca.

const AUTO_MARKER = '[auto]'

// Datos de facturación para pagos Jumbo a crédito (tour operador): salen del
// setting por tenant 'jumbo.invoiceTo' ({ billingName, billingNif, billingAddress })
// y solo si el tenant tiene el módulo 'jumbo'. Sin ello, los pagos jumbo_credit
// no generan factura automática.
type BillingTo = { billingName?: string; billingNif?: string; billingAddress?: string }
async function getJumboBilling(): Promise<BillingTo | null> {
  if (!(await hasFeature('jumbo'))) return null
  const cfg = await getSetting<BillingTo>('jumbo.invoiceTo')
  return cfg?.billingName ? cfg : null
}

// Formas de pago que generan/actualizan factura automática
const COUNTED_METHODS = new Set(['credit_card', 'stripe', 'jumbo_credit'])

function isCounted(method: string, jumboEnabled: boolean): boolean {
  const m = (method ?? '').toLowerCase()
  if (m === 'jumbo_credit') return jumboEnabled
  return COUNTED_METHODS.has(m)
}

// Id de la moneda del tenant (properties.currencyCode → currencies.code)
async function tenantCurrencyId(): Promise<number | undefined> {
  const p = await getProperty()
  const [cur] = await db.select({ id: currencies.id }).from(currencies).where(eq(currencies.code, p.currencyCode)).limit(1)
  return cur?.id
}
function isJumboCredit(method: string): boolean {
  return (method ?? '').toLowerCase() === 'jumbo_credit'
}

export async function syncAutoInvoice(reservationId: number, userId?: number): Promise<void> {
  try {
    // 1. Pagos que cuentan para la factura automática
    const jumboBilling = await getJumboBilling()
    const txs = await db.select({
      amount: financialTransactions.amount,
      method: financialTransactions.paymentMethod,
    }).from(financialTransactions)
      .where(and(eq(financialTransactions.reservationId, reservationId), eq(financialTransactions.propertyId, getPropertyId())))

    const counted  = txs.filter(t => isCounted(t.method, !!jumboBilling))
    const hasJumbo = counted.some(t => isJumboCredit(t.method))
    // Si hay pago Jumbo a crédito, la factura se emite a nombre del tour operador Jumbo
    // (jumbo.invoiceTo) y su importe debe ser SOLO lo pagado por esa vía — no la
    // suma de todos los pagos contados ni el precio total de la reserva. Si la
    // reserva tiene además algún pago normal (tarjeta/Stripe cobrado aparte al
    // huésped), eso no es dinero de Jumbo y no puede ir en una factura a su
    // nombre; se ignora aquí (necesitaría su propia factura, fuera de este flujo).
    const total = hasJumbo
      ? Math.round(counted.filter(t => isJumboCredit(t.method)).reduce((s, t) => s + parseFloat(t.amount), 0) * 100) / 100
      : Math.round(counted.reduce((s, t) => s + parseFloat(t.amount), 0) * 100) / 100
    if (total <= 0) return

    // 2. Factura existente de la reserva
    const existing = await db.query.invoices.findFirst({
      where: and(eq(invoices.reservationId, reservationId), eq(invoices.propertyId, getPropertyId())),
    })
    // Una factura creada manualmente manda: no la tocamos
    if (existing && !(existing.notes ?? '').includes(AUTO_MARKER)) return

    const cfg       = await getInvoiceConfig()
    const divisor   = 1 + cfg.taxRate / 100
    const subtotal  = parseFloat((total / divisor).toFixed(2))
    const taxAmount = parseFloat((total - subtotal).toFixed(2))

    if (existing) {
      // 3a. Actualizar el importe (y billing Jumbo si aplica y no hay billing ya)
      if (parseFloat(existing.total) === total) return  // sin cambios
      await db.update(invoices).set({
        subtotal:  String(subtotal),
        taxAmount: String(taxAmount),
        total:     String(total),
        ...(hasJumbo && !existing.billingName && jumboBilling ? jumboBilling : {}),
      }).where(and(eq(invoices.id, existing.id), eq(invoices.propertyId, getPropertyId())))
      return
    }

    // 3b. Crear factura nueva
    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())),
    })
    if (!reservation) return

    const billing = hasJumbo && jumboBilling ? jumboBilling : {
      billingName:    reservation.billingName    ?? undefined,
      billingNif:     reservation.billingNif     ?? undefined,
      billingAddress: reservation.billingAddress ?? undefined,
    }

    const invoiceNumber = await nextInvoiceNumber(cfg.numberFormat, cfg.nextNumber)
    await db.insert(invoices).values({
      propertyId:    getPropertyId(),
      reservationId,
      guestId:       reservation.guestId ?? undefined,
      invoiceNumber,
      subtotal:      String(subtotal),
      taxAmount:     String(taxAmount),
      total:         String(total),
      currencyId:    reservation.currencyId ?? (await tenantCurrencyId()),
      issuedAt:      new Date().toISOString().slice(0, 10),
      notes:         `${AUTO_MARKER} Factura generada automáticamente por pago`,
      createdBy:     userId ?? undefined,
      ...billing,
    })
    await bumpInvoiceCounter(cfg.numberFormat, invoiceNumber, cfg.taxRate)

    // Reflejar contador de facturas en la reserva
    const [agg] = await db.select({ n: sql<number>`COUNT(*)::int`, t: sql<string>`COALESCE(SUM(total),0)` })
      .from(invoices).where(and(eq(invoices.reservationId, reservationId), eq(invoices.propertyId, getPropertyId())))
    await db.update(reservations)
      .set({ invoiceCount: Number(agg?.n ?? 0) as any, invoiceTotal: agg?.t ?? '0', updatedAt: new Date() })
      .where(and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())))
  } catch (e: any) {
    // La auto-factura nunca debe romper el registro del pago
    console.error(`[autoInvoice] reserva ${reservationId}: ${e.message}`)
  }
}
