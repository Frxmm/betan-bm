INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('laundry-process-missing', 'Procesado de lavandería sin declarar (16:30–19:00)')
ON CONFLICT DO NOTHING;
