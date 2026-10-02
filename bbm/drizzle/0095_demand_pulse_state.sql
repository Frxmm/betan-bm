CREATE TABLE "demand_pulse_state" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"rule_id" integer NOT NULL,
	"date" date NOT NULL,
	"discount_pct" numeric(5, 2) DEFAULT '0' NOT NULL,
	"silence_start_at" timestamp with time zone,
	"bookings_seen_total" integer DEFAULT 0 NOT NULL,
	"bookings_toward_step" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_pulse_state" ADD CONSTRAINT "demand_pulse_state_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "demand_pulse_state" ADD CONSTRAINT "demand_pulse_state_rule_id_pricing_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."pricing_rules"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "demand_pulse_state_rule_date_idx" ON "demand_pulse_state" USING btree ("rule_id","date");
