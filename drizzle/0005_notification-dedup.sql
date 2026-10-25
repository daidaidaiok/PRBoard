CREATE TYPE "public"."notification_kind" AS ENUM('ci_green', 'ci_retry_exhausted', 'pr_conflict');--> statement-breakpoint
CREATE TABLE "notification_dedup" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"dedup_key" text NOT NULL,
	"notified_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- migration-guard: ack index is created on a new empty table
CREATE UNIQUE INDEX "notification_dedup_unique" ON "notification_dedup" USING btree ("repo_full_name","kind","dedup_key");