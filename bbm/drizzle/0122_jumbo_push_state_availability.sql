ALTER TABLE "jumbo_push_state" ALTER COLUMN "price" DROP NOT NULL;
ALTER TABLE "jumbo_push_state" ADD COLUMN IF NOT EXISTS "availability" integer;
