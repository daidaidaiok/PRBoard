CREATE TABLE "dashboard_snapshots" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dashboard_snapshots" ADD CONSTRAINT "dashboard_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;