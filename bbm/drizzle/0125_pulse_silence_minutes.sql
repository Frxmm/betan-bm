ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "pulse_silence_minutes" integer NOT NULL DEFAULT 240;
