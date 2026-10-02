-- Renombra las columnas de criterios de cart_recovery_settings a la nueva semántica:
-- de checks de "dato faltante en el perfil" a checks contra la BD de huéspedes
ALTER TABLE cart_recovery_settings
  RENAME COLUMN target_no_phone    TO target_new_phone;

ALTER TABLE cart_recovery_settings
  RENAME COLUMN target_no_real_name TO target_new_name;

ALTER TABLE cart_recovery_settings
  RENAME COLUMN target_alias_email  TO target_first_time;
