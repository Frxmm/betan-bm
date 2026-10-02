ALTER TABLE "financial_transactions" ADD COLUMN "comment" text;
--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD COLUMN "collected_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD COLUMN "paid_by_user_id" integer;
--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "payment_date_corrections" (
	"id" serial PRIMARY KEY NOT NULL,
	"transaction_id" integer NOT NULL,
	"reservation_id" integer,
	"comment" text NOT NULL,
	"previous_transaction_date" date NOT NULL,
	"previous_created_by" integer,
	"corrected_at" timestamp with time zone NOT NULL,
	"paid_by_user_id" integer NOT NULL,
	"fixed_by" integer,
	"fixed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" ADD CONSTRAINT "payment_date_corrections_transaction_id_financial_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."financial_transactions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" ADD CONSTRAINT "payment_date_corrections_reservation_id_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."reservations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" ADD CONSTRAINT "payment_date_corrections_previous_created_by_users_id_fk" FOREIGN KEY ("previous_created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" ADD CONSTRAINT "payment_date_corrections_paid_by_user_id_users_id_fk" FOREIGN KEY ("paid_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_date_corrections" ADD CONSTRAINT "payment_date_corrections_fixed_by_users_id_fk" FOREIGN KEY ("fixed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "payment_date_corrections_transaction_idx" ON "payment_date_corrections" USING btree ("transaction_id");
