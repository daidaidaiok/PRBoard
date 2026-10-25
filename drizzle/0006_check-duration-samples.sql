CREATE TABLE "check_duration_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"check_name" text NOT NULL,
	"duration_seconds" integer NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- migration-guard: ack index is created on a new empty table
CREATE INDEX "check_duration_samples_repo_check_idx" ON "check_duration_samples" USING btree ("repo_full_name","check_name","completed_at");