ALTER TABLE room_types
  ADD COLUMN IF NOT EXISTS max_occupancy_booking_engine SMALLINT;
