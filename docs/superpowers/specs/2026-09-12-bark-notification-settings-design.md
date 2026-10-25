# Bark 通知设置界面化（用户级配置）设计

日期：2026-09-12
状态：已获用户批准的设计，待实现

## 背景

PRboard 计划开源。当前的 Bark 推送配置依赖环境变量（应用内通知读 `BARK_PUSH_URL` env）和 GitHub Actions secret（`deploy-fail-bark.yml` workflow），存在两个问题：

1. **配置不可发现**：部署环境（Vercel）和仓库 secrets 里都没有配置过这个值（已确认 `vercel env ls` 无 `BARK_PUSH_URL`、`gh secret list` 为空），所以通知从未真正发出过。开源后每个部署者都要自己摸索 env/secret 配置，体验差。
2. **单租户假设**：env 是全局单值，隐含"整个部署只有一个人收通知"。开源后是多用户场景（每个用户有自己的 GitHub App installation 和自己的手机）。

目标：把 Bark 配置搬到 Web 界面里，由每个登录用户自己填写，存数据库，按用户生效。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 通知接收人 | 只推给该 installation 关联的安装者本人（经 `user_installations` 关联） |
| 通知开关粒度 | 按类型独立开关，默认全开 |
| 存储维度 | 用户级（`user_notification_settings` 表），非 installation 级 |
| Vercel 部署失败通知 | 并入应用内第四类通知（`deploy_failed`），删除 `deploy-fail-bark.yml` workflow |
| env 兼容 | 彻底移除 `BARK_PUSH_URL` env 读取，不做 fallback |

## 数据模型

新表 `user_notification_settings`（Drizzle 迁移，追加到 `src/db/schema.ts`）：

```ts
export const userNotificationSettings = pgTable("user_notification_settings", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  barkUrl: text("bark_url"), // 完整推送 URL（含 device key）；null = 未配置 Bark
  notifyCiGreen: boolean("notify_ci_green").notNull().default(true),
  notifyRetryExhausted: boolean("notify_retry_exhausted").notNull().default(true),
  notifyPrConflict: boolean("notify_pr_conflict").notNull().default(true),
  notifyDeployFailed: boolean("notify_deploy_failed").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

语义约定：

- 行按需创建：用户第一次保存设置时才 upsert。没有行的用户视同"四开关全开 + 未配置 Bark"。
- `barkUrl` 形如 `https://<bark-server>/<device-key>`（与现 `bark.ts` 的 URL 拼接逻辑兼容，自托管 bark-server 同样适用）。
- `barkUrl` 在数据库中明文存储。理由：device key 只是"能给你推消息"的凭证，不含其他账号权限；项目现有威胁模型中数据库凭据已受控；项目内已有更敏感的 `GITHUB_APP_PRIVATE_KEY` 以 env 明文形式存在。GET API 层做脱敏（见下）。

## 推送链路改造

### `src/lib/bark.ts`

- `sendBarkNotification(barkUrl: string, notification: BarkNotification)`：改为接收显式 URL 参数；删除 `process.env.BARK_PUSH_URL` 读取。函数签名变化由调用方适配。
- 保留现有 URL 拼接语义（body 作为 path 段、`group=prboard-ci`、`level` query 参数）。
- 失败仍走现有 `console.error`（不打 URL 本身，避免 device key 进日志）。

### 新增 `notifyInstallationUsers`（放在 `src/lib/github/ci-notifications.ts` 或 bark 侧，实现时按内聚性定）

```
notifyInstallationUsers(installationId, kind, notification)
```

1. 查 `user_installations` join `user_notification_settings`，条件：`installationId` 匹配、`barkUrl IS NOT NULL`、对应 `kind` 的开关为 true。
2. 无匹配用户则静默返回（与现状"未配置就跳过"一致）。
3. 对每个用户推送（`Promise.allSettled`，单用户失败只记日志，不影响其他用户，也不影响 webhook 处理）。

`kind` 枚举扩展：现有 `notificationKindEnum`（`ci_green | ci_retry_exhausted | pr_conflict`）新增 `deploy_failed`。

### 去重修正（多用户正确性）

现有 `notification_dedup` 的唯一键是 `(repoFullName, kind, dedupKey)`，是全局去重。改为按用户推送后，第一个用户 claim 成功会把后续用户的推送全部挡掉。修正：`dedupKey` 统一加 `userId` 前缀，即 `"<userId>:<原dedupKey>"`，实现每用户独立去重。

各 kind 的 dedupKey：

- `ci_green`：`"<userId>:<pr>:<headSha>"`（原 `<pr>:<headSha>`）
- `ci_retry_exhausted`：`"<userId>:<workflowRunId>:<runAttempt>"`（原同构）
- `pr_conflict`：`"<userId>:<pr>"`（原 `<pr>`；`MERGEABLE` 时 clear 的 key 同步带 userId）
- `deploy_failed`：`"<userId>:<checkRunId>"`

### 第四类通知触发（`deploy_failed`）

在 `src/lib/github/webhooks.ts` 现有 `check_run.completed` handler 中新增（与时长采样并列，均走 `after()`）：

