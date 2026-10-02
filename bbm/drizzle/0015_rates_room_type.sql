ALTER TABLE "rates" ADD COLUMN "room_type_id" integer REFERENCES "room_types"("id") ON DELETE SET NULL;
