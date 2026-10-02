ALTER TABLE "room_types" ADD COLUMN IF NOT EXISTS "base_room_type_id" integer;
ALTER TABLE "room_types" ADD COLUMN IF NOT EXISTS "adjust_type" text;
ALTER TABLE "room_types" ADD COLUMN IF NOT EXISTS "adjust_value" numeric(10, 2);
