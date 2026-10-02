INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('breakfast-inventory-stale', 'Inventario de desayunos desactualizado (>4 días o >25 desayunos servidos)')
ON CONFLICT DO NOTHING;
