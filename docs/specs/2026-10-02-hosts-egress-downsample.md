# /api/hosts egress 流量黑洞修复：SQL 侧 15min 桶聚合 + 轮询拉长 + SSE 事件驱动

日期：2026-10-02
状态：已定稿（方案 A 自动采用——任务描述即完整规格，含量化验收线）

## 背景

宿主 Supabase 组织 Free plan 月度 egress（5GB）被本项目烧穿（本周期 129.1GB / 5GB），
组织下全部项目 402。10-11 周期重置前必须合入。

根因（已核对源码确认）：
1. `src/db/host-monitor.ts` `listMonitorCapacityDomains()` 把所有主机最近 24h 的
   **每一条原始样本**（8 主机 × 1440~2880 条）整表拉到 Node（每请求 DB→Node 约 6-9MB），
   然后才在 `buildCapacityDomains` 里做聚合。
2. `host-capacity-monitor.tsx` 每 30s 盲轮询 `/api/hosts`（2880 次/天）。

**口径澄清（实测代码得出）**：HTTP 响应体本身只有 ~50KB（`hourly` 已是 1h 桶 24 点、
无原始样本数组）——任务描述里「响应体 5-9MB」实为 DB→Node 的 Supabase 计费口径。
Supabase egress 计的是数据库出站流量，所以**聚合必须完全在 SQL 侧完成**（GROUP BY
`date_bin`），Node 只收聚合行；把原始行拉到 Node 再丢不省任何 egress。

search-first 结论：Build 聚合 SQL（本仓 rg 无 date_trunc/date_bin/groupBy 先例；
drizzle-orm 0.45 原生 `sql\`\`` 模板 + PG14+ `date_bin`，零新依赖）；Extend 复用
`src/db/realtime.ts` 的 NOTIFY/LISTEN 基建（`notifyUpdate`/`subscribeToUpdates`）；
Compose 前端 EventSource 模式照抄 `dashboard.tsx`。

## 方案 A（采用）

### 1. 服务端 SQL 侧聚合（主修复）

`listMonitorCapacityDomains()` 重写为三条查询：

1. hosts 查询不变；
2. **桶聚合**：`GROUP BY host_id, date_bin(interval '15 minutes', captured_at,
   timestamp '2001-01-01 00:00:00+00')`，24h 窗口 → 每主机 ~96 桶、总量 768 行
   （DB→Node 从 ~6-9MB 降到 ~60KB）；
3. **每主机最新 1 条原始行**：`selectDistinctOn([hostId])` + `orderBy(hostId,
   capturedAt desc)`，共 8 行，保证 `latestMetric` 仍是实时值（最新桶起点落后采样
   至多 15min，不合并会破坏「≤2 分钟看到新数据」验收）。

桶值聚合语义（保守容量判定方向）：
- cpu/memory/disk/swap、runner worker/listener：`max`（容量监控宁保守不冒进；
  p95(max) ≥ p95(avg)，不会误报「可扩容」）
- network rx/tx、load1：`avg`（持续流量/负载均值才有意义）
- 全部标量显式 `::int4` / `::float8` cast——postgres 驱动对 bigint/numeric 聚合
  返回 string，不 cast 会在 Node 侧出现字符串数值

桶行映射为既有 `CapacityMetric` 形状（`capturedAt` = 桶起点），与 latest 原始行合并
后喂给 `buildCapacityDomains` —— 该函数的 p95/diskMax/runnerBusy/hourly（Node 侧
1h 再聚合）逻辑**零改动**兼容：
- latest 原始行 capturedAt 最大，`mostRecent` 自动选中它 → 实时值 ✓
- 覆盖率：`buildCapacityDomains` 新增可选参数 `{ bucketMs?, expectedDailySamples? }`
  （默认值保持旧行为 1440，向后兼容现有 7 个测试）；`/api/hosts` 路径传
  `expectedDailySamples = 96`，避免桶行数 97/1440 = 6.7% 触发「永远 collecting」
- 24h 窗口过滤放宽 `bucketMs`：最早的部分桶（桶起点早于窗口起点、但桶内数据全在
  窗口内）不被 `buildCapacityDomains` 误丢

### 2. 前端轮询拉长 + SSE 事件驱动

- `host-capacity-monitor.tsx`：`POLL_INTERVAL_MS` 30s → 300s（兜底）；
  新增 EventSource(`/api/events`) 订阅，`reason === "host-metrics"` 的事件触发刷新，
  统一节流窗 `SSE_MIN_REFRESH_MS = 90s`（事件与轮询共用「距上次成功拉取」时间戳）。
