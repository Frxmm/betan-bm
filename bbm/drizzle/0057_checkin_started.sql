ALTER TABLE reservations ADD COLUMN IF NOT EXISTS checkin_started_at TIMESTAMPTZ;
