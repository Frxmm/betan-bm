ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "id_doc_scanned_at" timestamp with time zone;
ALTER TABLE "guests" ADD COLUMN IF NOT EXISTS "id_doc_scanned_by" integer REFERENCES "users"("id");
