-- Estancia mínima y máxima por tarifa
ALTER TABLE rates ADD COLUMN IF NOT EXISTS min_stay integer NOT NULL DEFAULT 1;
ALTER TABLE rates ADD COLUMN IF NOT EXISTS max_stay integer;
