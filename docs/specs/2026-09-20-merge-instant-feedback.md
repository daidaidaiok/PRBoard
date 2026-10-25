# 合并确认后的即时反馈（merge-instant-feedback）

日期：2026-09-20 ｜ 模式：描述模式（无关联工单）

## 问题

用户点击「确认合并」后到 PR 卡片从列表消失之间有一段静默空窗，期间卡片仍以"可合并"状态展示，用户容易以为没点上而去重复操作或去点别处。空窗由三段组成：

1. **POST 往返**：`POST /api/prs/merge` → GitHub merge API，0.5–3s+。期间确认按钮只是变灰，没有"合并中"的加载态，取消按钮也仍可点。
2. **全量 refetch**：成功后 `await fetchPrs()` 重新拉 `/api/prs`（GitHub search API），1–5s。toast 已出，但卡片原地不动。
3. **search 索引滞后**：`/api/prs` 走 `is:pr is:open` 搜索（代码注释自认 "eventually consistent"）。即使 refetch 完成，返回的列表**仍可能包含刚合并的 PR**——卡片以"可合并"状态复活，空窗可达几十秒。

## search-first 结论

复用（Compose）仓库现有模式：`pendingKey` 挂起态、`Set` 瞬态状态（`readyPrs` 同款）、sonner toast、源码断言式组件测试（`dashboard.tabs.test.ts` 等 3 处先例）。React 19 内置 `useOptimistic` 评估后**不采用**：action 结束自动回滚，而 search 索引滞后意味着回滚时服务端列表仍含该 PR，卡片复活、问题原样复现；本场景是"终态标记 + 服务端确认滞后"，需要手动终态集合。不新增依赖。

## 方案（选定的推荐项：前端乐观终态 + 加载态）

**A. 乐观终态 + 合并中加载态（选定）**
- `mergedPrIds: Set<string>` 状态：`confirmMerge` 成功瞬间把该 PR id 加入；派生 `displayPrs = prs` 过滤掉已合并 id，并让顶部计数、项目 tab 计数、卡片列表全部消费 `displayPrs`——卡片即时消失，且即使后续 refetch 被 search 滞后带回来也持续被过滤（合并是终态，会话内永久过滤是安全的）。
- 成功后 `fetchPrs` 改为后台触发（不 await），toast 即出、弹窗即关。
- 确认按钮加 spinner +「合并中…」；pending 期间禁用取消按钮并阻止关闭弹窗（外点/Esc）。
- `finally` 里清 `pendingKey` 改为带守卫（只有仍属于自己的 key 才清），防止并发操作 B 时 A 的完成回调把 B 的挂起态误清。

**B. React 19 `useOptimistic`（否决）**：见 search-first 结论——回滚时机与服务端确认时机不匹配。

**C. 服务端精确刷新（否决）**：webhook→NOTIFY→SSE 链路已存在，但 SSE 只触发 refetch，真正列表仍走 search API，滞后原样存在；为几秒空窗加"单 PR REST 查询端点 + 前端对账"复杂度不划算。

## 验收标准

- [ ] 点击「确认合并」后按钮立即显示加载态（spinner + 合并中…），取消按钮与弹窗关闭在等待期间不可用
- [ ] 合并成功瞬间（不等 refetch）该 PR 卡片从列表消失，顶部「N 个待处理 PR」与项目 tab 计数同步减少
- [ ] 后续 refetch 因 search 索引滞后带回该 PR 时，卡片不会复活
- [ ] 合并失败时卡片保留、报错 toast，行为与现状一致
- [ ] 并发操作（A 等待中操作 B）不会互相误清挂起态
- [ ] `npm run lint` / `npm run type-check` / `npm run test` 全绿
