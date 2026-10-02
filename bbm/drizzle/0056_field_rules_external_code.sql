INSERT INTO reservation_field_rules (field_key, label, allowed_roles, allowed_channel_ids)
VALUES ('external_code', 'Código externo', '[]', '[]')
ON CONFLICT (field_key) DO NOTHING;
