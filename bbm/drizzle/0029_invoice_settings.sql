CREATE TABLE IF NOT EXISTS invoice_settings (
  id            SERIAL PRIMARY KEY,
  property_id   INTEGER NOT NULL REFERENCES properties(id),
  number_format TEXT    NOT NULL DEFAULT 'F-{YYYY}-{N:4}',
  next_number   INTEGER NOT NULL DEFAULT 1,
  html_template TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
