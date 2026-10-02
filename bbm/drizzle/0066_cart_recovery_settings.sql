CREATE TABLE IF NOT EXISTS cart_recovery_settings (
  id               serial PRIMARY KEY,
  enabled          boolean NOT NULL DEFAULT true,
  min_age_min      integer NOT NULL DEFAULT 20,
  max_age_hours    integer NOT NULL DEFAULT 24,
  validity_hours   integer NOT NULL DEFAULT 24,
  discount_tiers   jsonb   NOT NULL DEFAULT '[{"threshold":3500,"pct":25},{"threshold":2000,"pct":20},{"threshold":1000,"pct":15},{"threshold":0,"pct":10}]',
  -- Criterios de cliente nuevo (AND: todos los activos deben cumplirse)
  target_new_phone    boolean NOT NULL DEFAULT true,  -- teléfono no existe en ningún otro huésped
  target_new_name     boolean NOT NULL DEFAULT true,  -- nombre+apellido normalizados no existen en ningún otro huésped
  target_first_time   boolean NOT NULL DEFAULT true,  -- sin reservas anteriores completadas
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Fila inicial con los valores por defecto
INSERT INTO cart_recovery_settings DEFAULT VALUES
  ON CONFLICT DO NOTHING;
