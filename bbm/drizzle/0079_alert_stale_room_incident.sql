INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('stale-room-incident', 'Incidencias de habitación abiertas +3 días con cliente dentro')
ON CONFLICT DO NOTHING;
