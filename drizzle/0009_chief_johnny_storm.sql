CREATE TABLE "ai_review_providers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text,
	"secret_name" text NOT NULL,
	"budget_limit" bigint,
	"budget_unit" text,
	"budget_alert_period" text,
	"budget_alert_level" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_review_repos" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"repo_full_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_id" uuid,
	"model" text NOT NULL,
	"thinking_level" text,
	"extra_args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"token_created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_config_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_review_settings" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_review_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" uuid,
	"provider_id" uuid,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cost_micro_usd" bigint,
	"pr_number" integer,
	"run_id" bigint NOT NULL,
	"run_attempt" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_review_providers" ADD CONSTRAINT "ai_review_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_repos" ADD CONSTRAINT "ai_review_repos_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_repos" ADD CONSTRAINT "ai_review_repos_provider_id_ai_review_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_review_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_settings" ADD CONSTRAINT "ai_review_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_usage" ADD CONSTRAINT "ai_review_usage_repo_id_ai_review_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."ai_review_repos"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_usage" ADD CONSTRAINT "ai_review_usage_provider_id_ai_review_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_review_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE UNIQUE INDEX "ai_review_providers_user_name_unique" ON "ai_review_providers" USING btree ("user_id","name");--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE UNIQUE INDEX "ai_review_repos_user_repo_unique" ON "ai_review_repos" USING btree ("user_id",lower("repo_full_name"));--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE UNIQUE INDEX "ai_review_repos_token_hash_unique" ON "ai_review_repos" USING btree ("token_hash");--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE UNIQUE INDEX "ai_review_usage_run_unique" ON "ai_review_usage" USING btree ("repo_id","run_id","run_attempt");--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE INDEX "ai_review_usage_provider_created_idx" ON "ai_review_usage" USING btree ("provider_id","created_at");