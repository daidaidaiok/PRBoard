# AI Review 集中管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 PRboard 设置页集中管理各仓库 CI 的 AI review:逐仓库开关、全局暂停、换服务商/模型/思考等级、用量与预算自动停用。

**Architecture:** PRboard 存配置与用量;各仓库 workflow 用两个 composite action(`ai-review-config` 开头拉配置、`ai-review-usage` 结尾回报用量),其间的 `claude-code-action` 仍由各仓库自己的 workflow 持有,只把配置输出接进 `claude_args`/env/secret。机器端点用"每仓库一个 sha256 哈希 token"鉴权,复用 `src/lib/host-ingest-auth.ts`;设置页用现有 `requireSession`。

**Tech Stack:** Next.js 16(先读 `node_modules/next/dist/docs/` 相关章节再写路由/页面)、drizzle-orm + Postgres、zod、vitest、shadcn/base-ui 组件、GitHub composite actions。

**Spec:** `docs/superpowers/specs/2026-10-16-ai-review-settings-design.md`

## Global Constraints
- 服务商密钥只存各仓库 GitHub Secrets;PRboard 只存 `secret_name`,任何响应都不含密钥。
- token 只存 sha256 哈希,明文只在创建/轮换时返回一次。
- 拉配置失败(超时/5xx/token 无效/不可达)→ workflow 用内置默认配置继续 review 并 warning;`enabled:false`(`paused`/`disabled`/`budget_exhausted`)→ 跳过 review,不走回退。
- 回报用量失败不得使 job 失败。
- `extra_args` 只允许白名单值,不得向 action 注入任意参数。
- 预算周期:UTC 自然月;`budget_unit` ∈ `token`(输入+输出)| `usd` | `count`(次数)。
- 预算阈值:≥90% 推 Bark 警告,≥100% config 返回 `enabled:false`。
- 代码风格对齐现有:路由返回 `NextResponse.json`,错误体 `{ error: string }`,DB 访问集中在 `src/db/*.ts`,中文注释。
- 每个 Task 先写失败测试再实现;commit 前跑 `npm run lint && npm run type-check && npm test`。
- 分支从 `staging` 切;迁移用 `npm run db:generate` 生成,不手写 SQL。

## Review Focus
- 仓库 A 的 token 请求仓库 B 的配置(`?repo=` 与 token 绑定不一致)→ 403,不泄露 B 是否存在。
- 预算恰好等于上限、周期跨月边界(UTC 月末最后一毫秒与下月首毫秒)→ 用量按月切分,新月额度重置。
- 服务商被删除/仓库未指定服务商 → config 返回 `enabled:false, reason:"no_provider"`,而非 500。
- `thinking_level`/`model`/`extra_args` 含换行或 `--` 开头的恶意值 → 保存时 400,config 输出前再校验一次。
- usage 重复回报(CI 重试同一 run)→ 以 `(repo, run_id, run_attempt)` 幂等,不重复计费。
- token 轮换后旧 token 立即失效。

---

### Task 1: Schema、迁移与纯函数决策 `resolveReviewConfig`

**Files:**
- Modify: `src/db/schema.ts`(新增 4 表 + 2 个 `notificationKindEnum` 值)
- Create: `src/lib/ai-review-config.ts`
- Test: `src/lib/ai-review-config.test.ts`
- Generated: `drizzle/0009_*.sql` + meta(`npm run db:generate`)

