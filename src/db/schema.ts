import { sql } from "drizzle-orm";
import { bigint, index, pgEnum, pgTable, primaryKey, real, serial, text, integer, timestamp, boolean, jsonb, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/**
 * A person who has signed in via "Sign in with GitHub App".
 */
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  githubUserId: integer("github_user_id").notNull().unique(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per GitHub App installation (a user or org that installed the app).
 * installationId is the GitHub-assigned id — required for minting
 * installation access tokens via @octokit/app.
 */
export const installations = pgTable("installations", {
  installationId: integer("installation_id").primaryKey(),
  accountGithubId: integer("account_github_id").notNull(),
  accountLogin: text("account_login").notNull(),
  accountType: text("account_type").notNull(), // "User" | "Organization"
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A GitHub user who completed the App installation flow for an installation. */
export const userInstallations = pgTable(
  "user_installations",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    installationId: integer("installation_id")
      .notNull()
      .references(() => installations.installationId, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("user_installations_unique").on(table.userId, table.installationId)],
);

/**
 * Repos the installation has access to, mirrored locally so the dashboard
 * doesn't need a GitHub round-trip just to know what's watchable.
 * Kept in sync via `installation_repositories` webhook events.
 */
export const installationRepos = pgTable("installation_repos", {
  id: serial("id").primaryKey(),
  installationId: integer("installation_id")
    .notNull()
    .references(() => installations.installationId, { onDelete: "cascade" }),
  repoId: integer("repo_id").notNull().unique(),
  owner: text("owner").notNull(),
  name: text("name").notNull(),
  fullName: text("full_name").notNull(),
  isPrivate: boolean("is_private").notNull().default(false),
  watched: boolean("watched").notNull().default(true),
});

export const auditActionEnum = pgEnum("audit_action", [
  "merge_pr",
  "rerun_check_run",
  "rerun_workflow",
  "rerun_failed_jobs",
  "cancel_workflow",
  "force_cancel_workflow",
  "delete_workflow_run",
]);

export const auditResultEnum = pgEnum("audit_result", ["success", "failure", "denied"]);

/**
 * Every high-privilege action (merge / rerun) is logged here regardless of
 * outcome, including denials, before the corresponding GitHub API call is
 * made. This is the accountability trail for a tool that can merge code.
 */
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  action: auditActionEnum("action").notNull(),
  result: auditResultEnum("result").notNull(),
  repoFullName: text("repo_full_name").notNull(),
  prNumber: integer("pr_number"),
  targetId: text("target_id"), // check run id / workflow run id, as string
  detail: jsonb("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workflowRetryClaims = pgTable(
  "workflow_retry_claims",
  {
    id: serial("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    workflowRunId: text("workflow_run_id").notNull(),
    runAttempt: integer("run_attempt").notNull(),
    status: text("status").$type<"processing" | "succeeded" | "failed">().notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("workflow_retry_claim_unique").on(table.repoFullName, table.workflowRunId, table.runAttempt),
  ],
);

export const notificationKindEnum = pgEnum("notification_kind", [
  "ci_green",
  "ci_retry_exhausted",
  "pr_conflict",
  "deploy_failed",
]);

/**
 * One row per Bark push actually sent, keyed so a webhook redelivery or a
 * second workflow_run finishing the same PR green doesn't send it twice.
 * `dedupKey` carries whatever makes that notification instance unique:
 * `"<pr>:<headSha>"` for ci_green (once per PR per commit reaching green),
 * `"<workflowRunId>:<runAttempt>"` for ci_retry_exhausted (once per exhausted
 * attempt), `"<pr>"` for pr_conflict (cleared — see `clearNotified` — once
 * the PR becomes mergeable again, so a later re-conflict notifies again).
 */
export const notificationDedup = pgTable(
  "notification_dedup",
  {
    id: serial("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    kind: notificationKindEnum("kind").notNull(),
    dedupKey: text("dedup_key").notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("notification_dedup_unique").on(table.repoFullName, table.kind, table.dedupKey)],
);

/**
 * One row per completed GitHub Actions check run, used only to estimate how
 * long a still-running check of the same name will take (dashboard progress
 * bars). Not pruned — same unbounded-growth tradeoff as `audit_log`, fine at
 * this project's personal scale.
 *
 * Known limitation: keyed by `(repoFullName, checkName)` only, with no
 * workflow-file identity — two workflow files in the same repo that happen
 * to define a same-named job (e.g. both call it "test") share one sample
 * pool. The `check_run.completed` webhook payload that populates this table
 * doesn't carry the originating workflow file, and resolving it would need
 * an extra GitHub API call per event (job → run → workflow path) purely for
 * a nice-to-have estimate; not worth that cost for now.
 */
export const checkDurationSamples = pgTable(
  "check_duration_samples",
  {
    id: serial("id").primaryKey(),
    repoFullName: text("repo_full_name").notNull(),
    checkName: text("check_name").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("check_duration_samples_repo_check_idx").on(table.repoFullName, table.checkName, table.completedAt),
  ],
);

export const monitorHostPlatformEnum = pgEnum("monitor_host_platform", ["macos", "windows", "linux"]);
export const monitorHostCapacityRoleEnum = pgEnum("monitor_host_capacity_role", ["primary", "shared"]);

/**
 * A machine or virtual environment that reports its own fixed telemetry
 * schema. `primary` owns physical capacity for a domain; `shared` (such as
 * WSL) is visible for health and Runner activity but never adds CPU/RAM.
 */
export const monitorHosts = pgTable(
  "monitor_hosts",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    platform: monitorHostPlatformEnum("platform").notNull(),
    capacityDomain: text("capacity_domain").notNull(),
    capacityRole: monitorHostCapacityRoleEnum("capacity_role").notNull(),
    runnerName: text("runner_name"),
    runnerCpuReserveMilliCores: integer("runner_cpu_reserve_millicores").notNull().default(2000),
    runnerMemoryReserveMib: integer("runner_memory_reserve_mib").notNull().default(4096),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("monitor_hosts_user_display_name_unique").on(table.userId, table.displayName),
    uniqueIndex("monitor_hosts_one_primary_per_domain").on(table.userId, table.capacityDomain).where(sql`${table.capacityRole} = 'primary'`),
  ],
);

/** Only SHA-256 digests are stored, so an enrollment secret is unrecoverable. */
export const monitorHostIngestTokens = pgTable(
  "monitor_host_ingest_tokens",
  {
    id: uuid("id").primaryKey(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitorHosts.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("monitor_host_ingest_tokens_hash_unique").on(table.tokenHash),
    index("monitor_host_ingest_tokens_active_host_idx").on(table.hostId, table.revokedAt),
  ],
);

/** One fixed, privacy-minimised metric schema per accepted reporting minute. */
export const hostMetricSamples = pgTable(
  "host_metric_samples",
  {
    id: serial("id").primaryKey(),
    hostId: uuid("host_id")
      .notNull()
      .references(() => monitorHosts.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    cpuUsageBasisPoints: integer("cpu_usage_basis_points").notNull(),
    logicalCpuCores: integer("logical_cpu_cores").notNull(),
    memoryTotalMib: integer("memory_total_mib").notNull(),
    memoryUsedMib: integer("memory_used_mib").notNull(),
    diskTotalMib: integer("disk_total_mib").notNull(),
    diskUsedMib: integer("disk_used_mib").notNull(),
    swapTotalMib: integer("swap_total_mib").notNull(),
    swapUsedMib: integer("swap_used_mib").notNull(),
    networkRxBytesPerSecond: bigint("network_rx_bytes_per_second", { mode: "number" }).notNull(),
    networkTxBytesPerSecond: bigint("network_tx_bytes_per_second", { mode: "number" }).notNull(),
    runnerListenerCount: integer("runner_listener_count").notNull(),
    runnerWorkerCount: integer("runner_worker_count").notNull(),
    load1Milli: integer("load1_milli"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("host_metric_samples_host_captured_at_unique").on(table.hostId, table.capturedAt),
    index("host_metric_samples_host_captured_at_idx").on(table.hostId, table.capturedAt),
  ],
);

/**
 * Per-user push preferences, edited from the /settings/notifications page.
 * Rows are created lazily on first save — a user with no row means "all four
 * switches on, no Bark configured" (`DEFAULT_NOTIFICATION_SETTINGS`).
 * `barkUrl` is the full push URL including the device key; it never leaves
 * the server except as a `maskBarkUrl`ed preview (see src/lib/bark.ts).
 */
/**
 * Last successfully-fetched open-PR list per user. The dashboard queries
 * GitHub live on every load by design; this table is the degraded-mode
 * fallback for when GitHub is slow or unreachable — not a cache of record,
 * so it's replaced (not merged) on every success. One row per user.
 */
export const dashboardSnapshots = pgTable("dashboard_snapshots", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const userNotificationSettings = pgTable("user_notification_settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  barkUrl: text("bark_url"),
  notifyCiGreen: boolean("notify_ci_green").notNull().default(true),
  notifyRetryExhausted: boolean("notify_retry_exhausted").notNull().default(true),
  notifyPrConflict: boolean("notify_pr_conflict").notNull().default(true),
  notifyDeployFailed: boolean("notify_deploy_failed").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * AI review 集中管理（/settings/ai-review）。各仓库 CI 用每仓库一个 token
 * 拉取配置、回报用量；服务商密钥只留在各仓库的 GitHub Secrets，这里只存
 * `secretName`（要用哪个 secret），任何表都不存密钥明文。
 */
export const aiReviewSettings = pgTable("ai_review_settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** 全局暂停：为 true 时所有仓库的 config 都返回 enabled:false。 */
  paused: boolean("paused").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiReviewProviders = pgTable(
  "ai_review_providers",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").$type<"claude-oauth" | "anthropic-compatible">().notNull(),
    baseUrl: text("base_url"),
    secretName: text("secret_name").notNull(),
    /** 预算上限（UTC 自然月周期），null = 不限；单位见 budgetUnit。 */
    budgetLimit: bigint("budget_limit", { mode: "number" }),
    budgetUnit: text("budget_unit").$type<"token" | "usd" | "count">(),
    /**
     * 预算预警去重：记录最近一次已推送的 (周期 "yyyy-mm", 档位)。
     * 用条件 UPDATE 原子认领，不走 notificationDedup——后者的 kind 枚举
     * 绑定了 user_notification_settings 的逐类开关，预算预警不需要那套开关。
     */
    /**
     * Claude 订阅（claude-oauth）窗口的暂停阈值（已用比例 0..1）；null = 只在 SDK 明确 rejected 时才停。
     * 订阅按窗口限量、没有美元预算，所以与 budgetLimit/budgetUnit 互斥使用。
     */
    quotaStopRatio: real("quota_stop_ratio").default(0.95),
    budgetAlertPeriod: text("budget_alert_period"),
    budgetAlertLevel: text("budget_alert_level").$type<"warn" | "exhausted">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ai_review_providers_user_name_unique").on(table.userId, table.name)],
);

/** 只存 token 的 SHA-256 摘要（同 monitorHostIngestTokens），明文只在创建/轮换时返回一次。 */
export const aiReviewRepos = pgTable(
  "ai_review_repos",
  {
    id: uuid("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repoFullName: text("repo_full_name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    providerId: uuid("provider_id").references(() => aiReviewProviders.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    thinkingLevel: text("thinking_level"),
    extraArgs: jsonb("extra_args").notNull().default(sql`'[]'::jsonb`),
    tokenHash: text("token_hash").notNull(),
    tokenCreatedAt: timestamp("token_created_at", { withTimezone: true }).notNull().defaultNow(),
    lastConfigAt: timestamp("last_config_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // GitHub 仓库名大小写不敏感（CI 鉴权也是），唯一性必须同口径，否则 Foo/Bar 与 foo/bar 会成两条。
    uniqueIndex("ai_review_repos_user_repo_unique").on(table.userId, sql`lower(${table.repoFullName})`),
    uniqueIndex("ai_review_repos_token_hash_unique").on(table.tokenHash),
  ],
);

/** 每次 review 的用量；(repoId, runId, runAttempt) 唯一，CI 重试回报同一次 run 不会重复计费。 */
export const aiReviewUsage = pgTable(
  "ai_review_usage",
  {
    id: serial("id").primaryKey(),
    /** 仓库被移除后置空而非级联删除：用量仍计入服务商的月额度，不能靠"移除再添加"清零花费。 */
    repoId: uuid("repo_id").references(() => aiReviewRepos.id, { onDelete: "set null" }),
    providerId: uuid("provider_id").references(() => aiReviewProviders.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    costMicroUsd: bigint("cost_micro_usd", { mode: "number" }),
    prNumber: integer("pr_number"),
    runId: bigint("run_id", { mode: "number" }).notNull(),
    runAttempt: integer("run_attempt").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("ai_review_usage_run_unique").on(table.repoId, table.runId, table.runAttempt),
    index("ai_review_usage_provider_created_idx").on(table.providerId, table.createdAt),
  ],
);

/**
 * Claude 订阅各限流窗口的最新读数（每个服务商每种窗口一行，覆盖式更新）。
 * 来自 CI 里 claude-code-action 的 execution_file 中的 rate_limit_event，由 usage 回报带上来；
 * 只在有 review 运行时才更新，设置页据 observed_at 标"更新于 N 分钟前"。
 */
export const aiReviewQuotaWindows = pgTable(
  "ai_review_quota_windows",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => aiReviewProviders.id, { onDelete: "cascade" }),
    windowType: text("window_type").notNull(),
    /** 已用比例 0..1；SDK 偶尔只给 status 不给比例，故可空。 */
    utilization: real("utilization"),
    resetsAt: timestamp("resets_at", { withTimezone: true }),
    status: text("status").$type<"allowed" | "allowed_warning" | "rejected">(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.providerId, table.windowType] })],
);

/**
 * 一个仓库下的各路 review 通道（Haiku / GLM / 免费池 / @mention / 桌面端 Claude 等），
 * 让设置页能按项目列出"到底在跑哪几路、各用什么模型和思考等级"，并能逐路开关、改模型与思考。
 * 仓库级配置（ai_review_repos）仍是 Claude 主审那一路，保持向后兼容。
 *
 * wired = CI 是否真的读取 PRboard 的配置：false 的通道只是只读记录，在设置页改了不会生效，
 * 页面必须明确标注"未接入"，否则会造成"面板说 X、实际跑 Y"的假象。
 */
export const aiReviewLanes = pgTable(
  "ai_review_lanes",
  {
    id: uuid("id").primaryKey(),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => aiReviewRepos.id, { onDelete: "cascade" }),
    /** 稳定标识（小写字母数字与连字符），CI 用它向 config 接口取本路配置。 */
    laneKey: text("lane_key").notNull(),
    label: text("label").notNull(),
    kind: text("kind").$type<"claude-code" | "api-script">().notNull(),
    /** 该路支持的思考控制：effort(low..max) / toggle(off,on,max；GLM) / none(无，如 Haiku 5.5、免费池)。 */
    thinkingMode: text("thinking_mode").$type<"effort" | "toggle" | "none">().notNull(),
    enabled: boolean("enabled").notNull().default(true),
    wired: boolean("wired").notNull().default(false),
    /** 模型名；免费池/故障转移链用逗号分隔（仅 api-script）。 */
    model: text("model").notNull(),
    thinking: text("thinking"),
    /** 凭据在仓库 Secrets 里的名字，仅作展示；密钥不进 PRboard。 */
    credential: text("credential"),
    meter: text("meter").$type<"subscription" | "usd" | "plan" | "free">().notNull(),
    /** 可选：关联服务商以复用其订阅窗口暂停 / 美元预算。 */
    providerId: uuid("provider_id").references(() => aiReviewProviders.id, { onDelete: "set null" }),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("ai_review_lanes_repo_key_unique").on(table.repoId, table.laneKey)],
);
