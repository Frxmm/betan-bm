-- Contratos de admisión de huésped firmados en el móvil
CREATE TABLE IF NOT EXISTS "guest_contracts" (
  "id"             serial PRIMARY KEY,
  "property_id"    integer NOT NULL REFERENCES "properties"("id"),
  "reservation_id" integer NOT NULL REFERENCES "reservations"("id"),
  "guest_id"       integer NOT NULL REFERENCES "guests"("id"),
  "token"          text NOT NULL UNIQUE,
  -- pending | signed | cancelled
  "status"         text NOT NULL DEFAULT 'pending',
  -- HTML autocontenido del contrato firmado (firma embebida en base64)
  "contract_html"  text,
  "signed_at"      timestamptz,
  "signed_ip"      text,
  "expires_at"     timestamptz NOT NULL,
  "created_by"     integer REFERENCES "users"("id"),
  "created_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "guest_contracts_reservation_idx" ON "guest_contracts"("reservation_id");
