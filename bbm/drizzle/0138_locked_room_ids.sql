ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "locked_room_ids" jsonb NOT NULL DEFAULT '[]';
