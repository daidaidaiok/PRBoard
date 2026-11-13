# Spec: PR 卡片 review 门禁徽章

日期：2026-11-14
分支：feat/review-findings-gate
状态：已确认（描述模式，采用推荐方案 A）

## 问题

PR 卡片的合并按钮在 review 未通过时只是灰掉，卡片上没有任何地方显示 review 状态：
reviewer 提了 changes requested（待修复）还是没人审（待 review），用户在 PRboard 上看不出来，
只能点进 GitHub 才知道为什么「不能合并」。需求：

1. 每个 PR 的 review 如有要修复的，都要在卡片上显示出来。
2. 全部修复完（review 通过 + CI 绿 + 无冲突）才显示「可合并」。

## 方案

抽一个 `reviewGateBadge(pr)` 帮助函数返回 `Badge | null`，展开视图与精简视图共用。
状态按优先级取一：

| 优先级 | 条件 | 徽章 | 颜色/图标 |
|---|---|---|---|
| 0 | `mergeable === "CONFLICTING"` | 不显示 | 已有「解决冲突」destructive 按钮，重复信息 |
| 1 | `reviewDecision === "CHANGES_REQUESTED"` | 待修复 | destructive + CircleX |
| 2 | `reviewDecision === "REVIEW_REQUIRED"` | 待 review | amber + CircleDashed |
| 3 | `prCanMerge(pr)` 为 true | 可合并 | emerald + GitMerge |
| 4 | 其他（APPROVED 但 CI 未过 / UNKNOWN） | 不显示 | rollup 徽章已表达 CI 状态 |

「可合并」徽章直接复用 `prCanMerge`（与合并按钮可点状态完全同一判定），
保证不会出现「徽章说可合并、按钮却禁用」的矛盾。

## 展示位置

- 展开视图：CardHeader 元信息行，Draft 徽章之后。
- 精简视图：rollup 徽章之后（一行内同样可见）。

## 不变

- `prCanMerge` 判定逻辑不变（已正确）。
- 合并按钮禁用逻辑不变。
- 数据层不动：`reviewDecision`、`mergeable` 均已在 `PullRequestSummary`。

## 验收标准

- [ ] `CHANGES_REQUESTED` → 卡片（展开+精简）显示「待修复」，合并按钮禁用。
- [ ] `REVIEW_REQUIRED` → 显示「待 review」，合并按钮禁用。
- [ ] APPROVED + MERGEABLE → 显示「可合并」，合并按钮可点。
- [ ] CONFLICTING → 不显示「可合并」（冲突按钮接管）。
- [ ] 无 review 信息（null + UNKNOWN）→ 不显示 review 徽章。

## 测试计划

`pr-card-view.test.tsx` 按现有 renderToStaticMarkup 模式新增用例覆盖上表 5 行。
