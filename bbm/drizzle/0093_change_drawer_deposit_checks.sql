CREATE TABLE "change_drawer_deposit_checks" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer DEFAULT 1 NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_by" integer,
	"system_count" integer NOT NULL,
	"counted_count" integer NOT NULL,
	"missing_ids" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "change_drawer_deposit_checks" ADD CONSTRAINT "change_drawer_deposit_checks_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "change_drawer_deposit_checks" ADD CONSTRAINT "change_drawer_deposit_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