- `runner-monitor.tsx`：`POLL_INTERVAL_MS` 30s → 300s（payload 小，纯常数改动，
  不接 SSE——范围控制）。
- 节流/事件解析抽成 `src/lib/realtime-events.ts` 纯函数（可单测）：
  - `parseRealtimeEvent(data): { reason?: string } | null`
  - `shouldRefreshOnHostEvent(payload, lastRefreshAt, now, minMs): boolean`

### 3. ingest → NOTIFY → SSE

- `realtime.ts` `UpdatePayload` 加可选 `userId?: number`。
- `realtime.ts` `subscribeToUpdates` 消费侧（`/api/events` route）增加过滤：
  `payload.userId !== undefined && payload.userId !== session.user.userId` → 不下发
  （host 数据按 userId 隔离；现有 repoFullName 过滤语义不变，`userId === undefined`
  的 webhook 事件行为不变）。
- `ingest/route.ts`：`recordHostMetric` 返回 `accepted` 后
  `void notifyUpdate({ repoFullName: "", reason: "host-metrics", userId }).catch(() => {})`
  ——fire-and-forget，不影响 ingest 响应路径；HMAC 认证与 `recordHostMetric` 事务
  零改动。
- `dashboard.tsx` 的 update handler 必须解析 payload、`reason === "host-metrics"`
  时忽略——否则 host 每 30s 的 notify 会反向触发 PR 面板全量刷新，把黑洞搬家。

## 验收核算（PR 里按此口径写）

| 指标 | 修复前 | 修复后 | 线 |
|---|---|---|---|
| DB→Node / 请求（Supabase 计费口径） | ~6-9MB（1.5-2.3 万行） | ~60KB（768 桶行 + 8 latest + hosts） | — |
| 日 DB egress（页面 24h 常开最坏：960 次/天，90s 节流上界） | ~17-26GB | ~58MB | ≤100MB ✓ |
| 单次 GET /api/hosts 响应体 | ~50KB | ~55KB（hourly 仍 1h 桶 24 点） | ≤300KB ✓ |
| 新数据可见延迟（SSE 路径） | 轮询间隔 30s | 最坏 90s 节流 + 30s ingest 间隔 = 120s | ≤2min ✓ |
| ingest 路径 | — | 采集频率 / HMAC / RETENTION_MS 零改动 | ✓ |

日请求次数上界推导：SSE 事件最高频 = 24×3600/90 = 960 次/天（轮询 300s 间隔在
90s 节流窗内被吞，不叠加）。

## 风险点

- **date_bin 需 PG14+**：Supabase 当前 PG15+，满足；语法风险由 toSQL 单测 +
  route 既有 502 兜底覆盖（真连库的运行时验证只能部署后观察，本地无 PG）。
- **驱动返回 string**：全部聚合标量显式 cast 消除。
- **coverage 归零回归**：expectedDailySamples 参数化，测试覆盖「不传参数 = 旧行为」。
- **notify 反向放大**：dashboard handler 过滤 host 事件，测试覆盖。
- **并行会话分支争用**：已知仓库风险，push 趁早、不擅自切分支。

## 测试计划

- `src/lib/host-capacity.test.ts` 增补：bucketMs/expectedDailySamples 行为、部分桶
  不丢、默认参数旧行为回归。
- 新 `src/db/host-monitor.test.ts`：drizzle.mock() + toSQL 断言聚合 SQL 结构
  （date_bin、cast、groupBy）；桶行→CapacityMetric 纯映射测试；空主机列表返回 []。
- 新 `src/lib/realtime-events.test.ts`：事件解析、reason 过滤、节流窗边界。
- `src/app/api/hosts/ingest/route.test.ts` 增补：accepted 触发 notifyUpdate、
  rate-limited/duplicate 不触发、notify 抛错不影响 202。
- `src/app/api/events` 过滤逻辑与 `dashboard.tsx` 忽略 host 事件：按现有组件测试
  模式（源码断言）覆盖。

## 范围外（明确不做）

- 不重构 host-monitor 其他函数（create/delete/auth）
- 不动 ingest HMAC 与 `recordHostMetric` 事务
- 不引入物化视图/TimescaleDB/新依赖
- 不给 runner-monitor 接 SSE
