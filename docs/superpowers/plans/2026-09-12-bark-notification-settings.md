# Bark 通知设置界面化（用户级配置）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Bark 推送配置从环境变量搬到 Web 界面，每个登录用户在设置页自填 Bark URL 并按四类通知独立开关，存数据库。

**Architecture:** 新增 `user_notification_settings` 表（用户级，行按需创建）；`bark.ts` 改为显式 URL 参数并新增脱敏/校验纯函数；现有三类 CI 通知改造为按 installation 的用户 fan-out（dedup key 加 userId 前缀）；新增第四类 `deploy_failed` 通知（在现有 `check_run.completed` handler 中触发，语义同被删除的 `deploy-fail-bark.yml`）；新增 3 个 API 端点 + `/settings/notifications` 设置页。

**Tech Stack:** Next.js 16 (App Router)、Drizzle ORM + PostgreSQL (Neon)、@base-ui/react (shadcn 风格)、vitest。

**Spec:** `docs/superpowers/specs/2026-09-12-bark-notification-settings-design.md`

## Global Constraints

- Next.js 版本 16.3.3，与训练数据可能不同——写 route handler / page / `after()` 前先查 `node_modules/next/dist/docs/` 对应指南（本仓库 AGENTS.md 要求）。现有代码 `src/app/api/prs/route.ts` 和 `src/lib/github/webhooks.ts` 是可靠参照。
- 测试：`npx vitest run <file>` 单文件；`npm test` 全量；`npm run type-check` 类型检查。
- DB 迁移：改 `src/db/schema.ts` 后 `npm run db:generate` 生成 SQL，再 `npm run db:migrate` 应用（都会自动加载 `.env.local`）。
- UI 文案用中文；commit message 用中文 conventional commits（如 `feat: xxx`）。
- 不新增 npm 依赖（Switch 用已有的 `@base-ui/react`）。
- 完整 Bark URL（含 device key）永不返回给前端、永不写入日志——只用 `maskBarkUrl` 脱敏。
- 数据库当前没有配置过 `BARK_PUSH_URL`（已验证 Vercel env 与 GitHub secrets 均为空），无存量数据迁移。

## 跨任务接口契约（实现时以此为准）

```ts
// src/lib/bark.ts
export interface BarkPushResult { ok: boolean; status?: number }
export function maskBarkUrl(rawUrl: string): string | null;
export function parseBarkUrl(raw: string): string | null;
export async function sendBarkNotification(
  barkUrl: string,
  notification: BarkNotification,
  options?: { group?: string },
): Promise<BarkPushResult>;

// src/db/notification-settings.ts
export interface NotificationSettings {
  barkUrl: string | null;
  notifyCiGreen: boolean;
  notifyRetryExhausted: boolean;
  notifyPrConflict: boolean;
  notifyDeployFailed: boolean;
}
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings; // 全 true + barkUrl null
export async function getNotificationSettings(userId: number): Promise<NotificationSettings>;
export async function upsertNotificationSettings(userId: number, patch: Partial<NotificationSettings>): Promise<NotificationSettings>;
export async function listNotifiableUsers(installationId: number, kind: NotificationKind): Promise<Array<{ userId: number; barkUrl: string }>>;

// src/db/notification-dedup.ts（类型改为从 schema 枚举推导，自动获得 deploy_failed）
export type NotificationKind = "ci_green" | "ci_retry_exhausted" | "pr_conflict" | "deploy_failed";

// src/lib/github/ci-notifications.ts 新增
export interface DeployFailedNotificationEvent {
  installationId: number | null;
  repoFullName: string;
  checkRunId: number;
  checkName: string;
  conclusion: string | null;
  appSlug: string | null;
  headSha: string;
  detailsUrl: string | null;
}
export async function notifyDeployFailed(event: DeployFailedNotificationEvent): Promise<void>;
```

---

### Task 1: Schema 与迁移（`user_notification_settings` 表 + `deploy_failed` 枚举值）

**Files:**
- Modify: `src/db/schema.ts`（`notificationKindEnum` 在第 110 行；文件末尾追加新表）
- Create: `drizzle/0007_*.sql`（由 drizzle-kit 生成，文件名随机）
- Test: 无（纯 DDL，由 Task 4/5 的测试间接覆盖；本任务用 migrate + drizzle-kit 自身验证）

**Interfaces:**
- Consumes: 无
- Produces: `userNotificationSettings` 表（drizzle 导出，Task 3 使用）；`notification_kind` 枚举含 `deploy_failed`（Task 3/4/5 使用）

- [ ] **Step 1: 修改 `src/db/schema.ts` 的枚举**

把：

```ts
export const notificationKindEnum = pgEnum("notification_kind", ["ci_green", "ci_retry_exhausted", "pr_conflict"]);
```

改为：

```ts
export const notificationKindEnum = pgEnum("notification_kind", [
  "ci_green",
  "ci_retry_exhausted",
  "pr_conflict",
  "deploy_failed",
]);
```

- [ ] **Step 2: 在 `src/db/schema.ts` 文件末尾追加新表**

```ts
/**
 * Per-user push preferences, edited from the /settings/notifications page.
 * Rows are created lazily on first save — a user with no row means "all four
 * switches on, no Bark configured" (`DEFAULT_NOTIFICATION_SETTINGS`).
 * `barkUrl` is the full push URL including the device key; it never leaves
 * the server except as a `maskBarkUrl`ed preview (see src/lib/bark.ts).
 */
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
```

- [ ] **Step 3: 生成并检查迁移 SQL**

Run: `npm run db:generate`
检查生成的 `drizzle/0007_*.sql`：应包含 `ALTER TYPE "notification_kind" ADD VALUE 'deploy_failed';` 和 `CREATE TABLE "user_notification_settings" (...)`。若 migration-guard 拦截某条语句（参照 `drizzle/0005` 顶部 `-- migration-guard: ...` 注释的先例），按其提示补 ack 注释。

- [ ] **Step 4: 应用迁移**

Run: `npm run db:migrate`
Expected: 迁移成功应用，无报错。

