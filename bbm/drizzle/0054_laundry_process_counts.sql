-- Procesado de lavandería normalizado:
--   laundry_process_batches  → un registro por declaración de procesado (puede cubrir varias entregas)
--   laundry_process_items    → filas (item_type, status, count) por batch
--   laundry_deliveries       → añade FK process_batch_id; elimina columnas redundantes de agregado

CREATE TABLE laundry_process_batches (
  id                   serial PRIMARY KEY,
  property_id          integer NOT NULL REFERENCES properties(id),
  date                 text NOT NULL,
  processed_by_id      integer NOT NULL,
  processed_at         timestamp with time zone NOT NULL DEFAULT now(),
  distribution_location text NOT NULL,
  created_at           timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE laundry_process_items (
  id        serial PRIMARY KEY,
  batch_id  integer NOT NULL REFERENCES laundry_process_batches(id) ON DELETE CASCADE,
  item_type text NOT NULL,   -- 'shower' | 'manos' | 'sabanas' | 'pies'
  status    text NOT NULL,   -- 'listas' | 'tendidas' | 'en_agua' | 'sucias'
  count     smallint NOT NULL CHECK (count > 0)
);

ALTER TABLE laundry_deliveries
  DROP COLUMN IF EXISTS listas,
  DROP COLUMN IF EXISTS tendidas,
  DROP COLUMN IF EXISTS en_agua,
  DROP COLUMN IF EXISTS sucias,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS distribution_location,
  ADD COLUMN process_batch_id integer REFERENCES laundry_process_batches(id);