- 触发条件与原 workflow 语义一致：`check_run.app.slug === 'vercel'` 且 `conclusion ∈ {failure, timed_out, cancelled, action_required}`。
- 收件人：`payload.installation?.id` 对应的用户（`installation` 为 null 时跳过）。
- 推送内容沿用原 workflow 文案风格：标题 `Vercel 部署失败 (${conclusion})`，body 含 `repo · check 名 · 短 SHA`，`level=timeSensitive`，url 指向 check 的 `details_url`。
- 走 `notifyInstallationUsers(installationId, "deploy_failed", ...)`，去重同上。

### 删除 workflow 路径

- 删除 `.github/workflows/deploy-fail-bark.yml`。
- `.env.example` 移除 `BARK_PUSH_URL` 条目。
- `docs/SETUP.md` 中相关 secret/env 配置说明改为"在界面设置页配置 Bark"。

## API

三个端点，均复用 `requireSession()`（`src/lib/auth-guard.ts`）鉴权，未登录返回 401。

### `GET /api/settings/notifications`

返回（无行时返回默认值）：

```json
{
  "barkUrlMasked": "https://bark.example.com/…Key4",
  "hasBarkUrl": true,
  "notifyCiGreen": true,
  "notifyRetryExhausted": true,
  "notifyPrConflict": true,
  "notifyDeployFailed": true
}
```

`barkUrlMasked` 脱敏规则：保留协议与 host，path 部分（device key）只显示末 4 位，中间以 `…` 代替；未配置时为 `null`。**完整 URL 永不返回给前端**（前端无需回显，覆盖输入即可更换）。

### `PUT /api/settings/notifications`

Body：`{ barkUrl?: string | null, notifyCiGreen?: boolean, notifyRetryExhausted?: boolean, notifyPrConflict?: boolean, notifyDeployFailed?: boolean }`

- `barkUrl` 校验：非 null 时必须是合法 `http(s)` URL（`new URL()` 解析 + protocol 检查），非法返回 400。允许尾随 `/`（保存时归一化去掉，与 `bark.ts` 现有 `replace(/\/$/, "")` 逻辑一致）。
- `barkUrl: null` 表示清除配置（开关保留）。
- upsert 当前行，返回与 GET 相同结构。

### `POST /api/settings/notifications/test`

Body：`{ barkUrl?: string }`（可选——提供则测试该 URL（允许"未保存先测试"），否则测试已存 URL；两者皆无返回 400）。

- 实际向 Bark 发送一条测试推送（标题"PRboard 测试推送"），把 Bark 服务器的响应状态返回给前端：`{ ok: true }` 或 `{ ok: false, status: 404 }`。
- 不写库、不受开关/dedup 影响。

## UI

- 新页面 `/settings/notifications`（Next.js App Router route），服务端组件骨架 + 客户端表单，登录可见（未登录走现有登录流程）。
- `app-header` 增加"设置"入口（现有导航模式）。
- 表单（shadcn/ui）：
  - Bark URL 输入框（placeholder 提示"在 Bark App 中复制推送 URL，形如 https://api.day.app/xxx"）。"保存地址"按钮单独提交 URL：输入新地址保存即替换；清空输入框后保存即清除配置（清空语义只作用于"保存地址"，通知开关的保存不触碰 URL，避免误清除）。
  - 四个通知类型 Switch（需新增 shadcn `switch` 组件，当前 `src/components/ui/` 没有）。
  - "发送测试推送"按钮（调用 test API，结果用现有 sonner toast 反馈）。
  - "保存"按钮（成功/失败 toast）。
- 页面附简短说明：四类通知各自的触发时机；指向 https://bark.day.app 的下载/自托管说明。
- 移动端沿用现有页面的响应式模式。

## 测试

- `src/lib/bark.test.ts`：
  - 适配显式 URL 参数签名（删除 env 相关用例）。
  - URL 拼接、失败日志等既有行为回归。
- `src/lib/github/ci-notifications.test.ts`：
  - dedupKey 带 userId 前缀的各 kind 用例。
  - 开关关闭 / barkUrl 为 null 的用户不被推送；多用户 fan-out（一个失败不影响另一个）。
- 新增 `deploy_failed` 触发逻辑测试（check_run 结论集合、slug 过滤、installation 为 null 跳过）。
- API 校验逻辑测试：barkUrl 非法 400、脱敏格式正确、未登录 401。

## 安全与隐私

- 完整 barkUrl 不通过 GET API 返回（只有脱敏版）；不写入应用日志。
- test API 允许测试任意调用者提供的 URL——仅登录用户可调用，且该能力（向任意 URL 发一条固定文案 GET 请求）与登录用户在浏览器里直接 fetch 无本质差别，不做额外限制。
- 所有写操作要求登录 session；用户只能读写自己的设置行（userId 取自 session，不取自请求体）。

## 范围外（明确不做）

- 其他推送渠道（Telegram/邮件/飞书等）——表结构留了扩展空间（加列），本版不做。
- 按仓库粒度的通知开关。
- 通用 check 失败通知（`deploy_failed` 仅匹配 `app.slug === 'vercel'` 的 check run，与原 workflow 语义一致；其他 CI 的失败已由 `ci_retry_exhausted` 覆盖）。
- 存量 env 值迁移——`BARK_PUSH_URL` 从未被配置过，无存量数据。