**Interfaces:**
- Produces(schema 导出):`aiReviewSettings`(`userId` PK、`paused` boolean 默认 false、`updatedAt`)、`aiReviewProviders`(`id` uuid、`userId`、`name`、`kind` text `"claude-oauth"|"anthropic-compatible"`、`baseUrl` text null、`secretName` text、`budgetLimit` bigint null、`budgetUnit` text `"token"|"usd"|"count"` null)、`aiReviewRepos`(`id` uuid、`userId`、`repoFullName` 唯一(userId+repo)、`enabled`、`providerId` uuid null→providers `onDelete: set null`、`model` text、`thinkingLevel` text null、`extraArgs` jsonb、`tokenHash` text 唯一、`tokenCreatedAt`、`lastConfigAt` null)、`aiReviewUsage`(`id` serial、`repoId` uuid→repos cascade、`providerId` uuid null、`model`、`inputTokens` int、`outputTokens` int、`costMicroUsd` bigint null、`prNumber` int null、`runId` bigint、`runAttempt` int、`createdAt`;唯一 `(repoId, runId, runAttempt)`)。
- Produces(`notificationKindEnum` 新增):`ai_review_budget_warn`、`ai_review_budget_exhausted`。
- Produces(lib):
  ```ts
  export type ReviewDisableReason = "paused" | "disabled" | "budget_exhausted" | "no_provider";
  export interface ReviewConfigInput {
    paused: boolean;
    repo: { enabled: boolean; model: string; thinkingLevel: string | null; extraArgs: unknown };
    provider: { kind: "claude-oauth" | "anthropic-compatible"; baseUrl: string | null; secretName: string; budgetLimit: number | null; budgetUnit: "token" | "usd" | "count" | null } | null;
    usedThisPeriod: number; // 与 budgetUnit 同单位
  }
  export type ReviewConfigResult =
    | { enabled: true; providerKind: string; baseUrl: string | null; secretName: string; model: string; thinking: string | null; extraArgs: string[] }
    | { enabled: false; reason: ReviewDisableReason };
  export function resolveReviewConfig(input: ReviewConfigInput): ReviewConfigResult;
  export function validateReviewFields(f: { model: string; thinkingLevel: string | null; extraArgs: unknown; baseUrl?: string | null }): { ok: true } | { ok: false; error: string };
  export function budgetStatus(limit: number | null, used: number): "ok" | "warn" | "exhausted";
  export function currentPeriodStart(now: Date): Date; // UTC 当月 1 日 00:00
  ```

- [ ] **Step 1: 写失败测试** `src/lib/ai-review-config.test.ts`,断言:
  - `paused:true` → `{enabled:false, reason:"paused"}`(优先级最高);`repo.enabled:false` → `"disabled"`;`provider:null` → `"no_provider"`
  - `budgetLimit:100, usedThisPeriod:100` → `"budget_exhausted"`;`99` → enabled;`budgetLimit:null` 永不耗尽
  - `budgetStatus(100, 89)==="ok"`、`(100, 90)==="warn"`、`(100, 100)==="exhausted"`、`(null, 1e9)==="ok"`
  - `currentPeriodStart(new Date("2026-10-31T23:59:59.999Z"))` = `2026-10-01T00:00:00.000Z`;`2026-11-01T00:00:00.000Z` → `2026-11-01T00:00:00.000Z`
  - `validateReviewFields`:`thinkingLevel` 仅 `low|medium|high|xhigh|max|null`;`model` 匹配 `/^[A-Za-z0-9._:\/-]{1,100}$/`;`extraArgs` 必须是 `string[]` 且每项在白名单(首版白名单:`--max-turns`、数字值对;实现者在 lib 内定义常量 `ALLOWED_EXTRA_ARGS`)且不含换行;`baseUrl` 必须 `https://`
  - 恶意输入:`model:"x\n--dangerous"`、`extraArgs:["--allowedTools"]`、`baseUrl:"http://x"` 全部 `ok:false`
- [ ] **Step 2: 运行确认失败** — `npx vitest run src/lib/ai-review-config.test.ts` → FAIL(模块不存在)
- [ ] **Step 3: 实现** `src/lib/ai-review-config.ts`,签名见 Interfaces;纯函数、无 IO。
- [ ] **Step 4: 改 `src/db/schema.ts`** 加 4 表与 enum 值(位置紧跟 `userNotificationSettings`,注释说明用途);`npm run db:generate` 生成迁移;检查生成的 SQL 含两条 `ALTER TYPE ... ADD VALUE`。
- [ ] **Step 5: 运行测试通过** — `npx vitest run src/lib/ai-review-config.test.ts` → PASS;`npm run type-check` 通过
- [ ] **Step 6: Commit** — `git add src/db/schema.ts src/lib/ai-review-config.* drizzle && git commit -m "feat: AI review 配置 schema 与决策函数"`

---

### Task 2: DB 层 `src/db/ai-review.ts`

**Files:**
- Create: `src/db/ai-review.ts`
- Test: `src/db/ai-review.test.ts`(参照 `src/db/notification-settings.test.ts` 的 db mock 方式)

