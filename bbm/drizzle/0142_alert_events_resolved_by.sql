ALTER TABLE "alert_events" ADD COLUMN IF NOT EXISTS "resolved_by" integer REFERENCES "users"("id");
