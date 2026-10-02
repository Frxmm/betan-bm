CREATE TABLE IF NOT EXISTS "room_avail_overrides" (
  "id"           serial PRIMARY KEY,
  "property_id"  integer NOT NULL REFERENCES "properties"("id"),
  "room_type_id" integer NOT NULL REFERENCES "room_types"("id") ON DELETE CASCADE,
  "date"         date NOT NULL,
  "max_avail"    integer NOT NULL,
  "created_at"   timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"   timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "room_avail_overrides_rt_date_unique" UNIQUE("room_type_id", "date")
);