- [ ] **Step 5: 类型检查**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: 用户级通知设置表与 deploy_failed 通知类型"
```

---

### Task 2: `bark.ts` 重构（显式 URL + 脱敏/校验纯函数 + 返回结果）

**Files:**
- Modify: `src/lib/bark.ts`（全文件重写）
- Modify: `src/lib/bark.test.ts`（全文件重写）

**Interfaces:**
- Consumes: 无
- Produces: `sendBarkNotification(barkUrl, notification, options?)`（Task 4/5/7 使用）；`maskBarkUrl`（Task 6 使用）；`parseBarkUrl`（Task 6/7 使用）；`BarkPushResult`（Task 7 使用）

- [ ] **Step 1: 重写失败测试 `src/lib/bark.test.ts`**

删除全部 env 相关用例，替换为：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maskBarkUrl, parseBarkUrl, sendBarkNotification } from "./bark";

const BARK_URL = "https://bark-worker.example.workers.dev/device-key";

describe("parseBarkUrl", () => {
  it("accepts an https URL and strips a trailing slash", () => {
    expect(parseBarkUrl("https://api.day.app/abc123/")).toBe("https://api.day.app/abc123");
  });

  it("accepts http for self-hosted bark servers", () => {
    expect(parseBarkUrl("http://192.168.1.5:8080/key")).toBe("http://192.168.1.5:8080/key");
  });

  it("rejects non-http(s) protocols and malformed URLs", () => {
    expect(parseBarkUrl("ftp://api.day.app/abc")).toBeNull();
    expect(parseBarkUrl("not a url")).toBeNull();
    expect(parseBarkUrl("")).toBeNull();
  });
});

describe("maskBarkUrl", () => {
  it("keeps the origin and only the last 4 chars of the key", () => {
    expect(maskBarkUrl("https://api.day.app/abcdef123456")).toBe("https://api.day.app/…3456");
  });

  it("returns null for malformed stored values", () => {
    expect(maskBarkUrl("not a url")).toBeNull();
  });
});

describe("sendBarkNotification", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the body as a path segment with slashes preserved, plus query params", async () => {
    await sendBarkNotification(BARK_URL, { title: "CI 全绿", body: "owner/repo #12 fix" });

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.pathname).toBe("/device-key/owner/repo #12 fix");
    expect(calledUrl.searchParams.get("title")).toBe("CI 全绿");
    expect(calledUrl.searchParams.get("group")).toBe("prboard-ci");
    expect(calledUrl.searchParams.get("level")).toBe("active");
  });

  it("honors the level and url fields and a custom group", async () => {
    await sendBarkNotification(
      BARK_URL,
      { title: "t", body: "b", level: "timeSensitive", url: "https://github.com/x" },
      { group: "prboard-test" },
    );

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("level")).toBe("timeSensitive");
    expect(calledUrl.searchParams.get("url")).toBe("https://github.com/x");
    expect(calledUrl.searchParams.get("group")).toBe("prboard-test");
  });

  it("returns ok:true on a 2xx from the bark server", async () => {
    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("returns ok:false with the status on a non-2xx and logs without the URL", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });

    expect(result).toEqual({ ok: false, status: 404 });
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("device-key");
    errorSpy.mockRestore();
  });

  it("returns ok:false when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });

    expect(result.ok).toBe(false);
    errorSpy.mockRestore();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/bark.test.ts`
Expected: FAIL（`parseBarkUrl`/`maskBarkUrl` 未导出、`sendBarkNotification` 签名不符）

- [ ] **Step 3: 重写实现 `src/lib/bark.ts`**

```ts
export interface BarkNotification {
  title: string;
  body: string;
  url?: string;
  level?: "active" | "timeSensitive" | "passive";
}

export interface BarkPushResult {
  ok: boolean;
  status?: number;
}

const DEFAULT_GROUP = "prboard-ci";

/**
 * Validates a user-supplied Bark push URL and normalizes it for storage:
 * must be http(s) (self-hosted bark servers are often plain http on a LAN),
 * trailing slash stripped so path appending stays predictable.
 * Returns null instead of throwing so API routes can 400 cleanly.
 */
export function parseBarkUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href.replace(/\/$/, "");
}

/**
 * Safe-to-display form: origin plus the last 4 chars of the last path
 * segment (the device key). Only ever sent to the settings page — the full
 * URL works as a "push to this phone" credential and must not leak.
 */
export function maskBarkUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const key = segments.at(-1) ?? "";
  const tail = key.slice(-4);
  return `${url.origin}/${key.length > 4 ? "…" : ""}${tail}`;
}

/**
 * Bark（https://bark.day.app）推送：路径本身即正文，device key 已经编进
 * `barkUrl`（形如 https://.../<device-key>，存于调用方查出的用户设置里）。
 *
 * 用 `url.pathname = ...` 而不是手写 encodeURIComponent：URL 的 path 解析
 * 会把字符串里的 '/' 当成路径分隔符保留，只转义其它特殊字符——正好是
 * bark-worker 想要的效果（body 常带 owner/repo 这种自带斜杠的内容,转义成
 * %2F 不会出错但推送里会显示成 %2F,体验更差）。
 *
 * 返回 Bark 服务器的响应状态而不是抛错/只记日志：测试推送端点需要把它
 * 反馈给设置页；周期性通知的调用方照旧忽略返回值。
 */
export async function sendBarkNotification(
  barkUrl: string,
  notification: BarkNotification,
  options: { group?: string } = {},
): Promise<BarkPushResult> {
  const url = new URL(barkUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${notification.body}`;
  url.searchParams.set("title", notification.title);
  url.searchParams.set("group", options.group ?? DEFAULT_GROUP);
  url.searchParams.set("level", notification.level ?? "active");
  if (notification.url) url.searchParams.set("url", notification.url);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[bark] push failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error("[bark] push error", error);
    return { ok: false };
  }
}
```

注意：原文件顶部的 `const BARK_GROUP = "prboard-ci";` 常量被并入 `DEFAULT_GROUP`。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/bark.test.ts`
Expected: PASS（此时 `ci-notifications` 的旧测试会因签名变化而编译失败——下一任务修复，本任务只要求 bark.test.ts 自身通过）

- [ ] **Step 5: Commit**

```bash
git add src/lib/bark.ts src/lib/bark.test.ts
git commit -m "refactor: bark 推送改为显式 URL 参数，新增脱敏与校验函数"
```

---

### Task 3: `db/notification-settings.ts` 数据访问层

**Files:**
- Create: `src/db/notification-settings.ts`
- Modify: `src/db/notification-dedup.ts:5`（`NotificationKind` 改为从 schema 推导）

