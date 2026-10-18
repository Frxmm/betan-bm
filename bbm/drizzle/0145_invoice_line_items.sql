ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "line_items" jsonb;
