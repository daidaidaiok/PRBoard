CREATE TYPE "public"."monitor_host_capacity_role" AS ENUM('primary', 'shared');--> statement-breakpoint
CREATE TYPE "public"."monitor_host_platform" AS ENUM('macos', 'windows', 'linux');--> statement-breakpoint
CREATE TABLE "host_metric_samples" (
	"id" serial PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"cpu_usage_basis_points" integer NOT NULL,
	"logical_cpu_cores" integer NOT NULL,
	"memory_total_mib" integer NOT NULL,
	"memory_used_mib" integer NOT NULL,
	"disk_total_mib" integer NOT NULL,
	"disk_used_mib" integer NOT NULL,
	"swap_total_mib" integer NOT NULL,
	"swap_used_mib" integer NOT NULL,
	"network_rx_bytes_per_second" bigint NOT NULL,
	"network_tx_bytes_per_second" bigint NOT NULL,
	"runner_listener_count" integer NOT NULL,
	"runner_worker_count" integer NOT NULL,
	"load1_milli" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "monitor_host_ingest_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"host_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "monitor_hosts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"display_name" text NOT NULL,
	"platform" "monitor_host_platform" NOT NULL,
	"capacity_domain" text NOT NULL,
	"capacity_role" "monitor_host_capacity_role" NOT NULL,
	"runner_name" text,
	"runner_cpu_reserve_millicores" integer DEFAULT 2000 NOT NULL,
	"runner_memory_reserve_mib" integer DEFAULT 4096 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_metric_samples" ADD CONSTRAINT "host_metric_samples_host_id_monitor_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitor_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_host_ingest_tokens" ADD CONSTRAINT "monitor_host_ingest_tokens_host_id_monitor_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."monitor_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_hosts" ADD CONSTRAINT "monitor_hosts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE UNIQUE INDEX "host_metric_samples_host_captured_at_unique" ON "host_metric_samples" USING btree ("host_id","captured_at");--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE INDEX "host_metric_samples_host_captured_at_idx" ON "host_metric_samples" USING btree ("host_id","captured_at");--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE UNIQUE INDEX "monitor_host_ingest_tokens_hash_unique" ON "monitor_host_ingest_tokens" USING btree ("token_hash");--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE INDEX "monitor_host_ingest_tokens_active_host_idx" ON "monitor_host_ingest_tokens" USING btree ("host_id","revoked_at");--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE UNIQUE INDEX "monitor_hosts_user_display_name_unique" ON "monitor_hosts" USING btree ("user_id","display_name");--> statement-breakpoint
-- migration-guard: ack index is created on a new empty telemetry table
CREATE UNIQUE INDEX "monitor_hosts_one_primary_per_domain" ON "monitor_hosts" USING btree ("user_id","capacity_domain") WHERE "monitor_hosts"."capacity_role" = 'primary';
