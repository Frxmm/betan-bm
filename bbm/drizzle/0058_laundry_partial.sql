-- Procesado parcial: el batch pertenece a un receptor específico
ALTER TABLE laundry_process_batches ADD COLUMN IF NOT EXISTS recipient_id INTEGER;

-- Confirmación de recepción por el receptor
ALTER TABLE laundry_deliveries ADD COLUMN IF NOT EXISTS recipient_status TEXT;
ALTER TABLE laundry_deliveries ADD COLUMN IF NOT EXISTS recipient_note TEXT;
ALTER TABLE laundry_deliveries ADD COLUMN IF NOT EXISTS recipient_confirmed_at TIMESTAMPTZ;
