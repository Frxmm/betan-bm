CREATE TABLE IF NOT EXISTS engagement_adjustments (
  id         serial PRIMARY KEY,
  user_id    integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  points     integer NOT NULL,
  reason     text,
  created_by integer REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS engagement_adjustments_user_idx ON engagement_adjustments (user_id, created_at);
