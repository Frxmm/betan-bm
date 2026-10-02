// Ajustes de promociones web por tenant (singletons con property_id único).
// Úsalos en lugar de `select().from(xSettings).limit(1)`: devuelven (y crean con
// valores por defecto si falta) la fila del tenant actual.
import { eq } from 'drizzle-orm'
import { db } from '../db'
import {
  cartRecoverySettings, cancellationRecoverySettings, temporaryDiscountSettings,
} from '../db/schema'
import { getPropertyId } from './property'

export async function getCartRecoverySettings() {
  const pid = getPropertyId()
  let [row] = await db.select().from(cartRecoverySettings).where(eq(cartRecoverySettings.propertyId, pid)).limit(1)
  if (!row) {
    ;[row] = await db.insert(cartRecoverySettings).values({ propertyId: pid }).onConflictDoNothing().returning()
    if (!row) [row] = await db.select().from(cartRecoverySettings).where(eq(cartRecoverySettings.propertyId, pid)).limit(1)
  }
  return row!
}

export async function getCancellationRecoverySettings() {
  const pid = getPropertyId()
  let [row] = await db.select().from(cancellationRecoverySettings).where(eq(cancellationRecoverySettings.propertyId, pid)).limit(1)
  if (!row) {
    ;[row] = await db.insert(cancellationRecoverySettings).values({ propertyId: pid }).onConflictDoNothing().returning()
    if (!row) [row] = await db.select().from(cancellationRecoverySettings).where(eq(cancellationRecoverySettings.propertyId, pid)).limit(1)
  }
  return row!
}

export async function getTemporaryDiscountSettings() {
  const pid = getPropertyId()
  let [row] = await db.select().from(temporaryDiscountSettings).where(eq(temporaryDiscountSettings.propertyId, pid)).limit(1)
  if (!row) {
    ;[row] = await db.insert(temporaryDiscountSettings).values({ propertyId: pid }).onConflictDoNothing().returning()
    if (!row) [row] = await db.select().from(temporaryDiscountSettings).where(eq(temporaryDiscountSettings.propertyId, pid)).limit(1)
  }
  return row!
}

// Upserts por tenant (patch parcial)
export async function patchCartRecoverySettings(patch: Record<string, any>) {
  const row = await getCartRecoverySettings()
  const [r] = await db.update(cartRecoverySettings).set(patch).where(eq(cartRecoverySettings.id, row.id)).returning()
  return r!
}
export async function patchCancellationRecoverySettings(patch: Record<string, any>) {
  const row = await getCancellationRecoverySettings()
  const [r] = await db.update(cancellationRecoverySettings).set(patch).where(eq(cancellationRecoverySettings.id, row.id)).returning()
  return r!
}
export async function patchTemporaryDiscountSettings(patch: Record<string, any>) {
  const row = await getTemporaryDiscountSettings()
  const [r] = await db.update(temporaryDiscountSettings).set(patch).where(eq(temporaryDiscountSettings.id, row.id)).returning()
  return r!
}