**Interfaces:**
- Consumes: Task 1 的表与 `currentPeriodStart`、`hashIngestToken`/`newIngestToken`(`src/lib/host-ingest-auth.ts`)
- Produces:
  ```ts
  export async function authenticateReviewToken(token: string): Promise<{ repoId: string; userId: number; repoFullName: string } | null>; // 按 hash 唯一索引查;命中则更新 lastConfigAt
  export async function loadReviewConfigInput(repoId: string, userId: number, now?: Date): Promise<ReviewConfigInput>; // 含 paused、provider、本期用量(按 budgetUnit 聚合)
  export async function recordReviewUsage(repoId: string, u: { providerId: string | null; model: string; inputTokens: number; outputTokens: number; costMicroUsd: number | null; prNumber: number | null; runId: number; runAttempt: number }): Promise<"recorded" | "duplicate">; // onConflictDoNothing on (repoId, runId, runAttempt)
  export async function createReviewRepo(userId: number, repoFullName: string): Promise<{ repoId: string; token: string }>; // 默认 enabled=false、model 默认值常量 DEFAULT_REVIEW_MODEL
  export async function rotateReviewToken(userId: number, repoId: string): Promise<string | null>;
  export async function listReviewOverview(userId: number): Promise<{ paused: boolean; providers: ProviderWithUsage[]; repos: RepoRow[] }>;
  export async function updateReviewRepo(userId: number, repoId: string, patch: Partial<{ enabled: boolean; providerId: string | null; model: string; thinkingLevel: string | null; extraArgs: string[] }>): Promise<boolean>;
  export async function upsertProvider(...) / deleteProvider(userId: number, id: string): Promise<boolean>; export async function setGlobalPause(userId: number, paused: boolean): Promise<void>;
  export async function deleteReviewRepo(userId: number, repoId: string): Promise<boolean>;
  ```
  所有写入/读取都以 `userId` 限定,跨用户 id 返回 `false`/`null`。

- [ ] **Step 1: 写失败测试**:
  - 同一 `(repoId, runId, runAttempt)` 调两次 `recordReviewUsage` → 第二次 `"duplicate"`
  - `loadReviewConfigInput`:budgetUnit=`token` 时 `usedThisPeriod` = 本期 `input+output` 之和;上月数据不计入;`count` 取行数;`usd` 取 `costMicroUsd/1e6`
  - `authenticateReviewToken("wrong")` → `null`;`rotateReviewToken` 后旧 token → `null`、新 token 命中
  - 他人 `userId` 调 `updateReviewRepo`/`deleteReviewRepo` → `false`
- [ ] **Step 2: 运行确认失败** — `npx vitest run src/db/ai-review.test.ts` → FAIL
- [ ] **Step 3: 实现**上述函数;聚合用 drizzle `sql` 模板(参数化),周期下界取 `currentPeriodStart(now)`。
- [ ] **Step 4: 运行测试通过 + type-check**
- [ ] **Step 5: Commit** — `feat: AI review 数据访问层`

---

### Task 3: 机器端点 `GET /api/ai-review/config`、`POST /api/ai-review/usage`

**Files:**
- Create: `src/app/api/ai-review/config/route.ts`、`src/app/api/ai-review/usage/route.ts`
- Test: 同目录 `route.test.ts`(参照 `src/app/api/hosts/ingest/route.test.ts`)
- 先读 `node_modules/next/dist/docs/` 中 route handler 章节,确认本版本签名

**Interfaces:**
- Consumes: Task 2 的 `authenticateReviewToken`、`loadReviewConfigInput`、`recordReviewUsage`;Task 1 的 `resolveReviewConfig`
- Produces(HTTP 契约,供 Task 7 的 action 使用):
  - `GET /api/ai-review/config?repo=owner/name`,`Authorization: Bearer <43 位 base64url>` → `200 {enabled:true, providerKind, baseUrl, secretName, model, thinking, extraArgs}` 或 `200 {enabled:false, reason}`;token 无效 → 401;`repo` 与 token 绑定仓库不一致 → 403(统一响应体 `{error:"forbidden"}`)
  - `POST /api/ai-review/usage` JSON `{repo, model, inputTokens, outputTokens, costMicroUsd?, prNumber?, runId, runAttempt}`(zod `.strict()`,body ≤ 4096 字符,数值有上限)→ `202 {ok:true,result:"recorded"|"duplicate"}`

- [ ] **Step 1: 写失败测试**:无 header → 401;错 token → 401;token 属仓库 A、`?repo=` 为 B → 403 且不调 `loadReviewConfigInput`;paused/disabled/budget_exhausted/no_provider 各返回对应 `reason`;正常返回的 JSON 不含 `tokenHash`、不含任何密钥字段;usage 超大 body → 413;非法字段 → 400;重复 → `result:"duplicate"`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现两路由**,`bearerToken` 解析沿用 hosts/ingest 的正则;`export const runtime = "nodejs"`;DB 异常返回 502(与 ingest 一致,便于 action 侧识别为"不可达→回退")。
- [ ] **Step 4: 运行测试通过**
- [ ] **Step 5: Commit** — `feat: AI review 配置与用量端点`

