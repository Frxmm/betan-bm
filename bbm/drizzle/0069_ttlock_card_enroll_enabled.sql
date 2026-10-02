ALTER TABLE properties ADD COLUMN IF NOT EXISTS ttlock_card_enroll_enabled boolean NOT NULL DEFAULT true;
