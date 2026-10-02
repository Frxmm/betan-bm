-- Añade room_type_id a rate_daily_prices para precios independientes por tipo de habitación
ALTER TABLE "rate_daily_prices" DROP CONSTRAINT IF EXISTS "rate_daily_prices_rate_id_date_unique";

ALTER TABLE "rate_daily_prices" ADD COLUMN IF NOT EXISTS "room_type_id" integer REFERENCES "room_types"("id") ON DELETE CASCADE;

-- NULLS NOT DISTINCT: dos filas con room_type_id=NULL se consideran iguales (PG 15+)
ALTER TABLE "rate_daily_prices"
  ADD CONSTRAINT "rate_daily_prices_rate_date_rt_unique"
  UNIQUE NULLS NOT DISTINCT ("rate_id", "date", "room_type_id");
