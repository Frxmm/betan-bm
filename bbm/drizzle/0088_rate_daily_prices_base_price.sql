ALTER TABLE "rate_daily_prices" ADD COLUMN "base_price" numeric(10, 2);
-- Backfill: los precios ya puestos a mano se convierten en su propio base,
-- para que el motor de reglas no los interprete como "sin base configurada".
UPDATE "rate_daily_prices" SET "base_price" = "price" WHERE "base_price" IS NULL;
