CREATE TABLE "price_change_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"rate_id" integer NOT NULL,
	"room_type_id" integer,
	"date" date NOT NULL,
	"old_price" numeric(10, 2),
	"new_price" numeric(10, 2),
	"closed" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"changed_by_user_id" integer,
	"rule_id" integer,
	"batch_id" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "price_change_log" ADD CONSTRAINT "price_change_log_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_change_log" ADD CONSTRAINT "price_change_log_rate_id_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."rates"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_change_log" ADD CONSTRAINT "price_change_log_changed_by_user_id_users_id_fk" FOREIGN KEY ("changed_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "price_change_log" ADD CONSTRAINT "price_change_log_rule_id_pricing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."pricing_rules"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "price_change_log_date_idx" ON "price_change_log" USING btree ("date");
--> statement-breakpoint
CREATE INDEX "price_change_log_changed_at_idx" ON "price_change_log" USING btree ("changed_at");
