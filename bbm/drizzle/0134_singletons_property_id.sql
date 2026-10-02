-- Multi-tenant: las 4 tablas "singleton" (+ alert_seen_marks) pasan a ser por tenant.
-- NO aplicar automáticamente: lo ejecuta el usuario.
-- Backfill: DEFAULT 1 = el tenant existente (el primer hotel, propertyId=1).
-- TODO: tras verificar que no hay inserts sin property_id, quitar el DEFAULT 1 de las columnas añadidas aquí:
--   ALTER TABLE <tabla> ALTER COLUMN property_id DROP DEFAULT;

-- message_settings: PK (key) -> (property_id, key)
ALTER TABLE message_settings ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE message_settings DROP CONSTRAINT IF EXISTS message_settings_pkey;
ALTER TABLE message_settings ADD PRIMARY KEY (property_id, key);

-- message_templates: PK (key) -> (property_id, key)
ALTER TABLE message_templates ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_pkey;
ALTER TABLE message_templates ADD PRIMARY KEY (property_id, key);

-- alert_configs: PK (alert_type) -> (property_id, alert_type)
ALTER TABLE alert_configs ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE alert_configs DROP CONSTRAINT IF EXISTS alert_configs_pkey;
ALTER TABLE alert_configs ADD PRIMARY KEY (property_id, alert_type);

-- alert_seen_marks: PK (alert_type) -> (property_id, alert_type)
ALTER TABLE alert_seen_marks ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE alert_seen_marks DROP CONSTRAINT IF EXISTS alert_seen_marks_pkey;
ALTER TABLE alert_seen_marks ADD PRIMARY KEY (property_id, alert_type);

-- reservation_field_rules: UNIQUE (field_key) -> UNIQUE (property_id, field_key)
ALTER TABLE reservation_field_rules ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE reservation_field_rules DROP CONSTRAINT IF EXISTS reservation_field_rules_field_key_key;
ALTER TABLE reservation_field_rules DROP CONSTRAINT IF EXISTS reservation_field_rules_field_key_unique;
ALTER TABLE reservation_field_rules DROP CONSTRAINT IF EXISTS reservation_field_rules_property_field_uniq;
ALTER TABLE reservation_field_rules ADD CONSTRAINT reservation_field_rules_property_field_uniq UNIQUE (property_id, field_key);

CREATE INDEX IF NOT EXISTS message_settings_property_idx        ON message_settings (property_id);
CREATE INDEX IF NOT EXISTS message_templates_property_idx       ON message_templates (property_id);
CREATE INDEX IF NOT EXISTS alert_configs_property_idx           ON alert_configs (property_id);
CREATE INDEX IF NOT EXISTS reservation_field_rules_property_idx ON reservation_field_rules (property_id);

-- common_area_tasks: UNIQUE (date, area_key) -> UNIQUE (property_id, date, area_key)
ALTER TABLE common_area_tasks DROP CONSTRAINT IF EXISTS common_area_tasks_date_area_key_key;
ALTER TABLE common_area_tasks DROP CONSTRAINT IF EXISTS common_area_tasks_property_date_area_uniq;
ALTER TABLE common_area_tasks ADD CONSTRAINT common_area_tasks_property_date_area_uniq UNIQUE (property_id, date, area_key);

-- breakfast_no_service y breakfast_service_ratings: PK (date) -> (property_id, date)
ALTER TABLE breakfast_no_service ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE breakfast_no_service DROP CONSTRAINT IF EXISTS breakfast_no_service_pkey;
ALTER TABLE breakfast_no_service ADD PRIMARY KEY (property_id, date);

ALTER TABLE breakfast_service_ratings ADD COLUMN IF NOT EXISTS property_id integer NOT NULL DEFAULT 1 REFERENCES properties(id);
ALTER TABLE breakfast_service_ratings DROP CONSTRAINT IF EXISTS breakfast_service_ratings_pkey;
ALTER TABLE breakfast_service_ratings ADD PRIMARY KEY (property_id, date);
