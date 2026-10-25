CREATE TABLE "user_installations" (
	"user_id" integer NOT NULL,
	"installation_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "installations" ADD COLUMN "account_github_id" integer NOT NULL DEFAULT 0;--> statement-breakpoint
-- migration-guard: ack remove temporary default after backfilling existing installation rows
ALTER TABLE "installations" ALTER COLUMN "account_github_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_installations" ADD CONSTRAINT "user_installations_installation_id_installations_installation_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."installations"("installation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-guard: ack unique index enforces one user-installation link for permission isolation
CREATE UNIQUE INDEX "user_installations_unique" ON "user_installations" USING btree ("user_id","installation_id");
--> statement-breakpoint
INSERT INTO "user_installations" ("user_id", "installation_id")
SELECT u."id", i."installation_id"
FROM "users" u
JOIN "installations" i ON lower(u."login") = lower(i."account_login")
ON CONFLICT ("user_id", "installation_id") DO NOTHING;
