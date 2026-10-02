CREATE TABLE "ai_scheduled_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"created_by" integer NOT NULL,
	"prompt" text NOT NULL,
	"interval_days" integer DEFAULT 1 NOT NULL,
	"time_window_start" text DEFAULT '09:00' NOT NULL,
	"time_window_end" text DEFAULT '20:00' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_result" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_scheduled_tasks" ADD CONSTRAINT "ai_scheduled_tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
