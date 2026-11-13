# Plan: PR 卡片 review 门禁徽章

Spec: docs/specs/2026-11-14-review-gate-badge.md
栈判定：纯前端 UI（Next 16 + React 19 + Tailwind 4），单栈。风险档：轻量（单组件展示层，无数据/schema/鉴权）。

## Task 1 — RED：review 门禁徽章测试（串行）

`src/components/pr-card-view.test.tsx` 新增 describe：

1. CHANGES_REQUESTED（展开视图）→ html 含「待修复」、`CircleX` 图标；合并按钮 `disabled`。
2. REVIEW_REQUIRED（展开视图）→ 含「待 review」、`CircleDashed`；按钮 disabled。
3. APPROVED + MERGEABLE（展开视图）→ 含「可合并」、`GitMerge`；按钮不带 disabled。
4. CONFLICTING → 不含「可合并」（冲突按钮接管）。
5. reviewDecision null + mergeable UNKNOWN → 不含「待修复」「待 review」「可合并」。
6. CHANGES_REQUESTED（精简视图）→ 含「待修复」。

验证 RED：`npx vitest run src/components/pr-card-view.test.tsx` 全部新用例失败且原因正确。

## Task 2 — GREEN：实现 reviewGateBadge（串行，依赖 Task 1）

`src/components/pr-card.tsx`：

1. 新增导出 `reviewGateBadge(pr: PullRequestSummary): ReactNode | null`，按 spec 优先级表返回 Badge 或 null。
2. 展开视图：Draft 徽章后插入 `{reviewGateBadge(pr)}`。
3. 精简视图：rollupBadge 后插入同一调用。

验证 GREEN：过滤测试跑绿 + 全量 `npm test` 不回归。

## Task 3 — REFACTOR + 全量校验（串行）

- 视检查结果微调（预计无）。
- Phase 4 全量：lint → format → type-check → test。

依赖分组：三 Task 严格串行（TDD 红绿依赖），无并行分支，主会话 inline 执行。

## 风险点

- 「可合并」与 rollup「通过」徽章同屏图标语义重复 → 用 GitMerge 图标区分。
- Badge 在精简视图一行可能挤压标题 → 徽章 shrink-0，标题已有 min-w-0 truncate。
- 踩坑库：无直接相关条目（radius token 用现有 Badge 组件样式，不手写圆角）。

## 验收标准

见 spec 5 条复选框，全部通过后进 Phase 4。