---

### Task 4: 预算预警(Bark)

**Files:**
- Modify: `src/app/api/ai-review/usage/route.ts`
- Create: `src/db/ai-review-budget-alert.ts`
- Test: `src/db/ai-review-budget-alert.test.ts`

**Interfaces:**
- Consumes: `budgetStatus`、`loadReviewConfigInput`(取 provider 与本期用量)、`claimNotification`(`src/db/notification-dedup.ts`)、`getNotificationSettings`、`sendBarkNotification`
- Produces: `export async function checkBudgetAlert(repoId: string, userId: number, now?: Date): Promise<"none" | "warn-sent" | "exhausted-sent">` — 以 `dedupKey = "<providerId>:<yyyy-mm>"`、`repoFullName = "ai-review"` 调 `claimNotification`,每个服务商每月每档只推一次;无 Bark URL 时返回 `"none"`。

- [ ] **Step 1: 写失败测试**:用量 89%→`none`;90%→`warn-sent` 且 Bark 被调一次;再次 90%→不重复推;100%→`exhausted-sent`;无 `barkUrl`→`none`;`budgetLimit:null`→`none`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**;usage 路由在 `recorded` 后 `void checkBudgetAlert(...).catch(() => {})`(与 ingest 的 notify 同样 best-effort)。
- [ ] **Step 4: 运行测试通过**
- [ ] **Step 5: Commit** — `feat: AI review 预算预警推送`

---

### Task 5: 管理 API(会话鉴权)

**Files:**
- Create: `src/app/api/settings/ai-review/route.ts`(GET 总览、PUT 全局暂停)、`.../repos/route.ts`(POST 新增)、`.../repos/[id]/route.ts`(PATCH/DELETE)、`.../repos/[id]/token/route.ts`(POST 轮换)、`.../providers/route.ts`(POST)、`.../providers/[id]/route.ts`(PATCH/DELETE)
- Test: 各 `route.test.ts`,模式参照 `src/app/api/settings/notifications/route.test.ts`(mock `requireSession` 与 `@/db/ai-review`)

**Interfaces:**
- Consumes: Task 2 的 DB 函数、Task 1 的 `validateReviewFields`
- Produces(JSON):`GET` → `{paused, providers:[{id,name,kind,baseUrl,secretName,budgetLimit,budgetUnit,usedThisPeriod,status}], repos:[{id,repoFullName,enabled,providerId,model,thinkingLevel,extraArgs,lastConfigAt,lastUsageAt}]}`;`POST /repos` 与 `POST .../token` → `{repoId, token}`(唯一一次返回明文);其余 → 更新后的单行

- [ ] **Step 1: 写失败测试**:未登录全部 401;`validateReviewFields` 失败 → 400;PATCH 他人资源 → 404;`POST /repos` 的 `repoFullName` 不匹配 `/^[\w.-]+\/[\w.-]+$/` → 400;GET 响应不含 `tokenHash`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现路由**;`userId` 一律取自 `session.user.userId`。
- [ ] **Step 4: 运行测试通过**
- [ ] **Step 5: Commit** — `feat: AI review 管理 API`

---

### Task 6: 设置页 `/settings/ai-review`

**Files:**
- Create: `src/app/settings/ai-review/page.tsx`、`src/components/ai-review-settings.tsx`
- Modify: 设置入口处(用 `grep -rn "settings/notifications" src` 找到导航位置,增加"AI Review"链接)
- Test: `src/components/ai-review-settings.test.tsx`(参照现有 components 测试;若无同类测试则测纯展示函数)

**Interfaces:**
- Consumes: Task 5 的 JSON 契约
- Produces: 页面骨架同 `src/app/settings/notifications/page.tsx`(`requireSession` + `AppHeader` + 返回链接);组件用 `Card/Switch/Input/Button/Separator`,`sonner` toast。

- [ ] **Step 1: 写失败测试**:
  - 全局暂停开关切换 → 调 `PUT /api/settings/ai-review` body `{paused:true}`
  - `status:"warn"` 的服务商行显示黄色标记、`exhausted` 显示红色;额度条宽度 = `usedThisPeriod/budgetLimit`(上限 100%)
  - 新增仓库成功后展示 token 与 YAML 片段(含 `PRBOARD_TOKEN` secret 名),关闭后再也不能查看
  - 思考等级下拉只含 `low/medium/high/xhigh/max`
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**;分区:全局暂停 + 服务商额度 / 仓库列表(开关、服务商、模型、思考等级) / 服务商管理 / 新增仓库。每处改动即时 PATCH,失败回滚并 toast。
- [ ] **Step 4: 运行测试通过;`npm run dev` 实际打开页面,用 chrome-devtools/playwright 截图验证布局与深浅色**
- [ ] **Step 5: Commit** — `feat: AI review 设置页`

