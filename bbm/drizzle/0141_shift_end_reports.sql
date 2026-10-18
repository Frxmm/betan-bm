CREATE TABLE IF NOT EXISTS shift_end_reports (
  id SERIAL PRIMARY KEY,
  property_id INTEGER NOT NULL REFERENCES properties(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_date TEXT NOT NULL,
  shift_start TIMESTAMPTZ NOT NULL,
  shift_end TIMESTAMPTZ NOT NULL,
  total_points INTEGER NOT NULL,
  breakdown JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, shift_start)
);

CREATE INDEX IF NOT EXISTS shift_end_reports_user_idx ON shift_end_reports (user_id, shift_start DESC);
