CREATE TABLE "ai_review_lanes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"repo_id" uuid NOT NULL,
	"lane_key" text NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"thinking_mode" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"wired" boolean DEFAULT false NOT NULL,
	"model" text NOT NULL,
	"thinking" text,
	"credential" text,
	"meter" text NOT NULL,
	"provider_id" uuid,
	"notes" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_review_lanes" ADD CONSTRAINT "ai_review_lanes_repo_id_ai_review_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."ai_review_repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_review_lanes" ADD CONSTRAINT "ai_review_lanes_provider_id_ai_review_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_review_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- migration-guard: ack 新建空表上的索引，无存量数据，不会长时间锁表
CREATE UNIQUE INDEX "ai_review_lanes_repo_key_unique" ON "ai_review_lanes" USING btree ("repo_id","lane_key");