---

### Task 7: composite actions、PRboard 自接入与文档

**Files:**
- Create: `.github/actions/ai-review-config/action.yml`、`.github/actions/ai-review-usage/action.yml`
- Modify: `.github/workflows/claude-review.yml`(自接入,作为样板)
- Modify: `docs/SETUP.md`(新增"AI Review 集中管理"节:创建 token、设置 secret、Actions 访问权限、YAML 片段)

**Interfaces:**
- `ai-review-config` inputs:`prboard-url`、`token`、`repo`(默认 `github.repository`)、`fallback-model`、`fallback-effort`、`fallback-secret`(仅用于文档说明);outputs:`enabled`(`true|false`)、`source`(`remote|fallback`)、`reason`、`provider-kind`、`base-url`、`secret-name`、`model`、`effort`。行为:curl 带 `--max-time 10 --retry 1`;HTTP 200 解析输出;`enabled:false` → `enabled=false`;非 200/超时/token 为空/解析失败 → `source=fallback`、`enabled=true`、输出 fallback 值并 `::warning::`。shell 显式 `bash`,不得回显 token。
- `ai-review-usage` inputs:`prboard-url`、`token`、`repo`、`execution-file`(claude-code-action 的 `execution_file` 输出)、`model`、`pr-number`、`run-id`、`run-attempt`、`provider-id` 不需要(服务端按仓库配置解析)。行为:`jq` 汇总 token 数与 `total_cost_usd`,POST;任何失败只 `::warning::`,`exit 0`。`token` 为空或 `source=fallback` 时直接跳过。

- [ ] **Step 1: 写 action.yml 两个文件**,风格对齐 `.github/actions/bark-notify-anomaly/action.yml`(中文说明、失败降级)。
- [ ] **Step 2: 先用真实 run 核对 `execution_file` 的 JSON 结构**:`gh run list --workflow claude-review.yml` 取一次成功 run 的日志/产物,确认 usage 字段路径后再写 jq;若无法拿到则在 usage action 内对缺失字段降级为 0 并 warning。
- [ ] **Step 3: 改 `claude-review.yml`**:在 Checkout 后加 config step;`if` 条件加 `steps.cfg.outputs.enabled == 'true'`;`claude-code-action` 增加 `claude_args: --model ${{ steps.cfg.outputs.model }} --effort ${{ steps.cfg.outputs.effort }}`,`env: ANTHROPIC_BASE_URL: ${{ steps.cfg.outputs.base-url }}`,`claude_code_oauth_token` 与 `anthropic_api_key` 按 `provider-kind` 取 `secrets[steps.cfg.outputs.secret-name]`;末尾加 `if: always()` 的 usage step。保留 `HAS_TOKEN` 的现有降级语义。
- [ ] **Step 4: 本地校验** — 用 `actionlint .github/workflows/claude-review.yml`(若本机无则 `brew install actionlint`);另跑 `.github/workflows/workflow-file-guard.yml` 与 `workflow-drift-check.yml` 的本地等价检查,确认不被拦。
- [ ] **Step 5: 端到端验证**(在测试 PR 上):① 设置页建仓库+服务商并启用 → review 正常跑且 usage 入库;② 设置页关闭 → job 显示跳过;③ 把 `prboard-url` 临时指向不可达地址 → fallback 并 warning、review 照跑;④ 预算设为极小 → 下一次返回 `budget_exhausted` 并收到 Bark。
- [ ] **Step 6: Actions 访问权限** — 在 PRboard 仓库 Settings → Actions → General → Access 选"Accessible from repositories owned by the user"(私有仓库的 action 才能被 其他项目引用);写入 SETUP.md。此为需用户在 GitHub 网页上手动确认的步骤。
- [ ] **Step 7: Commit** — `feat: AI review composite actions 与 PRboard 自接入`

---

## 后续(不在本计划内)
- 其他项目接入:各自一个 PR,按 SETUP.md 片段把 config/usage 两步接进其 `web-claude-review.yml`/`claude-review.yml`(同类项目的 workflow 有 `workflow-drift-check`,需先确认不被拦)。
- 有余额接口的服务商(GLM 等)的可插拔额度查询器。
