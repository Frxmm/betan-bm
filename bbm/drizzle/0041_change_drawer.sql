-- Caja de cambio: arqueos por denominación + gastos pendientes de reponer
CREATE TABLE IF NOT EXISTS "change_drawer_counts" (
  "id"           serial PRIMARY KEY,
  "property_id"  integer NOT NULL DEFAULT 1 REFERENCES "properties"("id"),
  -- { "c5": 12, "c10": 40, ..., "b100": 2 } — unidades por denominación
  "counts"       jsonb NOT NULL DEFAULT '{}',
  "total_cash"   numeric(10,2) NOT NULL DEFAULT 0,
  -- Importe de consigna de la caja (p.ej. 500 €)
  "float_amount" numeric(10,2) NOT NULL DEFAULT 500,
  "counted_by"   integer REFERENCES "users"("id"),
  "counted_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "change_drawer_expenses" (
  "id"             serial PRIMARY KEY,
  "property_id"    integer NOT NULL DEFAULT 1 REFERENCES "properties"("id"),
  "description"    text NOT NULL,
  "amount"         numeric(10,2) NOT NULL,
  "created_by"     integer REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  -- NULL = gasto pendiente de reponer (cuenta para cuadrar la consigna)
  "replenished_at" timestamptz,
  "replenished_by" integer REFERENCES "users"("id")
);

CREATE INDEX IF NOT EXISTS "change_drawer_expenses_active_idx"
  ON "change_drawer_expenses"("replenished_at") WHERE "replenished_at" IS NULL;
