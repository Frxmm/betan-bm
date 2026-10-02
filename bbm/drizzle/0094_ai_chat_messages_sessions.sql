ALTER TABLE "ai_chat_messages" ADD COLUMN "session_id" text;
--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD COLUMN "source" text DEFAULT 'chat' NOT NULL;
