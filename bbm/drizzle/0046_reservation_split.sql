ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "split_from_reservation_id" integer;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "split_to_reservation_id" integer;
