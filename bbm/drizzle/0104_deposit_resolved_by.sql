ALTER TABLE "financial_transactions" ADD COLUMN "resolved_at" timestamp with time zone;
ALTER TABLE "financial_transactions" ADD COLUMN "resolved_by" integer REFERENCES "users"("id");
