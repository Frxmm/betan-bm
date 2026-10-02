CREATE TABLE IF NOT EXISTS reservation_field_rules (
  id           SERIAL PRIMARY KEY,
  field_key    TEXT NOT NULL UNIQUE,
  label        TEXT NOT NULL,
  allowed_roles       JSONB NOT NULL DEFAULT '[]',
  allowed_channel_ids JSONB NOT NULL DEFAULT '[]',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO reservation_field_rules (field_key, label, allowed_roles, allowed_channel_ids)
VALUES
  ('price',   'Precio total',     '[]', '[]'),
  ('channel', 'Canal de reserva', '[]', '[]')
ON CONFLICT (field_key) DO NOTHING;
