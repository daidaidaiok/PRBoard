# PR 单图标展示切换计划

依据 docs/specs/2026-10-30-pr-view-icon.md。搜索结论：Extend 当前按钮及 defaultCompact/compactOverrides，无需新依赖。
单一串行任务：RED 接线回归测试 → GREEN 全列表派生 allCompact、一个图标按钮 → 浏览器检查 → lint/type-check/test → simplify → commit/review/PR/CI。
验收：
- [ ] 仅一个无可见文字的批量图标按钮，aria-label/title 保留动作。
- [ ] 展开/折叠/逐卡覆盖混合状态/隐藏项目/刷新与空列表行为正确。
- [ ] 手机布局与明暗主题无回归。
- [ ] npm run lint、npm run type-check、npm test、local review 与真实 CI 通过。
风险：只根据 defaultCompact 判断会导致逐卡操作后动作错误；必须以全部 displayPrs 的实际状态派生。
