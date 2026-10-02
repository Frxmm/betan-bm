ALTER TABLE "guests" ADD COLUMN "guest_rating" smallint;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "hotel_rating" smallint;--> statement-breakpoint
ALTER TABLE "reservations" ADD COLUMN "operator_id" integer REFERENCES "operators"("id");
