ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "clearance_start_hour" integer NOT NULL DEFAULT 20;
