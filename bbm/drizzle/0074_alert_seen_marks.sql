CREATE TABLE IF NOT EXISTS "alert_seen_marks" (
  "alert_type" TEXT PRIMARY KEY,
  "seen_at"    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('unassigned-room',       'Reservas sin habitación asignada (check-in ≥ hoy)'),
  ('new-extras-web-directa','Extras nuevos de reservas web directa (hoy/mañana) sin revisar')
ON CONFLICT DO NOTHING;
