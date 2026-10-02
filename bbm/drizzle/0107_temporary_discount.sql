CREATE TABLE "temporary_discount_settings" (
  "id"                 serial PRIMARY KEY,
  "enabled"            boolean NOT NULL DEFAULT false,
  "activation_minutes" integer NOT NULL DEFAULT 5,
  "window_minutes"     integer NOT NULL DEFAULT 30,
  "discount_pct"       integer NOT NULL DEFAULT 10,
  "updated_at"         timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "booking_discount_timers" (
  "id"             serial PRIMARY KEY,
  "token"          text NOT NULL UNIQUE,
  "email"          text NOT NULL,
  "first_name"     text,
  "last_name"      text,
  "started_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "used_at"        timestamp with time zone,
  "reservation_id" integer REFERENCES "reservations"("id")
);