**Interfaces:**
- Consumes: `userNotificationSettings`（Task 1）、`notificationKindEnum`（Task 1）、`userInstallations`（已有）
- Produces: `getNotificationSettings` / `upsertNotificationSettings` / `listNotifiableUsers` / `NotificationSettings` / `DEFAULT_NOTIFICATION_SETTINGS`（Task 4/5/6/7 使用）

**说明：** `src/db/` 下没有单测惯例（无真实 PG 的测试环境，现有 db 模块均无测试文件），本任务靠 `npm run type-check` 验证类型、由 Task 4/5 的 mock 测试和最终手动验收覆盖行为。

- [ ] **Step 1: 修改 `src/db/notification-dedup.ts` 的类型推导**

把第 5 行：

```ts
export type NotificationKind = "ci_green" | "ci_retry_exhausted" | "pr_conflict";
```

改为（新增枚举值后自动同步，消除两处手写列表漂移的风险）：

```ts
export type NotificationKind = (typeof notificationKindEnum.enumValues)[number];
```

并把 import 行改为 `import { notificationDedup, notificationKindEnum } from "./schema";`

- [ ] **Step 2: 创建 `src/db/notification-settings.ts`**

```ts
import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "./index";
import { userInstallations, userNotificationSettings } from "./schema";
import type { NotificationKind } from "./notification-dedup";

export interface NotificationSettings {
  barkUrl: string | null;
  notifyCiGreen: boolean;
  notifyRetryExhausted: boolean;
  notifyPrConflict: boolean;
  notifyDeployFailed: boolean;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  barkUrl: null,
  notifyCiGreen: true,
  notifyRetryExhausted: true,
  notifyPrConflict: true,
  notifyDeployFailed: true,
};

/** Rows are lazy — a user who never opened settings reads as all-on/unset. */
export async function getNotificationSettings(userId: number): Promise<NotificationSettings> {
  const [row] = await db
    .select()
    .from(userNotificationSettings)
    .where(eq(userNotificationSettings.userId, userId))
    .limit(1);
  if (!row) return DEFAULT_NOTIFICATION_SETTINGS;
  return {
    barkUrl: row.barkUrl,
    notifyCiGreen: row.notifyCiGreen,
    notifyRetryExhausted: row.notifyRetryExhausted,
    notifyPrConflict: row.notifyPrConflict,
    notifyDeployFailed: row.notifyDeployFailed,
  };
}

export async function upsertNotificationSettings(
  userId: number,
  patch: Partial<NotificationSettings>,
): Promise<NotificationSettings> {
  await db
    .insert(userNotificationSettings)
    .values({ userId, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userNotificationSettings.userId,
      set: { ...patch, updatedAt: new Date() },
    });
  return getNotificationSettings(userId);
}

const kindSwitchColumn = {
  ci_green: userNotificationSettings.notifyCiGreen,
  ci_retry_exhausted: userNotificationSettings.notifyRetryExhausted,
  pr_conflict: userNotificationSettings.notifyPrConflict,
  deploy_failed: userNotificationSettings.notifyDeployFailed,
} as const;

/**
 * Recipients for one notification kind among the users tied to an
 * installation: must have a Bark URL saved AND that kind's switch on.
 * Empty result = nobody to push to (same silence as the old unset-env path).
 */
export async function listNotifiableUsers(
  installationId: number,
  kind: NotificationKind,
): Promise<Array<{ userId: number; barkUrl: string }>> {
  const rows = await db
    .select({ userId: userInstallations.userId, barkUrl: userNotificationSettings.barkUrl })
    .from(userInstallations)
    .innerJoin(
      userNotificationSettings,
      eq(userNotificationSettings.userId, userInstallations.userId),
    )
    .where(
      and(
        eq(userInstallations.installationId, installationId),
        eq(kindSwitchColumn[kind], true),
        isNotNull(userNotificationSettings.barkUrl),
      ),
    );
  return rows.flatMap((row) => (row.barkUrl ? [row] : []));
}
```

- [ ] **Step 3: 类型检查**

Run: `npm run type-check`
Expected: FAIL 仅剩 `ci-notifications.ts`（还在用旧的一参签名调用 `sendBarkNotification`）——`notification-settings.ts` 自身无类型错误即可。若整个项目仍 PASS（旧调用恰好兼容）也接受。

- [ ] **Step 4: Commit**

```bash
git add src/db/notification-settings.ts src/db/notification-dedup.ts
git commit -m "feat: 用户通知设置的数据访问层"
```

---

### Task 4: 三类 CI 通知改造为按用户 fan-out（dedup key 加 userId）

**Files:**
- Modify: `src/lib/github/ci-notifications.ts`
- Modify: `src/lib/github/ci-notifications.test.ts`

**Interfaces:**
- Consumes: `sendBarkNotification(barkUrl, ...)`（Task 2）、`listNotifiableUsers`（Task 3）、`claimNotification`/`clearNotification`（已有）
- Produces: 改造后的 `notifyWorkflowRunOutcome` / `notifyIfConflicting`（webhooks.ts 调用签名不变）；新增 fan-out 辅助 `pushToRecipients`（本文件内私有）

**核心行为变化（写测试前先读懂）：**
1. 两个入口在收件人解析上现在都依赖 `installationId`——`notifyWorkflowRunOutcome` 的 retry-exhausted 分支原来不检查它，现在 `installationId === null` 时两类都直接返回（没有收件人可言）。
2. 每类通知先 `listNotifiableUsers(installationId, kind)` 拿收件人，再对每个用户独立 `claimNotification`（dedupKey = `"<userId>:<原key>"`）+ `sendBarkNotification(user.barkUrl, ...)`。
3. `notifyIfConflicting` 的 `MERGEABLE` clear 分支：对同一收件人列表逐个 clear（没配置 Bark 的用户不可能 claim 过，无需清理）。
4. 单个用户推送失败只记日志，不影响其他用户（`Promise.allSettled` 语义）。

- [ ] **Step 1: 更新测试**

`src/lib/github/ci-notifications.test.ts` 的 mock 部分改为：

```ts
const { getPullRequestCiStatus, sendBarkNotification, claimNotification, clearNotification, listNotifiableUsers } =
  vi.hoisted(() => ({
    getPullRequestCiStatus: vi.fn(),
    sendBarkNotification: vi.fn(),
    claimNotification: vi.fn(),
    clearNotification: vi.fn(),
    listNotifiableUsers: vi.fn(),
  }));

vi.mock("./prs", () => ({ getPullRequestCiStatus }));
vi.mock("@/lib/bark", () => ({ sendBarkNotification }));
vi.mock("@/db/notification-dedup", () => ({ claimNotification, clearNotification }));
vi.mock("@/db/notification-settings", () => ({ listNotifiableUsers }));
```

