// ─── Caja de cambio: arqueo por denominaciones + gastos por reponer ───────────
// Accesible para recepción y dirección. La consigna (p.ej. 500 €) debe cuadrar:
// efectivo contado + gastos sin reponer = consigna.

import { Hono } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { z } from 'zod'
import { db } from '../db'
import { changeDrawerCounts, changeDrawerExpenses, changeDrawerDepositChecks, userRoles, users } from '../db/schema'
import { eq, desc, isNull, and, sql } from 'drizzle-orm'
import { serverError, notFound } from '../lib/errors'
import type { Context } from 'hono'
import { getPropertyId, hasFeature } from '../lib/property'

const app = new Hono()

// Módulo opcional: caja de cambio
app.use('*', async (c, next) => {
  if (!(await hasFeature('cashDrawer'))) return c.json({ error: 'Módulo de caja de cambio no activado' }, 404)
  await next()
})

// Denominaciones válidas (el frontend usa las mismas keys)
export const DENOM_VALUES: Record<string, number> = {
  c5: 0.05, c10: 0.10, c20: 0.20, c50: 0.50, e1: 1, e2: 2,
  b5: 5, b10: 10, b20: 20, b50: 50, b100: 100,
}

function getUserId(c: Context): number | undefined {
  const id = Number((c.get('jwtPayload') as { sub?: string | number } | undefined)?.sub)
  return isNaN(id) || id === 0 ? undefined : id
}

async function allowed(c: Context): Promise<boolean> {
  const uid = getUserId(c)
  if (!uid) return false
  const [roleRows, u] = await Promise.all([
    db.select({ role: userRoles.role }).from(userRoles).where(eq(userRoles.userId, uid)),
    db.query.users.findFirst({ where: and(eq(users.id, uid), eq(users.propertyId, getPropertyId())), columns: { isPrimary: true } }),
  ])
  const roles = roleRows.map(r => r.role as string)
  return u?.isPrimary === true || roles.includes('direccion') || roles.includes('recepcion')
}

function totalFromCounts(counts: Record<string, number>): number {
  let t = 0
  for (const [k, n] of Object.entries(counts)) t += (DENOM_VALUES[k] ?? 0) * Math.max(0, Math.floor(n))
  return Math.round(t * 100) / 100
}

// Depósitos de garantía en efectivo (paymentMethod='deposit') aún activos —
// ni cobrados (category pasa a 'deposit_cobrado') ni devueltos (fila
// 'deposit_return' con description=`dep:<id>`, misma convención que usa la
// pestaña Depósitos de cada reserva). Preauth/tarjeta (deposit_cc) quedan
// fuera: no son efectivo físico en esta caja. Solo de reservas con huésped en
// casa ahora mismo (status='checked_in') — de checked_out el depósito ya
// debería estar resuelto (lo exige el check-out), y si quedó suelto de antes
// de tener esa comprobación no debe seguir contando aquí.
async function getActiveCashDeposits(): Promise<Array<{
  id: number; amount: string; transactionDate: string; guestName: string; roomCode: string | null; reservationId: number
}>> {
  const pid = getPropertyId()
  const rows = await db.execute(sql`
    WITH cash_dep AS (
      SELECT ft.id, ft.category, ft.description, ft.amount, ft.transaction_date, ft.reservation_id
      FROM financial_transactions ft
      JOIN reservations r ON r.id = ft.reservation_id AND r.status = 'checked_in'
      WHERE ft.payment_method = 'deposit' AND ft.property_id = ${pid} AND r.property_id = ${pid}
    ),
    returned AS (
      SELECT (substring(description from 5))::int AS id
      FROM cash_dep WHERE category = 'deposit_return' AND description LIKE 'dep:%'
    )
    SELECT cd.id, cd.amount, cd.transaction_date, cd.reservation_id,
           COALESCE(g.first_name || ' ' || g.last_name, '—') AS guest_name,
           rm.code AS room_code
    FROM cash_dep cd
    JOIN reservations r ON r.id = cd.reservation_id
    LEFT JOIN guests g ON g.id = r.guest_id
    LEFT JOIN rooms rm ON rm.id = r.room_id
    WHERE cd.category NOT IN ('deposit_return', 'deposit_cobrado')
      AND cd.id NOT IN (SELECT id FROM returned)
    ORDER BY cd.transaction_date DESC, cd.id DESC
  `) as unknown as Array<{ id: number; amount: string; transaction_date: string; reservation_id: number; guest_name: string; room_code: string | null }>
  return rows.map(r => ({
    id: r.id, amount: r.amount, transactionDate: r.transaction_date,
    reservationId: r.reservation_id, guestName: r.guest_name, roomCode: r.room_code,
  }))
}

