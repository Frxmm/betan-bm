CREATE TYPE "public"."bathroom_type" AS ENUM('shower', 'bathtub', 'both');--> statement-breakpoint
CREATE TYPE "public"."bed_size" AS ENUM('single', 'twin', 'double', 'queen', 'king', 'bunk');--> statement-breakpoint
CREATE TYPE "public"."terrace_type" AS ENUM('private', 'shared', 'none');--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "bathroom" "bathroom_type";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "terrace" "terrace_type";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "balcony" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "bed_size" "bed_size";--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "room_size_sqm" numeric(6, 1);--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "view_sea" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "view_pool" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "view_interior" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "lock_type" text;