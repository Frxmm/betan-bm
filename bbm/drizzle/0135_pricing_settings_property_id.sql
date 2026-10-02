-- Singletons de promociones web pasan a ser por tenant (property_id).
-- Las filas existentes quedan con property_id = 1 (DEFAULT) y se garantiza una por tenant.
ALTER TABLE cart_recovery_settings ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1;
ALTER TABLE cart_recovery_settings DROP CONSTRAINT IF EXISTS cart_recovery_settings_property_id_unique;
ALTER TABLE cart_recovery_settings ADD CONSTRAINT cart_recovery_settings_property_id_unique UNIQUE (property_id);

ALTER TABLE cancellation_recovery_settings ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1;
ALTER TABLE cancellation_recovery_settings DROP CONSTRAINT IF EXISTS cancellation_recovery_settings_property_id_unique;
ALTER TABLE cancellation_recovery_settings ADD CONSTRAINT cancellation_recovery_settings_property_id_unique UNIQUE (property_id);

ALTER TABLE temporary_discount_settings ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1;
ALTER TABLE temporary_discount_settings DROP CONSTRAINT IF EXISTS temporary_discount_settings_property_id_unique;
ALTER TABLE temporary_discount_settings ADD CONSTRAINT temporary_discount_settings_property_id_unique UNIQUE (property_id);
