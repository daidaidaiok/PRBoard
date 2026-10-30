# 发布前依赖修复计划

Spec: docs/specs/2026-10-31-dependency-security.md
依赖组：单一串行任务，package.json/lockfile 必须一起生成，不并行编辑。
- [ ] RED：版本下限回归测试和已有 npm audit 报告重现。
- [ ] GREEN：同 major 定向升级，兼容更新受影响传递依赖，不使用 force。
- [ ] npm ci、lint、type-check、test、build；npm audit --omit=dev high/critical 清零。
- [ ] simplify、本地 review、修复 PR 与真实 CI，通过后合入 staging。
- [ ] 恢复回流 PR #5，验证 main 是 staging 祖先；发布快照 PR、发布级 review、CI、auto-merge。
风险：Next 和 eslint-config-next 版本需对齐；shadcn CSS 保留；不把同 major 的传递依赖问题用不必要 overrides 藏起来。
