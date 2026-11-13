# Spec: PR 卡片 review 门禁徽章（v2 迭代）

日期：2026-11-14（v1 同日合并 PR#20；v2 按用户反馈迭代）
分支：feat/review-findings-list

## v2 用户反馈（原文）

1. 「可合并」徽章和亮起的合并按钮重复 → **删除「可合并」徽章**：全部修完 = 不显示任何 review 徽章，
   合并按钮亮起本身就是「可合并」。
2. 「review 你要写出来呀」→ **把 review findings 本体列出来**，不是只给一个状态词。

## v2 方案

### 数据层（prs.ts）

`PullRequestSummary` 新增：

```ts
reviewFindings: { id: string; author: string; body: string }[]
```

服务端组装，两条来源：

1. **unresolved reviewThreads** 的首条评论（Bugbot/Codex 行内 findings、人工行内意见——无论 review
   state，只要没 resolve 就是要修的；`isOutdated` 已过期的也列出，但 UI 不再单独区分）。
2. **CHANGES_REQUESTED 顶层 review body**（纯 review 意见、无行内评论的情况）。

GraphQL `QUERY` 增加对应子查询，条数上限 threads 50 / reviews 10（个人看板量级足够）。

### UI（pr-card.tsx）

- 「待修复」徽章带数量：`待修复 ×N`（N = reviewFindings.length）。
- 展开视图新增 Review 区块：逐条列出 `author + body 首行`，链接到 PR。
- 精简视图：仅徽章带数量（一行放不下列表）。
- 「待 review」徽章保留（不重复、有价值）；`reviewDecision` 为空但 threads 未 resolve 时也显示「待修复」。

## 验收标准

- [ ] 卡片不再出现「可合并」徽章。
- [ ] unresolved thread 与 CHANGES_REQUESTED review 逐条显示作者与内容摘要。
- [ ] 徽章数量与 findings 条数一致。
- [ ] 全部 resolve 后徽章消失、合并按钮可点。
