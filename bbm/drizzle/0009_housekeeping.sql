CREATE TABLE "housekeeping_tasks" (
  "id"             serial PRIMARY KEY NOT NULL,
  "property_id"    integer NOT NULL,
  "date"           text NOT NULL,
  "room_id"        integer NOT NULL,
  "task_type"      text DEFAULT 'stay' NOT NULL,
  "assigned_to"    integer,
  "status"         text DEFAULT 'pending' NOT NULL,
  "linen_changes"  text[] DEFAULT '{}' NOT NULL,
  "dnd"            boolean DEFAULT false NOT NULL,
  "notes"          text,
  "completed_at"   timestamp with time zone,
  "completed_by"   integer,
  "created_at"     timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at"     timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "housekeeping_tasks_date_room_id_unique" UNIQUE("date","room_id")
);
ALTER TABLE "housekeeping_tasks"
  ADD CONSTRAINT "housekeeping_tasks_property_id_fk"
  FOREIGN KEY ("property_id") REFERENCES "properties"("id");
ALTER TABLE "housekeeping_tasks"
  ADD CONSTRAINT "housekeeping_tasks_room_id_fk"
  FOREIGN KEY ("room_id") REFERENCES "rooms"("id");
