CREATE TABLE IF NOT EXISTS "alert_configs" (
  "alert_type" TEXT PRIMARY KEY,
  "label"      TEXT NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT TRUE,
  "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

INSERT INTO "alert_configs" ("alert_type", "label") VALUES
  ('breakfast-unconfirmed',  'Desayunos sin confirmar (11:00–13:00)'),
  ('hk-unassigned',          'Habitaciones de limpieza sin asignar (desde 12:00)'),
  ('drawer-missing-first',   'Primer arqueo de caja pendiente (desde 15:15)'),
  ('drawer-missing-second',  'Segundo arqueo de caja pendiente (desde 23:15)'),
  ('drawer-mismatch',        'Descuadre en caja de cambio'),
  ('checkout-pending',       'Check-out pendiente después de las 14:00'),
  ('unpaid-reservation',     'Reservas en el hotel sin cobrar'),
  ('zero-total-reservation', 'Reservas con total 0 €'),
  ('stolen-items',           'Posibles objetos robados marcados'),
  ('checkin-abandoned',      'Check-in abandonado hoy')
ON CONFLICT DO NOTHING;
