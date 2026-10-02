CREATE TABLE IF NOT EXISTS "fdm_push_state" (
  "id"              serial PRIMARY KEY,
  "property_id"     integer NOT NULL REFERENCES "properties"("id"),
  "date"            date NOT NULL,
  "fdm_rate_id"     integer NOT NULL,
  "fdm_room_use_id" integer NOT NULL,
  "price"           numeric(10, 2) NOT NULL,
  "avail"           integer NOT NULL,
  "closed"          boolean NOT NULL DEFAULT false,
  "pushed_at"       timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("property_id", "date", "fdm_rate_id", "fdm_room_use_id")
);
