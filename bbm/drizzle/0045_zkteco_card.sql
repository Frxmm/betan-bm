ALTER TABLE "reservations"
  ADD COLUMN IF NOT EXISTS "zkteco_card_no"      TEXT,
  ADD COLUMN IF NOT EXISTS "zkteco_enrolled_at"  TIMESTAMPTZ;
