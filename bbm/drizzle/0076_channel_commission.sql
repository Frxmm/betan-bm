ALTER TABLE "booking_channels" ADD COLUMN IF NOT EXISTS "commission_pct" NUMERIC(5,2);

-- Booking.com por defecto al 15% — se puede ajustar luego desde
-- Informes → Comisiones. Solo se aplica si aún no tenía nada configurado.
UPDATE "booking_channels"
SET "commission_pct" = 15.00
WHERE "name" ILIKE '%booking%' AND "commission_pct" IS NULL;
