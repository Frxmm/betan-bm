ALTER TABLE "abandoned_carts" ADD COLUMN "email_error" text;
ALTER TABLE "abandoned_carts" ADD COLUMN "whatsapp_sent_at" timestamp with time zone;
ALTER TABLE "abandoned_carts" ADD COLUMN "whatsapp_error" text;
