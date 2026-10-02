CREATE TABLE IF NOT EXISTS "jumbo_push_state" (
  "id"          serial PRIMARY KEY,
  "property_id" integer NOT NULL REFERENCES "properties"("id"),
  "date"        date NOT NULL,
  "price"       numeric(10, 2) NOT NULL,
  "pushed_at"   timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("property_id", "date")
);

-- La columna jumbo_pushed_at de rate_daily_prices (migración 0119) queda sin
-- uso: el enfoque de comparar solo la celda raíz de Dir AL no detectaba una
-- edición manual hecha directamente sobre la tarifa JUMBO AL. Se sustituye
-- por esta tabla (comparación por valor, no por timestamp) — ver
-- src/lib/jumbo-push.ts. No se borra la columna para no arriesgar si ya se
-- aplicó esa migración en producción; simplemente deja de leerse/escribirse.
