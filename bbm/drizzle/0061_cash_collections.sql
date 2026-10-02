CREATE TABLE IF NOT EXISTS cash_collections (
  id           SERIAL PRIMARY KEY,
  property_id  INTEGER NOT NULL REFERENCES properties(id),
  collected_by INTEGER NOT NULL REFERENCES users(id),
  collected_at TIMESTAMPTZ NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
