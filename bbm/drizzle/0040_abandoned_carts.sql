-- Carritos abandonados del booking engine: registro para informes + recuperación
-- por email con descuento transitorio.
CREATE TABLE IF NOT EXISTS "abandoned_carts" (
  "id"                       serial PRIMARY KEY,
  "reservation_id"           integer NOT NULL UNIQUE REFERENCES "reservations"("id"),
  "email"                    text,
  "guest_name"               text,
  "amount"                   numeric(10,2) NOT NULL DEFAULT 0,
  "check_in"                 date,
  "check_out"                date,
  "room_type_id"             integer,
  -- Recuperación
  "recovery_token"           text UNIQUE,
  "discount_pct"             integer NOT NULL DEFAULT 10,
  "email_sent_at"            timestamptz,
  "expires_at"               timestamptz,
  "recovered_at"             timestamptz,
  "recovered_amount"         numeric(10,2),
  "created_at"               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "abandoned_carts_created_idx" ON "abandoned_carts"("created_at");