// GET /api/cash-drawer — estado actual: último arqueo, gastos activos, histórico
app.get('/', async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const pid = getPropertyId()

    const [last, active, history, expenseHistory, activeCashDeposits, depositCheckHistory] = await Promise.all([
      db.query.changeDrawerCounts.findFirst({ where: eq(changeDrawerCounts.propertyId, pid), orderBy: desc(changeDrawerCounts.id) }),
      db.select({
        id: changeDrawerExpenses.id, description: changeDrawerExpenses.description,
        amount: changeDrawerExpenses.amount, createdAt: changeDrawerExpenses.createdAt,
        createdBy: changeDrawerExpenses.createdBy,
      }).from(changeDrawerExpenses).where(and(eq(changeDrawerExpenses.propertyId, pid), isNull(changeDrawerExpenses.replenishedAt)))
        .orderBy(desc(changeDrawerExpenses.id)),
      db.execute(sql`
        SELECT cc.id, cc.counts, cc.total_cash, cc.float_amount, cc.counted_at,
               COALESCE(u.first_name || ' ' || u.last_name, '—') AS counted_by_name
        FROM change_drawer_counts cc
        LEFT JOIN users u ON u.id = cc.counted_by
        WHERE cc.property_id = ${pid}
        ORDER BY cc.id DESC LIMIT 20
      `) as unknown as Promise<any[]>,
      // Histórico completo de gastos (repuestos o no) — cuándo se añadió cada
      // uno, quién lo añadió, y cuándo/quién lo repuso si ya está repuesto.
      db.execute(sql`
        SELECT ce.id, ce.description, ce.amount, ce.created_at, ce.replenished_at,
               COALESCE(cu.first_name || ' ' || cu.last_name, '—') AS created_by_name,
               COALESCE(ru.first_name || ' ' || ru.last_name, NULL) AS replenished_by_name
        FROM change_drawer_expenses ce
        LEFT JOIN users cu ON cu.id = ce.created_by
        LEFT JOIN users ru ON ru.id = ce.replenished_by
        WHERE ce.property_id = ${pid}
        ORDER BY ce.created_at DESC LIMIT 100
      `) as unknown as Promise<any[]>,
      getActiveCashDeposits(),
      // Histórico de discrepancias en la verificación de depósitos — la tabla
      // guarda TODAS las verificaciones (para poder exigir 2 al día, ver
      // alerts.ts), pero este listado es solo de descuadres: se filtran las
      // que no tuvieron ningún depósito sin marcar.
      db.execute(sql`
        SELECT cdc.id, cdc.checked_at, cdc.system_count, cdc.counted_count, cdc.missing_ids,
               COALESCE(u.first_name || ' ' || u.last_name, '—') AS checked_by_name
        FROM change_drawer_deposit_checks cdc
        LEFT JOIN users u ON u.id = cdc.checked_by
        WHERE cdc.property_id = ${pid} AND jsonb_array_length(cdc.missing_ids) > 0
        ORDER BY cdc.id DESC LIMIT 50
      `) as unknown as Promise<any[]>,
    ])

    return c.json({ data: { last: last ?? null, activeExpenses: active, history, expenseHistory, activeCashDeposits, depositCheckHistory } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/cash-drawer/count — guardar arqueo
app.post('/count', zValidator('json', z.object({
  counts:      z.record(z.string(), z.number().int().min(0).max(100000)),
  floatAmount: z.number().min(0).max(100000),
})), async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { counts, floatAmount } = c.req.valid('json')

    // Solo denominaciones conocidas
    const clean: Record<string, number> = {}
    for (const k of Object.keys(DENOM_VALUES)) clean[k] = Math.floor(counts[k] ?? 0)

    const [row] = await db.insert(changeDrawerCounts).values({
      propertyId:  getPropertyId(),
      counts:      clean,
      totalCash:   totalFromCounts(clean).toFixed(2),
      floatAmount: floatAmount.toFixed(2),
      countedBy:   getUserId(c),
    }).returning()

    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

// POST /api/cash-drawer/deposit-check — verificación manual de depósitos en
// efectivo: el frontend manda los ids que ha marcado como contados; el
// servidor recalcula cuáles deberían estar activos (nunca se fía del cliente
// para esto). Se guarda SIEMPRE un registro (haya o no descuadre) — hace
// falta para poder exigir, igual que con el arqueo normal, 2 verificaciones
// al día (ver alertas 'drawer-deposits-missing-first/second' en alerts.ts);
// el aviso de descuadre ('drawer-deposits-mismatch') solo mira las filas con
// missingIds no vacío.
app.post('/deposit-check', zValidator('json', z.object({
  countedIds: z.array(z.number().int().positive()),
})), async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { countedIds } = c.req.valid('json')

    const active = await getActiveCashDeposits()
    const countedSet = new Set(countedIds)
    const missing = active.filter(d => !countedSet.has(d.id))

    const [saved] = await db.insert(changeDrawerDepositChecks).values({
      propertyId:   getPropertyId(),
      systemCount:  active.length,
      countedCount: active.length - missing.length,
      missingIds:   missing.map(d => d.id),
      checkedBy:    getUserId(c),
    }).returning()

    return c.json({ data: { ok: missing.length === 0, missing, saved } })
  } catch (err) { return serverError(c, err) }
})

// POST /api/cash-drawer/expenses — añadir gasto que sale de la caja
app.post('/expenses', zValidator('json', z.object({
  description: z.string().min(1).max(200),
  amount:      z.number().positive().max(10000),
})), async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const { description, amount } = c.req.valid('json')
    const [row] = await db.insert(changeDrawerExpenses).values({
      propertyId: getPropertyId(), description, amount: amount.toFixed(2), createdBy: getUserId(c),
    }).returning()
    return c.json({ data: row }, 201)
  } catch (err) { return serverError(c, err) }
})

// DELETE /api/cash-drawer/expenses/:id — borrar gasto erróneo (solo si no repuesto)
app.delete('/expenses/:id', async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const id = Number(c.req.param('id'))
    const [deleted] = await db.delete(changeDrawerExpenses)
      .where(and(eq(changeDrawerExpenses.id, id), eq(changeDrawerExpenses.propertyId, getPropertyId()), isNull(changeDrawerExpenses.replenishedAt)))
      .returning()
    if (!deleted) return notFound(c, 'Gasto')
    return c.json({ ok: true })
  } catch (err) { return serverError(c, err) }
})

// POST /api/cash-drawer/replenish — reponer: los gastos activos dejan de contar
app.post('/replenish', async (c) => {
  try {
    if (!await allowed(c)) return c.json({ error: 'Sin permisos' }, 403)
    const result = await db.update(changeDrawerExpenses)
      .set({ replenishedAt: new Date(), replenishedBy: getUserId(c) })
      .where(and(eq(changeDrawerExpenses.propertyId, getPropertyId()), isNull(changeDrawerExpenses.replenishedAt)))
      .returning({ id: changeDrawerExpenses.id })
    return c.json({ data: { replenished: result.length } })
  } catch (err) { return serverError(c, err) }
})

export default app
