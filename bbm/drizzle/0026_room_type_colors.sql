-- Colores en room_types (default) y en rooms (override opcional)
ALTER TABLE room_types
  ADD COLUMN IF NOT EXISTS booking_engine_label TEXT,
  ADD COLUMN IF NOT EXISTS color               CHAR(7),
  ADD COLUMN IF NOT EXISTS background_color    CHAR(7),
  ADD COLUMN IF NOT EXISTS font_color          CHAR(7);

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS color               CHAR(7),
  ADD COLUMN IF NOT EXISTS background_color    CHAR(7),
  ADD COLUMN IF NOT EXISTS font_color          CHAR(7);
