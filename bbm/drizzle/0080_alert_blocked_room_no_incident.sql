INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('blocked-room-no-incident', 'Habitación bloqueada sin incidencia de mantenimiento abierta')
ON CONFLICT DO NOTHING;
