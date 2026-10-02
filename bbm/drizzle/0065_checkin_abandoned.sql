ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS checkin_abandoned_at  timestamptz,
  ADD COLUMN IF NOT EXISTS checkin_abandoned_by  integer REFERENCES users(id);
