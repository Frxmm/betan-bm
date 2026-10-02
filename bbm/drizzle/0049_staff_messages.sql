CREATE TABLE IF NOT EXISTS "staff_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"to_user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"message" text NOT NULL,
	"delivered" boolean NOT NULL DEFAULT false,
	"created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "staff_messages_to_delivered_idx" ON "staff_messages" ("to_user_id", "delivered");