`beforeEach` 增加：

```ts
listNotifiableUsers.mockResolvedValue([{ userId: 7, barkUrl: "https://bark.example.com/key7" }]);
```

新增/修改的用例（保留原有结构，仅列差异与新增；原有断言中的 dedup key 全部加上 `7:` 前缀）：

```ts
// retry-exhausted：key 带 userId 前缀，且按每个收件人的 barkUrl 推送
it("pushes an exhausted-retry notification per recipient with a user-scoped dedup key", async () => {
  listNotifiableUsers.mockResolvedValue([
    { userId: 7, barkUrl: "https://bark.example.com/key7" },
    { userId: 9, barkUrl: "https://bark.example.com/key9" },
  ]);

  await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

  expect(listNotifiableUsers).toHaveBeenCalledWith(7, "ci_retry_exhausted");
  expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_retry_exhausted", "7:555:3");
  expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_retry_exhausted", "9:555:3");
  expect(sendBarkNotification).toHaveBeenCalledWith("https://bark.example.com/key7", expect.objectContaining({ title: "CI 重试后仍失败" }));
  expect(sendBarkNotification).toHaveBeenCalledWith("https://bark.example.com/key9", expect.objectContaining({ title: "CI 重试后仍失败" }));
});

it("is a no-op when installationId is null (nobody to resolve recipients from)", async () => {
  await notifyWorkflowRunOutcome(workflowEvent({ installationId: null, conclusion: "failure", runAttempt: 3 }));
  expect(listNotifiableUsers).not.toHaveBeenCalled();
  expect(sendBarkNotification).not.toHaveBeenCalled();
});

it("one recipient's push failure does not block the others", async () => {
  listNotifiableUsers.mockResolvedValue([
    { userId: 7, barkUrl: "https://bark.example.com/key7" },
    { userId: 9, barkUrl: "https://bark.example.com/key9" },
  ]);
  sendBarkNotification.mockImplementation(async (barkUrl: string) => {
    if (barkUrl.includes("key7")) throw new Error("offline");
    return { ok: true };
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

  expect(sendBarkNotification).toHaveBeenCalledTimes(2);
  errorSpy.mockRestore();
});

// all-green：dedup key 断言改为 "7:12:abc123"，推送断言改为带 barkUrl 首参
// （原有 "pushes an all-green notification..." 用例中）：
expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_green", "7:12:abc123");
expect(sendBarkNotification).toHaveBeenCalledWith(
  "https://bark.example.com/key7",
  expect.objectContaining({ title: "CI 全绿", url: "https://github.com/owner/repo/pull/12" }),
);

// conflict：claim/clear 均按用户
it("clears per-user conflict claims when the PR becomes mergeable", async () => {
  getPullRequestCiStatus.mockResolvedValue({ title: "t", url: "u", mergeable: "MERGEABLE", rollupState: "success" });

  await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

  expect(clearNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
});

it("pushes conflict notifications per recipient with user-scoped claims", async () => {
  getPullRequestCiStatus.mockResolvedValue({ title: "Fix bug", url: "https://github.com/owner/repo/pull/12", mergeable: "CONFLICTING", rollupState: "failure" });

  await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

  expect(claimNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
  expect(sendBarkNotification).toHaveBeenCalledWith(
    "https://bark.example.com/key7",
    expect.objectContaining({ title: "PR 存在冲突" }),
  );
});
```

原有用例中所有 `claimNotification`/`clearNotification` 的 key 断言（`"555:3"`、`"12:abc123"`、`"12"`）同步加 `7:` 前缀；`sendBarkNotification` 断言全部改为以 `"https://bark.example.com/key7"` 为首参。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/github/ci-notifications.test.ts`
Expected: FAIL（实现还是旧逻辑：没有 listNotifiableUsers 调用、key 无前缀、推送首参不是 URL）

- [ ] **Step 3: 实现改造**

`src/lib/github/ci-notifications.ts` 关键改动（保留现有注释中仍然成立的部分，更新失效描述）：

新增 import：

```ts
import { listNotifiableUsers } from "@/db/notification-settings";
import type { NotificationKind } from "@/db/notification-dedup";
import type { BarkNotification } from "@/lib/bark";
```

新增私有 fan-out 辅助（放在 `notifyWorkflowRunOutcome` 之前）：

```ts
type Recipient = { userId: number; barkUrl: string };

/**
 * Per-recipient claim + push. The dedup key embeds the userId because the
 * `notification_dedup` unique index is global — without the prefix the first
 * recipient's claim would silently suppress everyone else's push for the
 * same event. Individual failures are logged, never rethrown: one user's
 * dead Bark server must not block the others.
 */
