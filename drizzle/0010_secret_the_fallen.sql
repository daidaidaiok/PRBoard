CREATE TABLE "ai_review_quota_windows" (
	"provider_id" uuid NOT NULL,
	"window_type" text NOT NULL,
	"utilization" real,
	"resets_at" timestamp with time zone,
	"status" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_review_quota_windows_provider_id_window_type_pk" PRIMARY KEY("provider_id","window_type")
);
--> statement-breakpoint
ALTER TABLE "ai_review_providers" ADD COLUMN "quota_stop_ratio" real DEFAULT 0.95;--> statement-breakpoint
ALTER TABLE "ai_review_quota_windows" ADD CONSTRAINT "ai_review_quota_windows_provider_id_ai_review_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_review_providers"("id") ON DELETE cascade ON UPDATE no action;