ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "clearance_override_minutes" integer NOT NULL DEFAULT 60;
