# Runner 监控与主机容量三项修复

日期：2026-10-03
状态：已实施（PR → staging）
模式：/ship 描述模式（无工单）

## 背景

用户在 Runner 监控页看到三个问题：

1. **进行中/排队中的任务看不到主机容量与性能**——PR 跑起来时想知道「在哪个主机上跑、那台机器现在什么状态」，界面没有任何展示。
2. **Runner 监控好像要手动刷新**——组件虽有 5 分钟静默轮询，但回前台、任务开始/结束时都不会立即更新，忙碌状态经常是旧的。
3. **「主机容量加载失败：host capacity unavailable」**——自 PR #57（2026-10-02 部署）起 100% 复现。

## 根因（问题 3）

`src/db/host-monitor.ts` 的 `buildBucketQuery` 用 `sql<Date>` 包 `date_bin()` 聚合表达式。
drizzle 的 driver 值 → Date 映射（`mapFromDriverValue`）只作用于**表列**；raw sql 片段
不做映射，postgres-js 返回的是 Postgres 文本格式字符串（`"2026-10-02 15:45:00+00"`）。
`listMonitorCapacityDomains` 把它直接塞进 `CapacityMetric.capturedAt`，
`buildCapacityDomains` 调 `.getTime()` 抛
`TypeError: metric.capturedAt.getTime is not a function`，`/api/hosts` GET 统一兜底成
502 `{ error: "host capacity unavailable" }`。

已有单测没拦住：`bucketRowFixture` 的 `bucketStart` 用了 `new Date(...)`，与驱动真实
返回（字符串）脱节——mock 越贴近驱动行为，这类回归才测得到。

## 方案

### Fix A：bucketStart 日期转换（修问题 3）

- `buildBucketQuery` 的 `bucketStart` 类型改为诚实的 `sql<string>`。
- `listMonitorCapacityDomains` 拼装 metrics 时在边界做 `new Date(row.bucketStart)`，
  保证进入 `buildCapacityDomains` 的 `CapacityMetric.capturedAt` 恒为 Date。
- `bucketRowFixture` 改用驱动真实格式（`"YYYY-MM-DD HH:mm:ss+00"` 字符串），
  新增断言：domains 构建成功且 `latestMetric.capturedAt` 是 Date。
- Node 侧 `new Date("2026-10-02 15:45:00+00")` 解析可靠（仅服务端执行，无 Safari 兼容问题）。

### Fix B：Runner 监控自动刷新（修问题 2）

`RunnerMonitor` 在保留 5 分钟轮询兜底的基础上：

- **SSE 订阅** `/api/events`：任何 `update` 事件（含 check_run/workflow_run webhook
  与 host-metrics）触发节流刷新（`RUNNER_SSE_MIN_REFRESH_MS = 60_000`）。忙碌状态恰好
  在 job 开始/结束（check_run 事件）时翻转，这是无 GitHub runner webhook 下最近的
  实时方案。复用 `parseRealtimeEvent`；节流判断内联（runner 刷新不关心 reason 类型，
  与 `shouldRefreshOnHostEvent` 的 host-only 过滤语义不同，不复用该函数）。
- **visibilitychange**：标签页从隐藏转可见且距上次成功拉取超过 30s 时立即刷新。
  这是「回来看到旧数据只能手点刷新」体验的直接修复。
- 手动刷新按钮保留（兜底 + 用户显式意图）。

### Fix C：进行中/排队中展示主机容量与性能（修问题 1）

新增聚合端点 `GET /api/runners/active`（会话鉴权），一次返回：

```
{ checkedAt, jobs: ActiveJobItem[] }

ActiveJobItem {
  repoFullName, workflowRunId, workflowName,
  jobName, status: "queued" | "in_progress",
  startedAt, htmlUrl,
  runnerName: string | null,        // queued 时为 null
  host: {                           // runnerName 能关联到 monitorHosts 时才有
    displayName, platform, stale,
    cpuUsageBasisPoints, memoryUsedMib, memoryTotalMib, load1
  } | null
}
```

服务端实现（复用现有件）：

1. `listWorkflowRuns(userId)`（现成，每 repo per_page 50）→ 过滤
   `status ∈ {queued, in_progress}` 的 runs（通常 0–3 个）。
2. 对每个活跃 run 调 `listWorkflowRunJobs`（现成，含 `runner_name`/labels）→
   过滤 `status ∈ {queued, in_progress}` 的 job。
3. 新增 `getActiveHostSnapshots(userId, runnerNames[])`（放 `host-monitor.ts`）：
   按 `runnerName` 查 `monitorHosts` + `selectDistinctOn` 最新样本，输出快照。

UI（`RunnerMonitor`）：「进行中 / 排队中」区块，按主机分组（未分配 runner 的排入
「排队中 · 等待空闲 Runner」桶）；主机行内联 CPU/内存/Load 芯片（stale 标灰），
任务行显示 workflow/job 名、仓库、运行时长、详情链接。数据与 runners 同周期获取
（轮询/SSE/可见性三条触发路径共用一次 `fetchActiveJobs`）。

## 范围外（有意不做）

- PR 看板卡片上的 per-check tooltip 不加主机信息——端点数据可复用，后续要加是小改。
- runner 监控数据不做 DB 快照层（GitHub 直查保持现状，egress 无新增 GitHub 调用：
  活跃 runs 数量小，且只在页面打开时拉）。

## 验收标准

- [ ] 生产库上 `/api/hosts` 返回 200 与 domains（不再 502）。
- [ ] `bucketRowFixture` 用字符串 bucketStart 时单测通过；故意去掉转换时单测失败（已验证 RED）。
- [ ] Runner 监控页：切后台再回前台（>30s）后 2s 内自动刷新「最近检查」。
- [ ] SSE 事件到达时（webhook/ingest）Runner 列表节流刷新。
- [ ] 有任务运行时，「进行中 / 排队中」区块按主机分组展示任务与该主机 CPU/内存/Load；queued 任务进入等待桶。
- [ ] lint / type-check / test / build 全绿。
