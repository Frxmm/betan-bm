CREATE TABLE "operators" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"logo_url" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_daily_prices" (
	"id" serial PRIMARY KEY NOT NULL,
	"property_id" integer NOT NULL,
	"rate_id" integer NOT NULL,
	"date" date NOT NULL,
	"price" numeric(10, 2) NOT NULL,
	"closed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"theme" text DEFAULT 'dark' NOT NULL,
	"font_family" text DEFAULT 'system' NOT NULL,
	"font_size" integer DEFAULT 14 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_preferences_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "date_of_birth" date;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "nationality" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "id_doc_expiry_date" date;--> statement-breakpoint
ALTER TABLE "rates" ADD COLUMN "user_editable" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "rates" ADD COLUMN "locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rates" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "rates" ADD COLUMN "locked_by" integer;--> statement-breakpoint
ALTER TABLE "rates" ADD COLUMN "operator_id" integer;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_daily_prices" ADD CONSTRAINT "rate_daily_prices_property_id_properties_id_fk" FOREIGN KEY ("property_id") REFERENCES "public"."properties"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rate_daily_prices" ADD CONSTRAINT "rate_daily_prices_rate_id_rates_id_fk" FOREIGN KEY ("rate_id") REFERENCES "public"."rates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rates" ADD CONSTRAINT "rates_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rates" ADD CONSTRAINT "rates_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE no action ON UPDATE no action;