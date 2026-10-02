ALTER TABLE "invoices"
  ADD COLUMN IF NOT EXISTS "billing_name"    TEXT,
  ADD COLUMN IF NOT EXISTS "billing_nif"     TEXT,
  ADD COLUMN IF NOT EXISTS "billing_address" TEXT;
