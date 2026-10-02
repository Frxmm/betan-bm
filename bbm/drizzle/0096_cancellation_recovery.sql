CREATE TABLE "cancellation_recovery_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_age_hours" integer DEFAULT 2 NOT NULL,
	"max_age_hours" integer DEFAULT 12 NOT NULL,
	"validity_hours" integer DEFAULT 48 NOT NULL,
	"discount_pct" integer DEFAULT 15 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cancellation_recoveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"reservation_id" integer NOT NULL,
	"email" text,
	"phone" text,
	"guest_name" text,
	"check_in" date NOT NULL,
	"check_out" date NOT NULL,
	"room_type_id" integer,
	"rate_id" integer,
	"original_amount" numeric(10, 2) NOT NULL,
	"current_amount" numeric(10, 2),
	"base_amount" numeric(10, 2) NOT NULL,
	"discount_pct" integer DEFAULT 15 NOT NULL,
	"discounted_amount" numeric(10, 2) NOT NULL,
	"recovery_token" text,
	"new_reservation_id" integer,
	"email_sent_at" timestamp with time zone,
	"email_error" text,
	"email_skip_reason" text,
	"whatsapp_sent_at" timestamp with time zone,
	"whatsapp_error" text,
	"expires_at" timestamp with time zone,
	"recovered_at" timestamp with time zone,
	"recovered_amount" numeric(10, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cancellation_recoveries_reservation_id_unique" UNIQUE("reservation_id"),
	CONSTRAINT "cancellation_recoveries_recovery_token_unique" UNIQUE("recovery_token")
);
--> statement-breakpoint
ALTER TABLE "cancellation_recoveries" ADD CONSTRAINT "cancellation_recoveries_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "cancellation_recoveries_token_idx" ON "cancellation_recoveries" USING btree ("recovery_token");
