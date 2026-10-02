-- Tipo de precio para extras en booking engine
-- per_stay: precio fijo por reserva
-- per_night: precio × noches
-- per_person: precio × personas
-- per_person_night: precio × personas × noches
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS pricing_type text NOT NULL DEFAULT 'per_stay';
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS max_quantity smallint NOT NULL DEFAULT 1;
