ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS allowed_methods JSONB;
