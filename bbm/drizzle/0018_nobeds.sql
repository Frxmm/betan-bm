ALTER TABLE "room_types" ADD COLUMN IF NOT EXISTS "nobeds_room_id" integer;
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "nobeds_order_id" integer;
