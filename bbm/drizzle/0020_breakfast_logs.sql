CREATE TABLE IF NOT EXISTS "breakfast_logs" (
  "id"             SERIAL PRIMARY KEY,
  "reservation_id" INTEGER NOT NULL REFERENCES "reservations"("id"),
  "date"           DATE NOT NULL,
  "extra_id"       INTEGER REFERENCES "reservation_sale_items"("id"),
  "served_at"      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "served_by"      INTEGER REFERENCES "users"("id")
);
-- Un log por reserva/día para desayunos de tarifa (extra_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS "bf_logs_rate_unique"
  ON "breakfast_logs" ("reservation_id", "date")
  WHERE "extra_id" IS NULL;
-- Un log por reserva/día/extra para desayunos de extra
CREATE UNIQUE INDEX IF NOT EXISTS "bf_logs_extra_unique"
  ON "breakfast_logs" ("reservation_id", "date", "extra_id")
  WHERE "extra_id" IS NOT NULL;
