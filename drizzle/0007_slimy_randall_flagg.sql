ALTER TYPE "public"."notification_kind" ADD VALUE 'deploy_failed';--> statement-breakpoint
CREATE TABLE "user_notification_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"bark_url" text,
	"notify_ci_green" boolean DEFAULT true NOT NULL,
	"notify_retry_exhausted" boolean DEFAULT true NOT NULL,
	"notify_pr_conflict" boolean DEFAULT true NOT NULL,
	"notify_deploy_failed" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_notification_settings" ADD CONSTRAINT "user_notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;