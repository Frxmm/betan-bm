ALTER TABLE "staff_messages" ADD COLUMN IF NOT EXISTS "important" boolean NOT NULL DEFAULT false;
ALTER TABLE "staff_messages" ADD COLUMN IF NOT EXISTS "acknowledged_at" timestamptz;
