CREATE TYPE "public"."audit_action" AS ENUM('merge_pr', 'rerun_check_run', 'rerun_workflow', 'rerun_failed_jobs');--> statement-breakpoint
CREATE TYPE "public"."audit_result" AS ENUM('success', 'failure', 'denied');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer,
	"action" "audit_action" NOT NULL,
	"result" "audit_result" NOT NULL,
	"repo_full_name" text NOT NULL,
	"pr_number" integer,
	"target_id" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installation_repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"full_name" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"watched" boolean DEFAULT true NOT NULL,
	CONSTRAINT "installation_repos_repo_id_unique" UNIQUE("repo_id")
);
--> statement-breakpoint
CREATE TABLE "installations" (
	"installation_id" integer PRIMARY KEY NOT NULL,
	"account_login" text NOT NULL,
	"account_type" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"github_user_id" integer NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_user_id_unique" UNIQUE("github_user_id")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installation_repos" ADD CONSTRAINT "installation_repos_installation_id_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("installation_id") ON DELETE cascade ON UPDATE no action;