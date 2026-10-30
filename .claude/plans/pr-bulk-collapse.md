# PR 批量展开折叠实施计划

目标：批量与单卡操作共存，并增强状态辨识。
架构：Dashboard 持有默认 compact 和按 PR id 的覆盖；PrCard 接收 compact / onCompactChange。复用 rollupBadge。
依据：docs/specs/2026-10-30-pr-bulk-collapse.md。
搜索结论：Extend 现有 PrCard、Button、rollupBadge；无需新包。

## Task 1（单一依赖组，串行）
- [x] RED：浏览器验证状态转换、新 PR 默认、混合覆盖批量复位；精简卡片五类状态 SSR 测试；父级接线回归检查。
- [x] GREEN：新增轻量状态函数，父级按钮与受控卡片；删除纯色点。
- [x] 校验 npm run lint、npm run type-check、npm test；浏览器实测桌面/移动端、明暗主题及数据刷新。
- [x] simplify 四项审查后原子提交。
- [ ] 本地 review、PR、review/CI 闭环与合并收尾。

## 验收
- [ ] 全部折叠/展开覆盖隐藏项目且保留单卡操作。
- [ ] 数据刷新保留选择、新 PR 遵循批量默认。
- [ ] 通过/失败/进行中/无检查均有图标和文字，手机不溢出。
- [ ] lint、类型、全量测试、浏览器检查通过。
风险：本仓无踩坑库；避免 effect 同步 props 导致单卡覆盖与批量命令冲突，避免更改 key 重挂载动画。
