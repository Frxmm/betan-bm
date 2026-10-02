ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "default_calendar_rate_ids" jsonb;
ALTER TABLE "properties" ADD COLUMN IF NOT EXISTS "default_calendar_room_type_ids" jsonb;
