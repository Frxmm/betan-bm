ALTER TABLE laundry_deliveries
  ADD COLUMN IF NOT EXISTS discrepancy_ack_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discrepancy_ack_by INTEGER REFERENCES users(id);
