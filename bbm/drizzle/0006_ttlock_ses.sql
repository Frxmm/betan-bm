ALTER TABLE "rooms" ADD COLUMN IF NOT EXISTS "ttlock_id" text;

ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "ttlock_code"    text;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "ttlock_code_id" text;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "ttlock_sent_at" timestamptz;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "ses_submitted_at" timestamptz;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "ses_locutorio_id" text;