async function pushToRecipients(
  repoFullName: string,
  kind: NotificationKind,
  dedupKey: string,
  recipients: Recipient[],
  notification: BarkNotification & { logLabel: string },
): Promise<void> {
  await Promise.allSettled(
    recipients.map(async (recipient) => {
      try {
        if (!(await claimNotification(repoFullName, kind, `${recipient.userId}:${dedupKey}`))) return;
        const { logLabel, ...payload } = notification;
        const result = await sendBarkNotification(recipient.barkUrl, payload);
        if (!result.ok) console.error(`[ci-notifications] ${logLabel} push failed`, { repoFullName, userId: recipient.userId, status: result.status });
      } catch (error) {
        console.error(`[ci-notifications] ${logLabel} push failed`, { repoFullName, userId: recipient.userId, error });
      }
    }),
  );
}
```

`notifyWorkflowRunOutcome` 重写主体：

```ts
export async function notifyWorkflowRunOutcome(event: WorkflowRunNotificationEvent): Promise<void> {
  if (event.pullRequestNumbers.length === 0) return;
  if (event.installationId === null) return;
  const repoFullName = `${event.owner}/${event.repo}`;
  const installationId = event.installationId;

  if (isRetryExhausted(event.conclusion, event.runAttempt)) {
    const recipients = await listNotifiableUsers(installationId, "ci_retry_exhausted");
    await pushToRecipients(repoFullName, "ci_retry_exhausted", `${event.workflowRunId}:${event.runAttempt}`, recipients, {
      logLabel: "retry-exhausted",
      title: "CI 重试后仍失败",
      body: `${repoFullName} · ${event.workflowName} · 第 ${event.runAttempt} 次尝试仍失败`,
      url: event.htmlUrl,
      level: "timeSensitive",
    });
    return;
  }

  if (event.conclusion !== "success") return;

  await Promise.allSettled(
    event.pullRequestNumbers.map(async (number) => {
      try {
        const status = await getPullRequestCiStatus(installationId, event.owner, event.repo, number);
        if (status?.rollupState !== "success") return;
        const recipients = await listNotifiableUsers(installationId, "ci_green");
        await pushToRecipients(repoFullName, "ci_green", `${number}:${event.headSha}`, recipients, {
          logLabel: "all-green",
          title: "CI 全绿",
          body: `${repoFullName} · #${number} ${status.title}`,
          url: status.url,
          level: "timeSensitive",
        });
      } catch (error) {
        console.error("[ci-notifications] all-green push failed", { repoFullName, number, error });
      }
    }),
  );
}
```

`notifyIfConflicting` 重写主体：

```ts
export async function notifyIfConflicting(event: PullRequestNotificationEvent): Promise<void> {
  if (event.installationId === null) return;
  const repoFullName = `${event.owner}/${event.repo}`;

  try {
    const status = await resolveMergeableStatus(event.installationId, event.owner, event.repo, event.number);
    if (!status) return;

    const recipients = await listNotifiableUsers(event.installationId, "pr_conflict");

    if (status.mergeable === "MERGEABLE") {
      await Promise.allSettled(
        recipients.map((recipient) => clearNotification(repoFullName, "pr_conflict", `${recipient.userId}:${event.number}`)),
      );
      return;
    }

    if (status.mergeable === "CONFLICTING") {
      await pushToRecipients(repoFullName, "pr_conflict", String(event.number), recipients, {
        logLabel: "conflict",
        title: "PR 存在冲突",
        body: `${repoFullName} · #${event.number} ${status.title}`,
        url: status.url,
        level: "timeSensitive",
      });
    }
  } catch (error) {
    console.error("[ci-notifications] conflict push failed", { repoFullName: `${event.owner}/${event.repo}`, number: event.number, error });
  }
}
```

注意：`pushToRecipients` 的 `logLabel` 借道参数对象有点绕；实现时如果发现更干净的写法（例如 notification 与 label 分开两个参数），可以调整——保持行为等价即可，测试为准。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/github/ci-notifications.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/github/ci-notifications.ts src/lib/github/ci-notifications.test.ts
git commit -m "refactor: CI 通知按用户 fan-out，dedup key 加 userId 前缀"
```

---

### Task 5: `deploy_failed` 第四类通知 + webhooks 接线

**Files:**
- Modify: `src/lib/github/ci-notifications.ts`（新增 `notifyDeployFailed`）
- Modify: `src/lib/github/ci-notifications.test.ts`（新增用例）
- Modify: `src/lib/github/webhooks.ts:139-152`（`check_run.completed` handler）

**Interfaces:**
- Consumes: `listNotifiableUsers`（Task 3）、`pushToRecipients`（Task 4，若实现为私有函数则 `notifyDeployFailed` 放同文件直接使用）
- Produces: `notifyDeployFailed(event)`（webhooks.ts 使用；`DeployFailedNotificationEvent` 见「跨任务接口契约」）

- [ ] **Step 1: 写失败测试**

追加到 `src/lib/github/ci-notifications.test.ts`：

```ts
import { notifyDeployFailed, notifyIfConflicting, notifyWorkflowRunOutcome, resolveMergeableStatus } from "./ci-notifications";

function deployEvent(overrides: Partial<Parameters<typeof notifyDeployFailed>[0]> = {}) {
  return {
    installationId: 7,
    repoFullName: "owner/repo",
    checkRunId: 42,
    checkName: "Vercel",
    conclusion: "failure",
    appSlug: "vercel",
    headSha: "abc1234",
    detailsUrl: "https://vercel.com/deploy/1",
    ...overrides,
  };
}

describe("notifyDeployFailed", () => {
  beforeEach(() => {
    sendBarkNotification.mockResolvedValue({ ok: true });
    claimNotification.mockResolvedValue(true);
  });

  it("pushes per recipient when a vercel deploy check fails", async () => {
    await notifyDeployFailed(deployEvent());

    expect(listNotifiableUsers).toHaveBeenCalledWith(7, "deploy_failed");
    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "deploy_failed", "7:42");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({
        title: "Vercel 部署失败 (failure)",
        level: "timeSensitive",
        url: "https://vercel.com/deploy/1",
      }),
    );
  });

  it("ignores non-vercel check apps", async () => {
    await notifyDeployFailed(deployEvent({ appSlug: "github-actions" }));
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("ignores successful or neutral conclusions", async () => {
    for (const conclusion of ["success", "neutral", "skipped", null]) {
      await notifyDeployFailed(deployEvent({ conclusion }));
    }
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("falls back to the commit URL when details_url is absent", async () => {
    await notifyDeployFailed(deployEvent({ detailsUrl: null }));
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ url: "https://github.com/owner/repo/commit/abc1234" }),
    );
  });

  it("does nothing without an installation context", async () => {
    await notifyDeployFailed(deployEvent({ installationId: null }));
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/github/ci-notifications.test.ts`
Expected: FAIL（`notifyDeployFailed` 未导出）

- [ ] **Step 3: 实现 `notifyDeployFailed`**

追加到 `src/lib/github/ci-notifications.ts`（复用 Task 4 的 `pushToRecipients`）：

