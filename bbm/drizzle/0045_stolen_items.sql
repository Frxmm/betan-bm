ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "stolen_items_reported_at" timestamptz;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "stolen_items_reported_by" integer REFERENCES "users"("id");
