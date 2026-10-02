import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { financialAccounts, financialTransactions, paymentDateCorrections, invoices, invoiceSettings, reservations, paymentMethodConfigs, cashCollections } from '../db/schema'
import { eq, and, between, desc, asc, count, like, ilike, gte, lte, max, sql, inArray, notInArray } from 'drizzle-orm'
import { invoices as invoicesTable } from '../db/schema/financial'
import { notFound, serverError } from '../lib/errors'
import { currencies, users } from '../db/schema/core'
import { realPaidByReservation, pendingBalance as calcPendingBalance } from '../lib/paymentAggregate'
import type { Context } from 'hono'
import { getPropertyId, getProperty } from '../lib/property'

function getUserId(c: Context): number | undefined {
  const id = Number((c.get('jwtPayload') as { sub?: string | number } | undefined)?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

// ID de la divisa del tenant (properties.currencyCode → currencies.code),
// cacheado por código de divisa.
const _currencyIdByCode = new Map<string, number>()
async function getEurId(): Promise<number> {
  const code = (await getProperty()).currencyCode
  const hit = _currencyIdByCode.get(code)
  if (hit) return hit
  const cur = await db.query.currencies.findFirst({ where: (c, { eq }) => eq(c.code, code) })
  if (!cur) throw new Error(`Divisa ${code} del hotel no existe en la tabla currencies`)
  _currencyIdByCode.set(code, cur.id)
  return cur.id
}

// "Cobrado en otro turno": quien de verdad cobró el pago debe tener rol de
// recepción y estar activo — mismo criterio que la lista que ve el frontend
// en el selector (ver POST /transactions y /transactions/:id/correct-date).
async function resolveReceptionPayer(userId: number) {
  const payer = await db.query.users.findFirst({ where: and(eq(users.id, userId), eq(users.propertyId, getPropertyId())), with: { roles: true } })
  if (!payer || !payer.active || !(payer.roles as any[]).some(r => r.role === 'recepcion')) return null
  return payer
}

// ─── Helpers de numeración de facturas (compartidos con la auto-facturación) ──
import {
  DEFAULT_FORMAT, DEFAULT_TEMPLATE, formatInvoiceNumber, extractPrefix,
  extractNumber, getInvoiceConfig, nextInvoiceNumber, syncAutoInvoice,
} from '../lib/invoicing'

const app = new Hono()

// ─── CUENTAS FINANCIERAS (cajas) ──────────────────────────────────────────────

const DEFAULT_ACCOUNTS = [
  { name: 'Caja (efectivo)',        isDefault: true,  isCreditCard: false, isBankAccount: false },
  { name: 'Tarjeta',                isDefault: false, isCreditCard: true,  isBankAccount: false },
  { name: 'Transferencia bancaria', isDefault: false, isCreditCard: false, isBankAccount: true  },
  { name: 'Bizum',                  isDefault: false, isCreditCard: false, isBankAccount: false },
  { name: 'Stripe',                 isDefault: false, isCreditCard: true,  isBankAccount: false },
]

// GET /api/financial/accounts — lista de cajas (efectivo, tarjeta, stripe...)
app.get('/accounts', async (c) => {
  try {
    let list = await db.select().from(financialAccounts)
      .where(and(eq(financialAccounts.propertyId, getPropertyId()), eq(financialAccounts.active, true)))
    // Si no hay cuentas, crear las predeterminadas
    if (list.length === 0) {
      await db.insert(financialAccounts).values(
        DEFAULT_ACCOUNTS.map(a => ({ ...a, propertyId: getPropertyId(), countInShift: true, active: true }))
      )
      list = await db.select().from(financialAccounts).where(and(eq(financialAccounts.propertyId, getPropertyId()), eq(financialAccounts.active, true)))
    }
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/financial/accounts — crear caja (admin only)
app.post('/accounts', zValidator('json', z.object({
  name:           z.string().min(1),
  isDefault:      z.boolean().default(false),
  isCreditCard:   z.boolean().default(false),
  isBankAccount:  z.boolean().default(false),
  countInShift:   z.boolean().default(true),
  allowedMethods: z.array(z.string()).optional().nullable(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const [account] = await db.insert(financialAccounts)
      .values({ ...c.req.valid('json'), propertyId: getPropertyId(), active: true })
      .returning()
    return c.json({ data: account }, 201)
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/financial/accounts/:id — editar caja (admin only)
app.patch('/accounts/:id', zValidator('json', z.object({
  name:           z.string().min(1).optional(),
  isDefault:      z.boolean().optional(),
  isCreditCard:   z.boolean().optional(),
  isBankAccount:  z.boolean().optional(),
  countInShift:   z.boolean().optional(),
  active:         z.boolean().optional(),
  allowedMethods: z.array(z.string()).optional().nullable(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(financialAccounts)
      .set(c.req.valid('json'))
      .where(and(eq(financialAccounts.id, id), eq(financialAccounts.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Cuenta')
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/financial/accounts/:id — desactivar caja (soft delete, admin only)
app.delete('/accounts/:id', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(financialAccounts)
      .set({ active: false })
      .where(and(eq(financialAccounts.id, id), eq(financialAccounts.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Cuenta')
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// ─── FORMAS DE PAGO CONFIGURABLES ────────────────────────────────────────────

// GET /api/financial/payment-methods
app.get('/payment-methods', async (c) => {
  try {
    const list = await db.select().from(paymentMethodConfigs)
      .where(eq(paymentMethodConfigs.propertyId, getPropertyId()))
      .orderBy(paymentMethodConfigs.sortOrder, paymentMethodConfigs.id)
    return c.json({ data: list })
  } catch (err) { return serverError(c, err) }
})

// POST /api/financial/payment-methods (admin only)
app.post('/payment-methods', zValidator('json', z.object({
  key:       z.string().min(1).regex(/^[a-z0-9_]+$/, 'Solo letras minúsculas, números y _'),
  label:     z.string().min(1),
  color:     z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
  sortOrder: z.number().int().default(0),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const [created] = await db.insert(paymentMethodConfigs)
      .values({ ...c.req.valid('json'), propertyId: getPropertyId(), active: true })
      .returning()
    return c.json({ data: created }, 201)
  } catch (err: any) {
    if (err?.code === '23505') return c.json({ error: 'Ya existe una forma de pago con esa clave' }, 409)
    return serverError(c, err)
  }
})

// PATCH /api/financial/payment-methods/:id (admin only)
app.patch('/payment-methods/:id', zValidator('json', z.object({
  label:     z.string().min(1).optional(),
  color:     z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  active:    z.boolean().optional(),
  sortOrder: z.number().int().optional(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [updated] = await db.update(paymentMethodConfigs)
      .set(c.req.valid('json'))
      .where(and(eq(paymentMethodConfigs.id, id), eq(paymentMethodConfigs.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Forma de pago')
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/financial/payment-methods/:id (admin only)
app.delete('/payment-methods/:id', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [deleted] = await db.delete(paymentMethodConfigs)
      .where(and(eq(paymentMethodConfigs.id, id), eq(paymentMethodConfigs.propertyId, getPropertyId())))
      .returning()
    if (!deleted) return notFound(c, 'Forma de pago')
    return c.json({ data: deleted })
  } catch (err) { return serverError(c, err) }
})

// GET /api/financial/accounts/status — saldo de cada caja
app.get('/accounts/status', async (c) => {
  try {
    // TODO: calcular saldo real sumando transacciones del turno actual
    const list = await db.select().from(financialAccounts)
      .where(and(eq(financialAccounts.propertyId, getPropertyId()), eq(financialAccounts.active, true)))
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── TRANSACCIONES ────────────────────────────────────────────────────────────

// GET /api/financial/transactions — lista de transacciones con filtros
app.get('/transactions', zValidator('query', z.object({
  reservationId:   z.coerce.number().int().optional(),
  accountId:       z.coerce.number().int().optional(),
  paymentMethod:   z.string().min(1).optional(),
  operatorId:      z.coerce.number().int().optional(),
  channelId:       z.coerce.number().int().optional(),
  invoiced:        z.enum(['yes','no']).optional(),
  dateFrom:        z.string().date().optional(),
  dateTo:          z.string().date().optional(),
  includeDeposits: z.coerce.number().int().optional(),
  page:            z.coerce.number().int().min(1).default(1),
  limit:           z.coerce.number().int().max(200).default(50),
})), async (c) => {
  try {
    const { reservationId, accountId, paymentMethod, operatorId, channelId, invoiced, dateFrom, dateTo, includeDeposits, page, limit } = c.req.valid('query')
    const offset = (page - 1) * limit

    const DEPOSIT_METHODS = ['deposit', 'deposit_cc'] as const

    const conditions: any[] = [eq(financialTransactions.propertyId, getPropertyId())]
    if (reservationId)  conditions.push(eq(financialTransactions.reservationId, reservationId))
    if (accountId)      conditions.push(eq(financialTransactions.financialAccountId, accountId))
    if (paymentMethod)  conditions.push(eq(financialTransactions.paymentMethod, paymentMethod))
    else if (!includeDeposits) conditions.push(notInArray(financialTransactions.paymentMethod, DEPOSIT_METHODS))
    if (dateFrom && dateTo) conditions.push(between(financialTransactions.transactionDate, dateFrom, dateTo))
    else if (dateFrom)  conditions.push(gte(financialTransactions.transactionDate, dateFrom))
    else if (dateTo)    conditions.push(lte(financialTransactions.transactionDate, dateTo))

    // Filtro por operador
    if (operatorId) {
      const resIds = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.operatorId, operatorId)))
      const ids = resIds.map(r => r.id)
      conditions.push(ids.length > 0 ? inArray(financialTransactions.reservationId, ids) : sql`false`)
    }

    // Filtro por canal
    if (channelId) {
      const resIds = await db
        .select({ id: reservations.id })
        .from(reservations)
        .where(and(eq(reservations.propertyId, getPropertyId()), eq(reservations.bookingChannelId, channelId)))
      const ids = resIds.map(r => r.id)
      conditions.push(ids.length > 0 ? inArray(financialTransactions.reservationId, ids) : sql`false`)
    }

    // Filtro facturado: reserva tiene/no tiene factura
    if (invoiced === 'yes') {
      const invoicedResIds = await db
        .select({ id: invoicesTable.reservationId })
        .from(invoicesTable)
        .where(sql`${invoicesTable.reservationId} IS NOT NULL`)
      const ids = invoicedResIds.map(r => r.id).filter(Boolean) as number[]
      conditions.push(ids.length > 0 ? inArray(financialTransactions.reservationId, ids) : sql`false`)
    } else if (invoiced === 'no') {
      const invoicedResIds = await db
        .select({ id: invoicesTable.reservationId })
        .from(invoicesTable)
        .where(sql`${invoicesTable.reservationId} IS NOT NULL`)
      const ids = invoicedResIds.map(r => r.id).filter(Boolean) as number[]
      conditions.push(
        ids.length > 0
          ? sql`(${financialTransactions.reservationId} IS NULL OR ${notInArray(financialTransactions.reservationId, ids)})`
          : sql`true`
      )
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined

    const [list, [totRow]] = await Promise.all([
      db.query.financialTransactions.findMany({
        where,
        with: {
          financialAccount: true,
          createdByUser:  { columns: { id: true, firstName: true, lastName: true } },
          paidByUser:     { columns: { id: true, firstName: true, lastName: true } },
          resolvedByUser: { columns: { id: true, firstName: true, lastName: true } },
          reservation: {
            columns: { id: true, externalCode: true },
            with: {
              guest:          { columns: { id: true, firstName: true, lastName: true } },
              room:           { columns: { id: true, code: true } },
              operator:       { columns: { id: true, name: true, code: true } },
              bookingChannel: { columns: { id: true, name: true } },
              invoices:       { columns: { id: true } },
            },
          },
        },
        orderBy: [desc(financialTransactions.transactionDate), desc(financialTransactions.id)],
        limit,
        offset,
      }),
      db.select({
        count: count(),
        total: sql<string>`coalesce(sum(${financialTransactions.amount}), 0)`,
      }).from(financialTransactions).where(where),
    ])

    return c.json({
      data: list,
      meta: {
        total:      totRow?.count ?? 0,
        totalAmount: parseFloat(totRow?.total ?? '0').toFixed(2),
        page,
        limit,
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/financial/transactions — registrar un pago
app.post('/transactions', zValidator('json', z.object({
  reservationId:       z.number().int().optional(),
  financialAccountId:  z.number().int().positive(),
  // Sin .min(0): "Marcar devuelto" en depósitos registra un importe negativo
  // (category='deposit_return') para descontar el depósito original de amountPaid.
  amount:              z.number(),
  currencyId:          z.number().int().optional(),
  paymentMethod:       z.string().min(1).default('cash'),
  category:            z.string().optional(),
  description:         z.string().optional(),
  transactionDate:     z.string().date().optional(),
  // "Cobrado en otro turno" — opcional, los tres juntos o ninguno. Requiere
  // description no vacía (ver resolveReceptionPayer/validación abajo).
  collectedTime:       z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:MM)').optional(),
  paidByUserId:        z.number().int().positive().optional(),
  // Solo pagos con forma de pago "tarjeta" — ver validación abajo.
  cardOperationNumber: z.string().optional(),
})), async (c) => {
  try {
    const body = c.req.valid('json')
    const pid = getPropertyId()

    // Caja y reserva deben ser del tenant (evita IDOR entre hoteles)
    const [acct] = await db.select({ id: financialAccounts.id }).from(financialAccounts)
      .where(and(eq(financialAccounts.id, body.financialAccountId), eq(financialAccounts.propertyId, pid))).limit(1)
    if (!acct) return c.json({ error: 'Caja no encontrada' }, 404)
    if (body.reservationId) {
      const [res] = await db.select({ id: reservations.id }).from(reservations)
        .where(and(eq(reservations.id, body.reservationId), eq(reservations.propertyId, pid))).limit(1)
      if (!res) return notFound(c, 'Reserva')
    }

    const wantsCorrection = body.collectedTime !== undefined || body.paidByUserId !== undefined
    let payer: Awaited<ReturnType<typeof resolveReceptionPayer>> = null
    let collectedAt: Date | null = null
    const transactionDate = body.transactionDate ?? new Date().toISOString().slice(0, 10)

    if (wantsCorrection) {
      if (!body.collectedTime || !body.paidByUserId) {
        return c.json({ error: 'Para "Cobrado en otro turno" indica la hora y quién cobró el pago' }, 400)
      }
      payer = await resolveReceptionPayer(body.paidByUserId)
      if (!payer) return c.json({ error: 'El usuario indicado debe tener rol de recepción y estar activo' }, 422)
      collectedAt = new Date(`${transactionDate}T${body.collectedTime}:00`)
      if (isNaN(collectedAt.getTime())) return c.json({ error: 'Fecha/hora inválida' }, 400)
    }

    // Tarjeta: exige el nº de pedido/operación de la terminal para poder
    // conciliar el pago después — o, si no se tiene a mano, el toggle
    // "Cobrado en otro turno" completo (ya resuelto arriba) como alternativa.
    // Se detecta por la clave O la etiqueta de la forma de pago (las claves
    // "card"/"credit_card" son la convención habitual en este proyecto — ver
    // scripts/fdm-import.ts — pero la etiqueta la puede haber escrito el
    // admin con otro texto, así que se comprueban las dos por seguridad).
    const methodCfg = await db.query.paymentMethodConfigs.findFirst({
      where: and(eq(paymentMethodConfigs.key, body.paymentMethod), eq(paymentMethodConfigs.propertyId, pid)),
    })
    const keyLower = body.paymentMethod.toLowerCase()
    const isCardMethod = keyLower.includes('card') || keyLower.includes('tarjeta')
      || !!methodCfg?.label?.toLowerCase().includes('tarjeta')
    if (isCardMethod && !body.cardOperationNumber?.trim() && !payer) {
      return c.json({ error: 'Para pagos con tarjeta indica el Nº de pedido/operación, o usa "Cobrado en otro turno" con la fecha y hora' }, 422)
    }

    const { collectedTime, paidByUserId, ...rest } = body
    const [tx] = await db.insert(financialTransactions).values({
      ...rest,
      currencyId: rest.currencyId ?? await getEurId(),
      amount: String(rest.amount),
      propertyId: pid,
      transactionDate,
      createdBy: getUserId(c),
      ...(payer ? { collectedAt, paidByUserId: payer.id } : {}),
    }).returning()

    if (payer && collectedAt) {
      await db.insert(paymentDateCorrections).values({
        transactionId:           tx!.id,
        reservationId:           tx!.reservationId,
        description:             body.description?.trim() || null,
        previousTransactionDate: transactionDate,
        previousCreatedBy:       getUserId(c),
        correctedAt:             collectedAt,
        paidByUserId:            payer.id,
        fixedBy:                 getUserId(c),
      })
    }

    // Actualizar amountPaid en la reserva
    if (body.reservationId) {
      const [agg] = await db.select({ total: sql<string>`coalesce(sum(amount),0)` })
        .from(financialTransactions)
        .where(and(eq(financialTransactions.reservationId, body.reservationId), eq(financialTransactions.propertyId, pid)))
      await db.update(reservations)
        .set({ amountPaid: agg!.total, updatedAt: new Date() })
        .where(and(eq(reservations.id, body.reservationId), eq(reservations.propertyId, pid)))
      // Auto-factura si el pago es tarjeta/Stripe/Jumbo a crédito
      await syncAutoInvoice(body.reservationId)
      // Registrar un depósito nuevo quita el aviso de objetos robados de esta reserva
      if (body.paymentMethod === 'deposit' || body.paymentMethod === 'deposit_cc') {
        await db.update(reservations)
          .set({ stolenItemsReportedAt: null, stolenItemsReportedBy: null })
          .where(and(eq(reservations.id, body.reservationId), eq(reservations.propertyId, pid)))
      }
    }
    return c.json({ data: tx }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// PATCH /api/financial/transactions/:id — editar importe/caja/forma de pago
// (solo admin) y/o descripción (recepción o dirección — es quien registra los
// pagos día a día; la descripción puede fijarse tanto al crear el pago como
// después, desde la pestaña Pagos — no es obligatoria para "Cobrado en otro
// turno", pero si existe se guarda como contexto en la corrección).
app.patch('/transactions/:id', zValidator('json', z.object({
  financialAccountId:  z.number().int().positive().optional(),
  paymentMethod:       z.string().min(1).optional(),
  amount:              z.number().optional(),
  description:         z.string().optional(),
  cardOperationNumber: z.string().optional(),
})), async (c) => {
  try {
    const { isAdmin, canManageReservations } = await import('../middleware/auth')
    const body = c.req.valid('json')
    const touchesAdminFields = body.financialAccountId !== undefined || body.paymentMethod !== undefined || body.amount !== undefined
    if (touchesAdminFields && !isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const touchesSoftFields = body.description !== undefined || body.cardOperationNumber !== undefined
    if (touchesSoftFields && !touchesAdminFields && !canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)

    const id   = Number(c.req.param('id'))
    const setData: Record<string, any> = {}
    if (body.financialAccountId  !== undefined) setData.financialAccountId  = body.financialAccountId
    if (body.paymentMethod       !== undefined) setData.paymentMethod       = body.paymentMethod
    if (body.amount              !== undefined) setData.amount              = String(body.amount)
    if (body.description         !== undefined) setData.description         = body.description.trim() || null
    if (body.cardOperationNumber !== undefined) setData.cardOperationNumber = body.cardOperationNumber.trim() || null
    if (setData.financialAccountId !== undefined) {
      const [acct] = await db.select({ id: financialAccounts.id }).from(financialAccounts)
        .where(and(eq(financialAccounts.id, setData.financialAccountId), eq(financialAccounts.propertyId, getPropertyId()))).limit(1)
      if (!acct) return c.json({ error: 'Caja no encontrada' }, 404)
    }
    const [updated] = await db.update(financialTransactions)
      .set(setData)
      .where(and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Transacción')
    if (updated.reservationId) {
      // Recalcular amountPaid si cambió el importe
      if (body.amount !== undefined) {
        const [agg] = await db.select({ total: sql<string>`coalesce(sum(amount),0)` })
          .from(financialTransactions)
          .where(and(eq(financialTransactions.reservationId, updated.reservationId), eq(financialTransactions.propertyId, getPropertyId())))
        await db.update(reservations)
          .set({ amountPaid: agg!.total, updatedAt: new Date() })
          .where(and(eq(reservations.id, updated.reservationId), eq(reservations.propertyId, getPropertyId())))
      }
      await syncAutoInvoice(updated.reservationId)
    }
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// POST /api/financial/transactions/:id/correct-date — "Cobrado en otro turno":
// corrige la fecha/hora real de cobro y quién lo cobró de verdad, cuando el
// pago se registró en el sistema con datos equivocados (tarde, por otra
// persona...). La descripción NO es obligatoria — si la transacción tiene
// una, se copia como contexto en el rastro de la corrección, pero no bloquea
// nada. Deja rastro en payment_date_corrections (fecha/usuario ANTERIORES)
// para poder sacar informes de pagos corregidos por usuario más adelante.
// Mismo efecto que marcar el toggle al registrar el pago (POST /transactions)
// pero sobre una transacción ya existente.
app.post('/transactions/:id/correct-date', zValidator('json', z.object({
  date:         z.string().date(),
  time:         z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Hora inválida (HH:MM)'),
  paidByUserId: z.number().int().positive(),
})), async (c) => {
  try {
    const { canManageReservations } = await import('../middleware/auth')
    if (!canManageReservations(c)) return c.json({ error: 'Sin permisos' }, 403)

    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')

    const tx = await db.query.financialTransactions.findFirst({
      where: and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())),
    })
    if (!tx) return notFound(c, 'Transacción')

    const payer = await resolveReceptionPayer(body.paidByUserId)
    if (!payer) return c.json({ error: 'El usuario indicado debe tener rol de recepción y estar activo' }, 422)

    const correctedAt = new Date(`${body.date}T${body.time}:00`)
    if (isNaN(correctedAt.getTime())) return c.json({ error: 'Fecha/hora inválida' }, 400)

    await db.insert(paymentDateCorrections).values({
      transactionId:           tx.id,
      reservationId:           tx.reservationId,
      description:             tx.description?.trim() || null,
      previousTransactionDate: tx.transactionDate,
      previousCreatedBy:       tx.createdBy,
      correctedAt,
      paidByUserId:            payer.id,
      fixedBy:                 getUserId(c),
    })

    const [updated] = await db.update(financialTransactions)
      .set({ transactionDate: body.date, collectedAt: correctedAt, paidByUserId: payer.id })
      .where(and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())))
      .returning()

    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// POST /api/financial/transactions/:id/cobrar — marca el depósito como cobrado (queda visible en pestaña)
app.post('/transactions/:id/cobrar', zValidator('json', z.object({
  financialAccountId: z.number().int().positive(),
  paymentMethod:      z.string().min(1),
})), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')

    const deposit = await db.query.financialTransactions.findFirst({
      where: and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())),
    })
    if (!deposit) return notFound(c, 'Depósito')
    const [acct] = await db.select({ id: financialAccounts.id }).from(financialAccounts)
      .where(and(eq(financialAccounts.id, body.financialAccountId), eq(financialAccounts.propertyId, getPropertyId()))).limit(1)
    if (!acct) return c.json({ error: 'Caja no encontrada' }, 404)
    if (!['deposit', 'deposit_cc'].includes(deposit.paymentMethod ?? ''))
      return c.json({ error: 'La transacción no es un depósito' }, 422)
    if (parseFloat(String(deposit.amount ?? '0')) <= 0)
      return c.json({ error: 'El depósito no tiene importe cobrable' }, 422)

    await db.transaction(async (tx) => {
      // Marcar el depósito como cobrado (no se elimina; queda visible en la
      // pestaña de depósitos). resolvedAt/resolvedBy: cuándo y quién lo
      // cobró — createdAt/createdByUser de esta fila siguen marcando el
      // registro ORIGINAL del depósito, no esta resolución.
      await tx.update(financialTransactions)
        .set({
          category:          'deposit_cobrado',
          financialAccountId: body.financialAccountId,
          description:       `Cobrado · ${body.paymentMethod}${deposit.description ? ' · ' + deposit.description : ''}`,
          resolvedAt:        new Date(),
          resolvedBy:        getUserId(c),
        })
        .where(and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())))

      if (deposit.reservationId) {
        // Limpiar alerta de objetos robados para esta reserva
        await tx.update(reservations)
          .set({ stolenItemsReportedAt: null, stolenItemsReportedBy: null })
          .where(and(eq(reservations.id, deposit.reservationId), eq(reservations.propertyId, getPropertyId())))
      }
    })

    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/financial/transactions/:id — eliminar transacción (solo admin)
app.delete('/transactions/:id', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [deleted] = await db.delete(financialTransactions)
      .where(and(eq(financialTransactions.id, id), eq(financialTransactions.propertyId, getPropertyId())))
      .returning()
    if (!deleted) return notFound(c, 'Transacción')
    // Recalcular amountPaid de la reserva si procede
    if (deleted.reservationId) {
      const [agg] = await db.select({ total: sql<string>`coalesce(sum(amount),0)` })
        .from(financialTransactions)
        .where(and(eq(financialTransactions.reservationId, deleted.reservationId), eq(financialTransactions.propertyId, getPropertyId())))
      await db.update(reservations)
        .set({ amountPaid: agg.total, updatedAt: new Date() })
        .where(and(eq(reservations.id, deleted.reservationId), eq(reservations.propertyId, getPropertyId())))
    }
    return c.json({ data: deleted })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── INFORMES ─────────────────────────────────────────────────────────────────

// GET /api/financial/reports/summary — resumen de pagos imputados por forma de pago y caja
app.get('/reports/summary', zValidator('query', z.object({
  dateFrom: z.string().date(),
  dateTo:   z.string().date(),
})), async (c) => {
  try {
    const { dateFrom, dateTo } = c.req.valid('query')

    const txs = await db.query.financialTransactions.findMany({
      where: and(
        eq(financialTransactions.propertyId, getPropertyId()),
        between(financialTransactions.transactionDate, dateFrom, dateTo),
        notInArray(financialTransactions.paymentMethod, ['deposit', 'deposit_cc']),
        sql`${financialTransactions.category} IS DISTINCT FROM 'movimiento_caja'`,
      ),
      with: { financialAccount: true, reservation: { with: { guest: true } } },
      orderBy: desc(financialTransactions.transactionDate),
    })

    const total = txs.reduce((s, t) => s + parseFloat(t.amount), 0)

    const byMethod: Record<string, { count: number; total: number }> = {}
    for (const t of txs) {
      const m = t.paymentMethod
      byMethod[m] ??= { count: 0, total: 0 }
      byMethod[m].count++
      byMethod[m].total += parseFloat(t.amount)
    }

    const byAccount: Record<string, { count: number; total: number }> = {}
    for (const t of txs) {
      const name = t.financialAccount?.name ?? 'Sin cuenta'
      byAccount[name] ??= { count: 0, total: 0 }
      byAccount[name].count++
      byAccount[name].total += parseFloat(t.amount)
    }

    return c.json({
      data: txs,
      meta: { dateFrom, dateTo, count: txs.length, total: total.toFixed(2), byMethod, byAccount },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/financial/reports/payments — informe de pagos (reservationPayments)
app.post('/reports/payments', zValidator('json', z.object({
  dateFrom:   z.string().date(),
  dateTo:     z.string().date(),
  statuses:   z.array(z.string()).optional(),
  accountIds: z.array(z.number()).optional(),
})), async (c) => {
  try {
    const { dateFrom, dateTo } = c.req.valid('json')
    const list = await db.query.financialTransactions.findMany({
      where: and(
        eq(financialTransactions.propertyId, getPropertyId()),
        between(financialTransactions.transactionDate, dateFrom, dateTo),
        sql`${financialTransactions.category} IS DISTINCT FROM 'movimiento_caja'`,
      ),
      with: { financialAccount: true, reservation: { with: { guest: true } } },
      orderBy: desc(financialTransactions.transactionDate),
    })
    return c.json({ data: list })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── FACTURAS ─────────────────────────────────────────────────────────────────

// GET /api/invoices — lista de facturas
app.get('/invoices', zValidator('query', z.object({
  reservationId:  z.coerce.number().int().optional(),
  invoiceNumber:  z.string().optional(),
  dateFrom:       z.string().date().optional(),
  dateTo:         z.string().date().optional(),
  page:           z.coerce.number().int().min(1).default(1),
  limit:          z.coerce.number().int().max(10000).default(50),
  sortBy:         z.enum(['invoiceNumber', 'issuedAt', 'subtotal', 'total']).default('invoiceNumber'),
  sortDir:        z.enum(['asc', 'desc']).default('desc'),
})), async (c) => {
  try {
    const { reservationId, invoiceNumber, dateFrom, dateTo, page, limit, sortBy, sortDir } = c.req.valid('query')
    const offset = (page - 1) * limit

    const conditions: any[] = [eq(invoices.propertyId, getPropertyId())]
    if (reservationId)  conditions.push(eq(invoices.reservationId, reservationId))
    if (invoiceNumber)  conditions.push(ilike(invoices.invoiceNumber, `%${invoiceNumber}%`))
    if (dateFrom)       conditions.push(gte(invoices.issuedAt, dateFrom))
    if (dateTo)         conditions.push(lte(invoices.issuedAt, dateTo))
    const where = conditions.length > 0 ? and(...conditions) : undefined

    const col = invoices[sortBy as keyof typeof invoices] as any
    const order = sortDir === 'asc' ? asc(col) : desc(col)

    const [list, total] = await Promise.all([
      db.query.invoices.findMany({
        where,
        with: {
          guest: true,
          reservation: {
            columns: { id: true, externalCode: true, checkInDate: true, checkOutDate: true, nights: true, people: true },
            with: {
              rate:           { columns: { title: true } },
              bookingChannel: { columns: { name: true } },
            },
          },
        },
        orderBy: order,
        limit,
        offset,
      }),
      db.select({ count: count() }).from(invoices).where(where),
    ])

    return c.json({ data: list, meta: { total: total[0]?.count ?? 0, page, limit } })
  } catch (err) {
    return serverError(c, err)
  }
})

// GET /api/invoices/:id — detalle de factura
app.get('/invoices/:id', async (c) => {
  try {
    const id = Number(c.req.param('id'))
    const invoice = await db.query.invoices.findFirst({
      where: and(eq(invoices.id, id), eq(invoices.propertyId, getPropertyId())),
      with: { guest: true, reservation: { with: { room: true } } },
    })
    if (!invoice) return notFound(c, 'Factura')
    return c.json({ data: invoice })
  } catch (err) {
    return serverError(c, err)
  }
})

// DELETE /api/financial/invoices/:id — eliminar factura (admin / dirección)
app.delete('/invoices/:id', async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [deleted] = await db.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.propertyId, getPropertyId()))).returning()
    if (!deleted) return notFound(c, 'Factura')
    return c.json({ data: deleted })
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/financial/invoices/:id — editar datos de facturación, notas, número y total (admin)
app.patch('/invoices/:id', zValidator('json', z.object({
  billingName:    z.string().nullable().optional(),
  billingNif:     z.string().nullable().optional(),
  billingAddress: z.string().nullable().optional(),
  notes:          z.string().nullable().optional(),
  invoiceNumber:  z.string().min(1).optional(),
  total:          z.number().positive().optional(),
})), async (c) => {
  try {
    const id   = Number(c.req.param('id'))
    const body = c.req.valid('json')
    const setData: Record<string, any> = {}
    if (body.billingName    !== undefined) setData.billingName    = body.billingName
    if (body.billingNif     !== undefined) setData.billingNif     = body.billingNif
    if (body.billingAddress !== undefined) setData.billingAddress = body.billingAddress
    if (body.notes          !== undefined) setData.notes          = body.notes
    if (body.invoiceNumber  !== undefined) setData.invoiceNumber  = body.invoiceNumber
    if (body.total !== undefined) {
      const cfg       = await getInvoiceConfig()
      const divisor   = 1 + cfg.taxRate / 100
      const subtotal  = parseFloat((body.total / divisor).toFixed(2))
      const taxAmount = parseFloat((body.total - subtotal).toFixed(2))
      setData.total    = String(body.total)
      setData.subtotal = String(subtotal)
      setData.taxAmount= String(taxAmount)
    }
    const [updated] = await db.update(invoices)
      .set(setData)
      .where(and(eq(invoices.id, id), eq(invoices.propertyId, getPropertyId())))
      .returning()
    if (!updated) return notFound(c, 'Factura')
    return c.json({ data: updated })
  } catch (err) { return serverError(c, err) }
})

// POST /api/invoices — crear factura
app.post('/invoices', zValidator('json', z.object({
  reservationId: z.number().int().optional(),
  guestId:       z.number().int().optional(),
  invoiceNumber: z.string(),
  subtotal:      z.number().positive(),
  taxAmount:     z.number().min(0).default(0),
  total:         z.number().positive(),
  currencyId:    z.number().int().optional(),
  notes:         z.string().optional(),
})), async (c) => {
  try {
    const body = c.req.valid('json')
    if (body.reservationId) {
      const [res] = await db.select({ id: reservations.id }).from(reservations)
        .where(and(eq(reservations.id, body.reservationId), eq(reservations.propertyId, getPropertyId()))).limit(1)
      if (!res) return notFound(c, 'Reserva')
    }
    const [invoice] = await db.insert(invoices).values({
      ...body,
      currencyId: body.currencyId ?? await getEurId(),
      subtotal:  String(body.subtotal),
      taxAmount: String(body.taxAmount),
      total:     String(body.total),
      propertyId: getPropertyId(),
      issuedAt: new Date().toISOString().slice(0, 10),
    }).returning()
    return c.json({ data: invoice }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/financial/invoices/from-reservation/:id
// Crea una factura para la reserva — permite varias facturas por reserva (p.ej.
// una parcial y luego el resto). Body opcional: { amount }; si no se pasa, se
// factura todo lo pendiente. En ambos casos el importe nunca puede superar lo
// pendiente de facturar: Total pagado (pagos + depósitos ya cobrados) menos lo
// que ya se hubiera facturado antes (suma de invoices.total de esta reserva,
// que ya resta sola las rectificativas porque se guardan en negativo).
// Genera número correlativo e incrementa el contador en invoice_settings.
app.post('/invoices/from-reservation/:id', zValidator('json', z.object({
  amount: z.number().positive().optional(),
})), async (c) => {
  try {
    const reservationId = Number(c.req.param('id'))
    const { amount: requestedAmount } = c.req.valid('json')

    const reservation = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())),
      with: { guest: true },
    })
    if (!reservation) return notFound(c, 'Reserva')

    // Total pagado real (excluye depósitos aún sin cobrar) — mismo criterio que
    // usa la pestaña de Facturas en ReservationDetailView (ver
    // src/lib/paymentAggregate.ts).
    const totalPaid = (await realPaidByReservation([reservationId])).get(reservationId) ?? 0

    const [invAgg] = await db.select({ total: sql<string>`COALESCE(SUM(total),0)` })
      .from(invoices).where(and(eq(invoices.reservationId, reservationId), eq(invoices.propertyId, getPropertyId())))
    const totalInvoiced = parseFloat(invAgg?.total ?? '0')

    const remaining = Math.round((totalPaid - totalInvoiced) * 100) / 100
    if (remaining <= 0) return c.json({ error: 'No hay importe pendiente de facturar: ya se ha facturado todo lo cobrado' }, 422)

    const baseTotal = requestedAmount ?? remaining
    if (baseTotal > remaining + 0.01) {
      return c.json({ error: `El importe (${baseTotal.toFixed(2)} €) supera lo pendiente de facturar (${remaining.toFixed(2)} €)` }, 422)
    }

    const cfg = await getInvoiceConfig()
    const invoiceNumber = await nextInvoiceNumber(cfg.numberFormat, cfg.nextNumber)

    // taxRate es el % incluido en el total (IVA incluido → se desglosa)
    const divisor   = 1 + cfg.taxRate / 100
    const subtotal  = parseFloat((baseTotal / divisor).toFixed(2))
    const taxAmount = parseFloat((baseTotal - subtotal).toFixed(2))

    const [invoice] = await db.insert(invoices).values({
      propertyId:     getPropertyId(),
      reservationId,
      guestId:        reservation.guestId ?? undefined,
      invoiceNumber,
      subtotal:       String(subtotal),
      taxAmount:      String(taxAmount),
      total:          String(baseTotal),
      currencyId:     reservation.currencyId ?? await getEurId(),
      issuedAt:       new Date().toISOString().slice(0, 10),
      billingName:    reservation.billingName    ?? undefined,
      billingNif:     reservation.billingNif     ?? undefined,
      billingAddress: reservation.billingAddress ?? undefined,
    }).returning()

    // Incrementar el contador para la próxima factura
    const usedNum = extractNumber(cfg.numberFormat, invoiceNumber)
    const cfgRow = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, getPropertyId()) })
    if (cfgRow) {
      await db.update(invoiceSettings)
        .set({ nextNumber: usedNum + 1, updatedAt: new Date() })
        .where(eq(invoiceSettings.propertyId, getPropertyId()))
    } else {
      await db.insert(invoiceSettings).values({
        propertyId: getPropertyId(), nextNumber: usedNum + 1,
        numberFormat: cfg.numberFormat, taxRate: String(cfg.taxRate),
      })
    }

    return c.json({ data: invoice }, 201)
  } catch (err) {
    return serverError(c, err)
  }
})

// POST /api/financial/invoices/:id/credit-note
// Crea una factura rectificativa (devolución) con importes negados.
app.post('/invoices/:id/credit-note', async (c) => {
  try {
    const id  = Number(c.req.param('id'))
    const orig = await db.query.invoices.findFirst({ where: and(eq(invoices.id, id), eq(invoices.propertyId, getPropertyId())) })
    if (!orig) return notFound(c, 'Factura')

    const cfg          = await getInvoiceConfig()
    const invoiceNumber = await nextInvoiceNumber(cfg.numberFormat, cfg.nextNumber)
    const negTotal    = -Math.abs(parseFloat(orig.total))
    const negSubtotal = -Math.abs(parseFloat(orig.subtotal))
    const negTax      = -Math.abs(parseFloat(orig.taxAmount))

    const [credit] = await db.insert(invoices).values({
      propertyId:     orig.propertyId,
      reservationId:  orig.reservationId ?? undefined,
      guestId:        orig.guestId       ?? undefined,
      invoiceNumber,
      subtotal:       String(negSubtotal),
      taxAmount:      String(negTax),
      total:          String(negTotal),
      currencyId:     orig.currencyId,
      issuedAt:       new Date().toISOString().slice(0, 10),
      billingName:    orig.billingName    ?? undefined,
      billingNif:     orig.billingNif     ?? undefined,
      billingAddress: orig.billingAddress ?? undefined,
      notes:          `Factura rectificativa de ${orig.invoiceNumber}`,
    }).returning()

    const usedNum = extractNumber(cfg.numberFormat, invoiceNumber)
    const cfgRow  = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, getPropertyId()) })
    if (cfgRow) {
      await db.update(invoiceSettings)
        .set({ nextNumber: usedNum + 1, updatedAt: new Date() })
        .where(eq(invoiceSettings.propertyId, getPropertyId()))
    }

    return c.json({ data: credit }, 201)
  } catch (err) { return serverError(c, err) }
})

// POST /api/financial/invoices/proforma/:reservationId
// Devuelve los datos para imprimir una factura proforma (no se guarda en BD).
// Body: { amount?: number }  — si no se pasa, usa el saldo pendiente.
app.post('/invoices/proforma/:reservationId', zValidator('json', z.object({
  amount: z.number().positive().optional(),
})), async (c) => {
  try {
    const reservationId = Number(c.req.param('reservationId'))
    const { amount } = c.req.valid('json')

    const res = await db.query.reservations.findFirst({
      where: and(eq(reservations.id, reservationId), eq(reservations.propertyId, getPropertyId())),
    })
    if (!res) return notFound(c, 'Reserva')

    // Cargar guest y rate por separado para evitar problemas de tipos
    const { guests, rates, rooms: roomsTable } = await import('../db/schema')
    const { eq: eqQ } = await import('drizzle-orm')
    const [guest, rate] = await Promise.all([
      res.guestId ? db.query.guests.findFirst({ where: eqQ(guests.id, res.guestId) }) : null,
      res.rateId  ? db.query.rates.findFirst({  where: eqQ(rates.id,  res.rateId)  }) : null,
    ])

    // Calcular saldo pendiente — no cuenta los depósitos retenidos sin cobrar
    // como pago de la estancia (ver src/lib/paymentAggregate.ts), o se
    // proformaría dinero de depósito como si fuera ingreso de la reserva.
    const realPaidProforma = (await realPaidByReservation([res.id])).get(res.id) ?? 0
    const pending    = calcPendingBalance(res.total, realPaidProforma)
    const baseTotal  = amount ?? pending

    if (baseTotal <= 0) return c.json({ error: 'El importe debe ser mayor que cero' }, 422)

    const cfg = await getInvoiceConfig()
    const divisor   = 1 + cfg.taxRate / 100
    const subtotal  = parseFloat((baseTotal / divisor).toFixed(2))
    const taxAmount = parseFloat((baseTotal - subtotal).toFixed(2))

    return c.json({
      data: {
        invoiceNumber:  'PROFORMA',
        issuedAt:       new Date().toISOString().slice(0, 10),
        subtotal:       String(subtotal),
        taxAmount:      String(taxAmount),
        total:          String(baseTotal),
        notes:          null,
        billingName:    res.billingName    ?? null,
        billingNif:     res.billingNif     ?? null,
        billingAddress: res.billingAddress ?? null,
        guest,
        reservation: {
          id:           res.id,
          externalCode: res.externalCode,
          checkInDate:  res.checkInDate,
          checkOutDate: res.checkOutDate,
          nights:       res.nights,
          people:       res.people,
          rate,
        },
      },
    })
  } catch (err) {
    return serverError(c, err)
  }
})

// ─── INVOICE CONFIG ───────────────────────────────────────────────────────────

// GET /api/financial/invoice-config
app.get('/invoice-config', async (c) => {
  try {
    const cfg = await getInvoiceConfig()
    const preview = formatInvoiceNumber(cfg.numberFormat, cfg.nextNumber)
    return c.json({ data: { ...cfg, preview } })
  } catch (err) { return serverError(c, err) }
})

// PATCH /api/financial/invoice-config (admin only)
app.patch('/invoice-config', zValidator('json', z.object({
  numberFormat: z.string().min(1).optional(),
  nextNumber:   z.number().int().min(1).optional(),
  taxRate:      z.number().min(0).max(100).optional(),
  htmlTemplate: z.string().nullable().optional(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const body = c.req.valid('json')
    const patch: any = { ...body, updatedAt: new Date() }
    if (patch.taxRate !== undefined) patch.taxRate = String(patch.taxRate)
    const existing = await db.query.invoiceSettings.findFirst({ where: eq(invoiceSettings.propertyId, getPropertyId()) })
    let updated: any
    if (existing) {
      ;[updated] = await db.update(invoiceSettings)
        .set(patch)
        .where(eq(invoiceSettings.propertyId, getPropertyId()))
        .returning()
    } else {
      ;[updated] = await db.insert(invoiceSettings)
        .values({ propertyId: getPropertyId(), numberFormat: DEFAULT_FORMAT, nextNumber: 1, ...patch } as any)
        .returning()
    }
    const preview = formatInvoiceNumber(updated.numberFormat, updated.nextNumber)
    return c.json({ data: { ...updated, preview } })
  } catch (err) { return serverError(c, err) }
})

// ─── RECOGIDAS DE EFECTIVO ────────────────────────────────────────────────────

// Suma efectivo en un rango usando createdAt (único campo con hora precisa)
async function sumCashInRange(dateFrom: Date | null, dateTo: Date | null): Promise<string> {
  const conditions: any[] = [
    eq(financialTransactions.propertyId, getPropertyId()),
    eq(financialTransactions.paymentMethod, 'cash'),
  ]
  if (dateFrom) conditions.push(gte(financialTransactions.createdAt, dateFrom))
  if (dateTo)   conditions.push(lte(financialTransactions.createdAt, dateTo))
  const [r] = await db
    .select({ total: sql<string>`COALESCE(SUM(${financialTransactions.amount}), 0)` })
    .from(financialTransactions)
    .where(and(...conditions))
  return r?.total ?? '0'
}

// GET /api/financial/cash-collections — historial + cálculo de efectivo
// ?dateFrom=ISO&dateTo=ISO (opcional; por defecto: desde dateTo de última recogida hasta ahora)
app.get('/cash-collections', zValidator('query', z.object({
  dateFrom: z.string().datetime({ offset: true }).optional(),
  dateTo:   z.string().datetime({ offset: true }).optional(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)

    const list = await db
      .select({
        id:          cashCollections.id,
        collectedAt: cashCollections.collectedAt,
        dateFrom:    cashCollections.dateFrom,
        dateTo:      cashCollections.dateTo,
        amount:      cashCollections.amount,
        note:        cashCollections.note,
        createdAt:   cashCollections.createdAt,
        collectedByFirstName: users.firstName,
        collectedByLastName:  users.lastName,
      })
      .from(cashCollections)
      .leftJoin(users, eq(users.id, cashCollections.collectedBy))
      .where(eq(cashCollections.propertyId, getPropertyId()))
      .orderBy(desc(cashCollections.collectedAt))
      .limit(50)

    const now        = new Date()
    const lastDateTo = list[0]?.dateTo ?? null
    // Por defecto: desde el dateTo de la última recogida (sin solapamiento) hasta ahora
    const defaultFrom = lastDateTo ? new Date(lastDateTo.getTime() + 1000) : null

    const { dateFrom: qFrom, dateTo: qTo } = c.req.valid('query')
    const effectiveFrom = qFrom ? new Date(qFrom) : defaultFrom
    const effectiveTo   = qTo   ? new Date(qTo)   : now

    const pending = await sumCashInRange(effectiveFrom, effectiveTo)

    return c.json({
      data:        list,
      pending,
      dateFrom:    effectiveFrom?.toISOString() ?? null,
      dateTo:      effectiveTo.toISOString(),
    })
  } catch (err) { return serverError(c, err) }
})

// POST /api/financial/cash-collections — registrar recogida (admin only)
app.post('/cash-collections', zValidator('json', z.object({
  collectedAt: z.string().datetime({ offset: true }).optional(),
  dateFrom:    z.string().datetime({ offset: true }).optional().nullable(),
  dateTo:      z.string().datetime({ offset: true }).optional().nullable(),
  note:        z.string().optional().nullable(),
})), async (c) => {
  try {
    const { isAdmin } = await import('../middleware/auth')
    if (!isAdmin(c)) return c.json({ error: 'Sin permisos' }, 403)
    const userId = getUserId(c)
    if (!userId) return c.json({ error: 'Sin sesión' }, 401)

    const { collectedAt, dateFrom, dateTo, note } = c.req.valid('json')
    const collectedAtDate = collectedAt ? new Date(collectedAt) : new Date()
    const dateFromDate    = dateFrom    ? new Date(dateFrom)    : null
    const dateToDate      = dateTo      ? new Date(dateTo)      : new Date()

    const amount = await sumCashInRange(dateFromDate, dateToDate)

    const [created] = await db.insert(cashCollections)
      .values({
        propertyId:  getPropertyId(),
        collectedBy: userId,
        collectedAt: collectedAtDate,
        dateFrom:    dateFromDate,
        dateTo:      dateToDate,
        amount,
        note: note ?? null,
      })
      .returning()

    return c.json({ data: created }, 201)
  } catch (err) { return serverError(c, err) }
})

export default app
