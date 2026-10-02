CREATE TABLE IF NOT EXISTS corporate_offers (
  id             serial PRIMARY KEY,
  property_id    integer NOT NULL REFERENCES properties(id),
  company_name   text NOT NULL,
  company_nif    text,
  room_type_id   integer REFERENCES room_types(id),
  weekly_price   numeric(10,2) NOT NULL,
  valid_from     date NOT NULL,
  valid_to       date NOT NULL,
  notes          text,
  status         text NOT NULL DEFAULT 'draft',  -- draft | sent | accepted | rejected | expired
  created_by     integer REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz,
  decided_at     timestamptz
);
CREATE INDEX IF NOT EXISTS corporate_offers_status_idx ON corporate_offers (status, valid_to);

CREATE TABLE IF NOT EXISTS breakfast_service_ratings (
  date     text PRIMARY KEY,
  rating   integer NOT NULL,
  notes    text,
  rated_at timestamptz NOT NULL DEFAULT now(),
  rated_by integer
);
