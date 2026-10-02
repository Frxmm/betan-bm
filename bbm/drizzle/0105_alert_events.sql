CREATE TABLE "alert_events" (
  "id"             serial PRIMARY KEY,
  "property_id"    integer NOT NULL REFERENCES "properties"("id"),
  "alert_type"     text NOT NULL,
  "entity_key"     text NOT NULL,
  "message"        text NOT NULL,
  "severity"       text NOT NULL DEFAULT 'urgent',
  "reservation_id" integer REFERENCES "reservations"("id"),
  "audience_role"  text,
  "first_seen_at"  timestamp with time zone NOT NULL DEFAULT now(),
  "last_seen_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "resolved_at"    timestamp with time zone,
  "silenced_at"    timestamp with time zone,
  "silenced_by"    integer REFERENCES "users"("id"),
  "created_by"     integer REFERENCES "users"("id")
);

-- Búsqueda de la fila abierta de una alerta concreta (entityKey), y listados
-- por rango de fechas en la vista Alertas.
CREATE INDEX "alert_events_open_idx" ON "alert_events" ("entity_key") WHERE "resolved_at" IS NULL;
CREATE INDEX "alert_events_first_seen_idx" ON "alert_events" ("first_seen_at");
