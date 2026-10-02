CREATE TABLE IF NOT EXISTS "breakfast_no_service" (
  "date"      TEXT PRIMARY KEY,
  "marked_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  "marked_by" INTEGER REFERENCES "users"("id")
);
