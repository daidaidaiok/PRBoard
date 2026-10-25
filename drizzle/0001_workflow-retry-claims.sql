CREATE TABLE "workflow_retry_claims" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_full_name" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"run_attempt" integer NOT NULL,
	"status" text NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"last_error" text
);
--> statement-breakpoint
-- migration-guard: ack 新建空表尚无数据，创建唯一索引不会锁定现有业务表
CREATE UNIQUE INDEX "workflow_retry_claim_unique" ON "workflow_retry_claims" USING btree ("repo_full_name","workflow_run_id","run_attempt");
