# AI Review 集中管理(设置页)设计

日期:2026-10-16 · 状态:待用户审阅

## 目标
在 PRboard 里集中管理所有自有仓库(其他项目、PRboard 自身,以及以后任意仓库)CI 中的 AI review:
- 按仓库手动开关,另有全局暂停
- 切换服务商(Claude OAuth、Anthropic 兼容端点如 GLM 等)、模型、思考等级
- 查看额度/用量;额度不足时自动停用并通知

## 已确认的决策
| 项 | 决定 |
|---|---|
| 范围 | 通用:任意仓库可接入,不限于已有几个 |
| 接入方式 | 各仓库 workflow 一次性加接入步骤;PRboard 不改仓库文件/variables |
| 额度 | 与开关、换模型同期做 |
| PRboard 不可达 | 回退到 workflow 内写死的默认配置继续跑 review |
| 密钥 | 服务商 key 留在各仓库 GitHub Secrets;PRboard 只存 secret 名,不存密钥 |

## 方案
每仓库一个 token(`PRBOARD_TOKEN` secret)。接入逻辑拆成 PRboard 仓库内的两个 composite action;中间的 `claude-code-action` 仍由各仓库自己持有(其他项目 等的 workflow 有大量定制 args,不适合被封装):
1. 开头 `ai-review-config`:`GET /api/ai-review/config`,输出 enabled/model/effort/base-url/secret-name 等
2. 中间(各仓库自己的 step):把输出接进 `claude_args`(`--model`、`--effort`)、`ANTHROPIC_BASE_URL` 与 `secrets[<secret-name>]`
3. 结尾 `ai-review-usage`(`if: always()`):`POST /api/ai-review/usage` 回报用量

鉴权复用 `src/lib/host-ingest-auth.ts`(sha256 哈希 + timingSafeEqual)与 `monitorHostIngestTokens` 的表模式。

## 数据模型(drizzle,3 张表)
- `ai_review_repos`:repo(owner/name,唯一)、enabled、provider_id、model、thinking_level、extra_args(jsonb)、token_hash、updated_at
- `ai_review_providers`:name、kind(`claude-oauth` | `anthropic-compatible`)、base_url、secret_name、budget_limit(可空)、budget_unit(token | usd | count)
- `ai_review_usage`:repo、provider_id、model、input_tokens、output_tokens、pr_number、created_at
- 全局暂停开关:存入现有设置存储或单行配置表(实现计划阶段定)

## 接口
- `GET /api/ai-review/config`(Bearer token):返回 `{enabled, provider, model, thinking, baseUrl, secretName, extraArgs, reason?}`。全局暂停、仓库关闭、预算耗尽时 `enabled:false` 并带 `reason`(`paused` / `disabled` / `budget_exhausted`)。
- `POST /api/ai-review/usage`(Bearer token):写入 usage。
- 设置页的增删改走现有登录鉴权(同 notifications 设置)。

## 设置页 `/settings/ai-review`
- 顶部:全局暂停开关;各服务商额度条(已用/上限)
- 仓库列表:开关、服务商、模型、思考等级、最近一次 review 状态
- 服务商管理:增删改、预算上限
- 新增仓库:生成 token,并展示可粘贴的 YAML 片段与需要设置的 secret 名

## CI 侧行为
- 拉配置成功且 `enabled:false`:跳过 review(明确的主动关闭,不走回退)
- 拉配置失败(超时、5xx、token 无效、PRboard 不可达):使用 workflow 内写死的默认配置继续 review,并输出 warning
- 回报用量失败不影响 job 结果

## 额度
- 兜底(所有服务商通用):usage 累计对比 `budget_limit`;达 90% 页面标黄并 Bark 推送,达 100% 时 config 返回 `enabled:false`
- 增强:有余额接口的服务商做可插拔查询器。第一版只留接口,不实现各家适配(GLM 等接口稳定性未核实)
- Claude OAuth 订阅无公开额度接口,仅靠 usage 统计

## 错误处理与安全
- token 仅存哈希;config 响应不含任何密钥
- config/usage 接口限速并校验 repo 与 token 绑定,防止一个仓库读取另一个的配置
- `extra_args` 需白名单校验,避免通过配置向 action 注入任意参数

## 测试
- 路由测试:鉴权失败、repo/token 不匹配、各 `reason` 分支、usage 写入与预算阈值
- 回退逻辑:composite action 在拉配置失败时的行为(可用 act 或脚本级测试)
- 设置页:增删改与生成 token 的基本交互

## 非目标
- 不改仓库 workflow 文件、不改 GitHub variables
- 不在 PRboard 存服务商密钥
- 第一版不做各服务商余额接口适配

## 待实现计划阶段确认
- `execution_file` 的 usage 字段路径(以真实 run 为准)

## 已在计划阶段解决
- 模型/思考等级:`claude_args` 的 `--model`、`--effort`(其他项目现有 workflow 已在用);自定义端点:`ANTHROPIC_BASE_URL` 加 `anthropic_api_key`
- 全局暂停:单行表 `ai_review_settings`
- 跨私有仓库引用:PRboard 仓库为私有,需在其 Settings → Actions → General → Access 选"Accessible from repositories owned by the user"
- 预算周期:UTC 自然月;单位 token/usd/count