```ts
const DEPLOY_FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/**
 * Fourth notification kind: a Vercel deploy check went bad. Semantics are
 * carried over 1:1 from the deleted `.github/workflows/deploy-fail-bark.yml`
 * (same app filter, same conclusion set, same copy) — but now the recipients
 * come from user settings instead of a repo-level secret. Deduped per user
 * on the check-run id, so GitHub's at-least-once redelivery stays quiet.
 */
export async function notifyDeployFailed(event: DeployFailedNotificationEvent): Promise<void> {
  if (event.installationId === null) return;
  if (event.appSlug !== "vercel") return;
  if (!event.conclusion || !DEPLOY_FAILED_CONCLUSIONS.has(event.conclusion)) return;

  const recipients = await listNotifiableUsers(event.installationId, "deploy_failed");
  await pushToRecipients(event.repoFullName, "deploy_failed", String(event.checkRunId), recipients, {
    logLabel: "deploy-failed",
    title: `Vercel 部署失败 (${event.conclusion})`,
    body: `${event.repoFullName} · ${event.checkName} · ${event.headSha.slice(0, 7)}`,
    url: event.detailsUrl ?? `https://github.com/${event.repoFullName}/commit/${event.headSha}`,
    level: "timeSensitive",
  });
}
```

- [ ] **Step 4: 在 `webhooks.ts` 接线**

`src/lib/github/webhooks.ts` 顶部 import 增加：

```ts
import { notifyDeployFailed, notifyIfConflicting, notifyWorkflowRunOutcome } from "./ci-notifications";
```

把现有 `check_run.completed` handler（当前以 `if (payload.check_run.pull_requests.length === 0) return;` 开头）改为——deploy 推送放在采样 return 之前，因为部署 check 未必挂在 PR 上：

```ts
webhooksInstance.on("check_run.completed", async ({ payload }) => {
  // Bark push: "Vercel 部署失败". Deliberately before the PR-association
  // return below — Vercel emits deploy checks that aren't attached to a PR,
  // and those are exactly the deploys worth waking someone up for.
  if (payload.check_run.app?.slug === "vercel") {
    after(() =>
      notifyDeployFailed({
        installationId: payload.installation?.id ?? null,
        repoFullName: payload.repository.full_name,
        checkRunId: payload.check_run.id,
        checkName: payload.check_run.name,
        conclusion: payload.check_run.conclusion,
        appSlug: payload.check_run.app?.slug ?? null,
        headSha: payload.check_run.head_sha,
        detailsUrl: payload.check_run.details_url ?? null,
      }),
    );
  }

  if (payload.check_run.pull_requests.length === 0) return;

  const durationSeconds = checkRunDurationSeconds(payload.check_run);
  if (durationSeconds === null) return;

  after(() =>
    recordCheckDuration({
      repoFullName: payload.repository.full_name,
      checkName: payload.check_run.name,
      durationSeconds,
    }).catch((error) => console.error("[webhooks] failed to record check duration", error)),
  );
});
```

同时更新文件顶部第 111 行附近关于 Bark 的注释区（`// Bark push: "存在冲突"` 上方）如有整体描述，补充 deploy_failed 一句。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `npx vitest run src/lib/github/ci-notifications.test.ts && npm run type-check`
Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/github/ci-notifications.ts src/lib/github/ci-notifications.test.ts src/lib/github/webhooks.ts
git commit -m "feat: Vercel 部署失败通知并入应用内（deploy_failed）"
```

---

### Task 6: 设置 API（GET / PUT）

**Files:**
- Create: `src/app/api/settings/notifications/route.ts`

**Interfaces:**
- Consumes: `requireSession()`（已有，`src/lib/auth-guard.ts`）、`getNotificationSettings` / `upsertNotificationSettings`（Task 3）、`parseBarkUrl` / `maskBarkUrl`（Task 2）
- Produces: `GET`/`PUT /api/settings/notifications`（Task 8 前端使用）；本文件内私有 `serializeSettings(settings)` 响应形状：

```json
{
  "barkUrlMasked": "https://bark.example.com/…key7" ,
  "hasBarkUrl": true,
  "notifyCiGreen": true,
  "notifyRetryExhausted": true,
  "notifyPrConflict": true,
  "notifyDeployFailed": true
}
```

**说明：** route handler 是薄封装（解析 + 调 db + serialize），纯逻辑（URL 校验/脱敏）已在 Task 2 测过；按仓库惯例 route 层不写单测（现有 `src/app/api/**` 无测试文件），靠 type-check 与 Task 8 的手动验收。

- [ ] **Step 1: 创建 route handler**

```ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getNotificationSettings, upsertNotificationSettings } from "@/db/notification-settings";
import { maskBarkUrl, parseBarkUrl } from "@/lib/bark";

function serialize(settings: Awaited<ReturnType<typeof getNotificationSettings>>) {
  return {
    barkUrlMasked: settings.barkUrl ? maskBarkUrl(settings.barkUrl) : null,
    hasBarkUrl: settings.barkUrl !== null,
    notifyCiGreen: settings.notifyCiGreen,
    notifyRetryExhausted: settings.notifyRetryExhausted,
    notifyPrConflict: settings.notifyPrConflict,
    notifyDeployFailed: settings.notifyDeployFailed,
  };
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json(serialize(await getNotificationSettings(session.user.userId)));
}

export async function PUT(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  // barkUrl 只取自本端点：null/undefined 语义不同——null 清除配置，
  // undefined 表示这次不动它（只改开关）。
  let barkUrl: string | null | undefined;
  if (typeof input.barkUrl === "string") {
    const trimmed = input.barkUrl.trim();
    if (trimmed === "") {
      barkUrl = null;
    } else {
      barkUrl = parseBarkUrl(trimmed);
      if (!barkUrl) return NextResponse.json({ error: "invalid barkUrl" }, { status: 400 });
    }
  } else if (input.barkUrl === null) {
    barkUrl = null;
  }

  const booleanFields = ["notifyCiGreen", "notifyRetryExhausted", "notifyPrConflict", "notifyDeployFailed"] as const;
  const patch: Record<string, unknown> = {};
  for (const field of booleanFields) {
    if (typeof input[field] === "boolean") patch[field] = input[field];
  }
  if (barkUrl !== undefined) patch.barkUrl = barkUrl;

  const settings = await upsertNotificationSettings(session.user.userId, patch);
  return NextResponse.json(serialize(settings));
}
```

- [ ] **Step 2: 类型检查**

Run: `npm run type-check`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/app/api/settings/notifications/route.ts
git commit -m "feat: 通知设置读取与保存 API"
```

---

### Task 7: 测试推送 API（POST /test）

**Files:**
- Create: `src/app/api/settings/notifications/test/route.ts`

**Interfaces:**
- Consumes: `requireSession()`、`getNotificationSettings`（Task 3）、`parseBarkUrl` / `sendBarkNotification`（Task 2）
- Produces: `POST /api/settings/notifications/test` → `200 { ok: true, status }`（Bark 接受）| `200 { ok: false, status? }`（Bark 拒绝/不可达）| `400 { error }`（没给 URL 且也没存过）。Bark 侧失败仍返回 200——对前端而言"测试已执行、结果是失败"是有效答案。

- [ ] **Step 1: 创建 route handler**

```ts
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getNotificationSettings } from "@/db/notification-settings";
import { parseBarkUrl, sendBarkNotification } from "@/lib/bark";

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let input: Record<string, unknown> = {};
  try {
    input = (await request.json()) ?? {};
  } catch {
    // 无 body 视为"测试已保存的 URL"
  }

  // 允许测试尚未保存的输入（"先测试再保存"），否则回落到已存配置。
  let target: string | null = null;
  if (typeof input.barkUrl === "string" && input.barkUrl.trim() !== "") {
    target = parseBarkUrl(input.barkUrl.trim());
    if (!target) return NextResponse.json({ error: "invalid barkUrl" }, { status: 400 });
  } else {
    target = (await getNotificationSettings(session.user.userId)).barkUrl;
  }
  if (!target) return NextResponse.json({ error: "no barkUrl configured" }, { status: 400 });

  const result = await sendBarkNotification(
    target,
    { title: "PRboard 测试推送", body: "设置页测试推送 · 收到即链路畅通", level: "active" },
    { group: "prboard-test" },
  );
  return NextResponse.json(result);
}
```

- [ ] **Step 2: 类型检查 + 全量测试**

Run: `npm run type-check && npm test`
Expected: PASS（此前所有任务的测试不回归）

- [ ] **Step 3: Commit**

```bash
git add src/app/api/settings/notifications/test/route.ts
git commit -m "feat: Bark 测试推送 API"
```

---

### Task 8: 设置页 UI（Switch 组件 + 表单 + 页面 + 导航入口）

**Files:**
- Create: `src/components/ui/switch.tsx`
- Create: `src/components/notification-settings.tsx`
- Create: `src/app/settings/notifications/page.tsx`
- Modify: `src/components/app-header.tsx:25-33`（`/runners` 链接旁加设置入口）

**Interfaces:**
- Consumes: `GET`/`PUT /api/settings/notifications`、`POST .../test`（Task 6/7）；shadcn 风格组件（Card/Input/Button/sonner）
- Produces: `/settings/notifications` 页面；`<Switch />` 组件

**说明：** `src/components/` 下 `.test.ts` 仅覆盖纯逻辑（无组件渲染测试惯例），本任务验证方式为 `npm run type-check` + `npm run build` + 手动验收（见 Step 5）。

- [ ] **Step 1: 创建 `src/components/ui/switch.tsx`（Base UI 包装，风格对齐现有组件）**

```tsx
"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors outline-none",
        "data-[checked]:bg-primary data-[unchecked]:bg-input",
        "focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-4 rounded-full bg-background shadow-sm ring-0 transition-transform",
          "data-[checked]:translate-x-[18px] data-[unchecked]:translate-x-0.5",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
```

（若 `@base-ui/react/switch` 的 props/子部件命名与上面不符——以 `node_modules/@base-ui/react/switch` 的类型定义为准调整，保持 `checked`/`onCheckedChange` 受控用法。）

- [ ] **Step 2: 创建 `src/components/notification-settings.tsx`**

```tsx
"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";

interface NotificationSettingsResponse {
  barkUrlMasked: string | null;
  hasBarkUrl: boolean;
  notifyCiGreen: boolean;
  notifyRetryExhausted: boolean;
  notifyPrConflict: boolean;
  notifyDeployFailed: boolean;
}

const SWITCH_ITEMS = [
  { key: "notifyCiGreen", label: "CI 全绿", description: "PR 关联的所有检查通过时推送" },
  { key: "notifyRetryExhausted", label: "CI 重试耗尽", description: "自动重试次数用完仍失败时推送" },
  { key: "notifyPrConflict", label: "PR 冲突", description: "PR 与目标分支产生冲突时推送" },
  { key: "notifyDeployFailed", label: "Vercel 部署失败", description: "Vercel 部署检查失败时推送" },
] as const;

type SwitchKey = (typeof SWITCH_ITEMS)[number]["key"];

export function NotificationSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [barkUrlInput, setBarkUrlInput] = useState("");
  const [saved, setSaved] = useState<NotificationSettingsResponse | null>(null);
  const [switches, setSwitches] = useState<Record<SwitchKey, boolean>>({
    notifyCiGreen: true,
    notifyRetryExhausted: true,
    notifyPrConflict: true,
    notifyDeployFailed: true,
  });

  useEffect(() => {
    fetch("/api/settings/notifications")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((data: NotificationSettingsResponse) => {
        setSaved(data);
        setSwitches({
          notifyCiGreen: data.notifyCiGreen,
          notifyRetryExhausted: data.notifyRetryExhausted,
          notifyPrConflict: data.notifyPrConflict,
          notifyDeployFailed: data.notifyDeployFailed,
        });
      })
      .catch(() => toast.error("加载通知设置失败"))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        // 输入框留空 + 已有配置 = 不改动 URL；主动清除走"清除"按钮
        body: JSON.stringify({ ...switches }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "保存失败" }));
        throw new Error(error);
      }
      const data: NotificationSettingsResponse = await res.json();
      setSaved(data);
      toast.success("通知设置已保存");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveBarkUrl() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barkUrl: barkUrlInput.trim() === "" ? null : barkUrlInput.trim() }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "保存失败" }));
        throw new Error(error);
      }
      const data: NotificationSettingsResponse = await res.json();
      setSaved(data);
      setBarkUrlInput("");
      toast.success(data.hasBarkUrl ? "Bark 推送地址已保存" : "Bark 推送地址已清除");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    try {
      const res = await fetch("/api/settings/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(barkUrlInput.trim() === "" ? {} : { barkUrl: barkUrlInput.trim() }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        toast.success("测试推送已发送，请查看手机");
      } else if (res.ok) {
        toast.error(`Bark 服务器拒绝了推送${data.status ? `（HTTP ${data.status}）` : ""}`);
      } else {
        toast.error(data.error === "no barkUrl configured" ? "请先填写并保存 Bark 推送地址" : "测试推送失败");
      }
    } catch {
      toast.error("测试推送失败");
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>通知设置</CardTitle>
        <CardDescription>
          配置 Bark 推送（<a className="underline" href="https://bark.day.app" target="_blank" rel="noreferrer">bark.day.app</a>
          ，iOS App，支持自托管服务器）。在 Bark App 中复制推送 URL 粘贴到下方。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor="bark-url">Bark 推送地址</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="bark-url"
              type="url"
              placeholder={saved?.hasBarkUrl ? `已配置：${saved.barkUrlMasked ?? ""}` : "https://api.day.app/你的 device key"}
              value={barkUrlInput}
              onChange={(event) => setBarkUrlInput(event.target.value)}
              autoComplete="off"
            />
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={handleSaveBarkUrl} disabled={saving}>
                保存地址
              </Button>
              <Button type="button" variant="secondary" onClick={handleTest} disabled={testing}>
                发送测试推送
              </Button>
            </div>
          </div>
          {saved?.hasBarkUrl ? (
            <p className="text-xs text-muted-foreground">当前已配置（{saved.barkUrlMasked}）。填写新地址保存即可替换；如需清除，清空输入框后点"保存地址"。</p>
          ) : (
            <p className="text-xs text-muted-foreground">尚未配置。不配置则不会推送任何通知。</p>
          )}
        </div>

        <Separator />

        <div className="flex flex-col gap-4">
          {SWITCH_ITEMS.map((item) => (
            <div key={item.key} className="flex items-center justify-between gap-4">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{item.label}</span>
                <span className="text-xs text-muted-foreground">{item.description}</span>
              </div>
              <Switch
                checked={switches[item.key]}
                onCheckedChange={(checked) => setSwitches((prev) => ({ ...prev, [item.key]: Boolean(checked) }))}
                disabled={loading}
                aria-label={item.label}
              />
            </div>
          ))}
        </div>

        <Separator />

        <Button type="button" onClick={handleSave} disabled={saving || loading} className="w-fit">
          {saving ? "保存中…" : "保存通知开关"}
        </Button>
      </CardContent>
    </Card>
  );
}
```

注意：若项目没有 `@/components/ui/label`（现有 `src/components/ui/` 里没看到 label.tsx），用普通 `<label htmlFor>` 元素替代，或新增 shadcn label 组件——二选一，别引新依赖。

- [ ] **Step 3: 创建 `src/app/settings/notifications/page.tsx`**

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth-guard";
import { AppHeader } from "@/components/app-header";
import { NotificationSettings } from "@/components/notification-settings";
import { ArrowLeft } from "lucide-react";

export default async function NotificationSettingsPage() {
  const session = await requireSession();
  if (!session) redirect("/login");
  return (
    <div className="flex flex-1 flex-col">
      <AppHeader user={session.user} />
      <main className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
        <Link href="/" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
          返回 PR 看板
        </Link>
        <div className="mx-auto w-full max-w-2xl">
          <NotificationSettings />
        </div>
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 在 `app-header.tsx` 加入口**

在 `/runners` 图标链接（第 26-33 行）旁边加一个同样式的链接（放在它前面）：

```tsx
import { Activity, Bell } from "lucide-react";
```

```tsx
<Link
  href="/settings/notifications"
  aria-label="通知设置"
  title="通知设置"
  className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
>
  <Bell className="size-4" />
</Link>
```

- [ ] **Step 5: 构建与类型检查**

Run: `npm run type-check && npm run build`
Expected: PASS（UI 的 Base UI Switch props 若有出入，此步会暴露——按 `node_modules/@base-ui/react/switch` 的实际类型修正）

- [ ] **Step 6: 手动验收（需要本地数据库，`npm run dev` 后）**

1. 未登录访问 `/settings/notifications` → 跳转 `/login`。
2. 登录后进入页面 → 填入真实 Bark URL → 保存地址 → 手机收到测试推送（点"发送测试推送"）。
3. 刷新页面 → 输入框 placeholder 显示脱敏地址（如 `https://api.day.app/…ab12`）→ 完整 key 不出现在页面源码里。
4. 关掉"CI 全绿"开关保存 → 确认 PUT 生效（刷新后开关状态保持）。

- [ ] **Step 7: Commit**

```bash
git add src/components/ui/switch.tsx src/components/notification-settings.tsx src/app/settings/notifications/page.tsx src/components/app-header.tsx
git commit -m "feat: 通知设置页面与导航入口"
```

---

### Task 9: 清理旧路径 + 全量验证

**Files:**
- Delete: `.github/workflows/deploy-fail-bark.yml`
- Modify: `.env.example`（删除 `BARK_PUSH_URL=` 行）
- Modify: `docs/SETUP.md`（Bark 相关段落改为界面配置说明）

**Interfaces:**
- Consumes: 前 8 个任务全部完成
- Produces: 无残留的旧配置路径

- [ ] **Step 1: 删除 workflow 与 env 条目**

```bash
git rm .github/workflows/deploy-fail-bark.yml
```

编辑 `.env.example` 删除 `BARK_PUSH_URL=` 行。

- [ ] **Step 2: 更新 `docs/SETUP.md`**

搜索 `BARK` / `deploy-fail` 相关段落，替换为：

> **通知配置**：登录后点击顶栏铃铛图标进入"通知设置"，粘贴 Bark App 中的推送 URL 即可。四类通知（CI 全绿 / 重试耗尽 / PR 冲突 / Vercel 部署失败）可独立开关。无需配置任何环境变量或 GitHub secret。

- [ ] **Step 3: 确认无残留引用**

Run: `grep -rn "BARK_PUSH_URL\|deploy-fail-bark" src/ .github/ .env.example docs/ 2>/dev/null | grep -v node_modules`
Expected: 无输出（`.claude/worktrees/` 下的历史 worktree 副本不管）。

- [ ] **Step 4: 全量验证**

Run: `npm test && npm run type-check && npm run build`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: 移除 deploy-fail-bark workflow 与 BARK_PUSH_URL env，文档改为界面配置说明"
```

---

## 验收清单（对照 spec）

- [ ] 未配置 Bark 的用户：四开关默认全开、GET 返回 `hasBarkUrl: false`，所有通知路径静默跳过（行为等同旧 env 未配置）。
- [ ] 配置后：该用户所在 installation 的四类事件按开关推送；其他用户不受影响。
- [ ] 同一事件对同一用户只推一次（webhook 重投/双 run 并发下 dedup 生效），不同用户互不抑制。
- [ ] PR 转为 MERGEABLE 后冲突 claim 清除，再次冲突能再次推送。
- [ ] 完整 device key 不出现在：API 响应、页面 HTML、应用日志。
- [ ] `deploy-fail-bark.yml`、`BARK_PUSH_URL` env/`.env.example` 条目无残留。
- [ ] `npm test`、`npm run type-check`、`npm run build` 全绿。
