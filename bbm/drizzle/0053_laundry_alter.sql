-- Lavandería: añade toalla de manos y cambia delivered_to (text) por delivered_to_id (FK a users)
ALTER TABLE laundry_deliveries
  ADD COLUMN hand_towels    smallint NOT NULL DEFAULT 0,
  ADD COLUMN delivered_to_id integer,
  DROP COLUMN delivered_to;

-- Si la tabla ya tiene filas, asigna un id de usuario temporal antes de poner NOT NULL
-- UPDATE laundry_deliveries SET delivered_to_id = <id_usuario> WHERE delivered_to_id IS NULL;

ALTER TABLE laundry_deliveries
  ALTER COLUMN delivered_to_id SET NOT NULL;
