ALTER TABLE reservations
  ADD COLUMN IF NOT EXISTS checkin_had_contract    boolean,
  ADD COLUMN IF NOT EXISTS checkin_zkteco_enrolled boolean,
  ADD COLUMN IF NOT EXISTS checkin_ses_sent        boolean;
