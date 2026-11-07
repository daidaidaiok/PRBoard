# Plan: iPad 移植收尾（feat/ios-pwa-finish）

spec: docs/superpowers/specs/2026-11-07-ipad-pwa-finish.md
分支: feat/ios-pwa-finish（← origin/staging c6cf1b4，worktree 隔离）

## 验收标准

- [ ] `public/apple-touch-icon.png` 存在，180×180 PNG（方角满幅）
- [ ] `src/app/layout.tsx` metadata 含 `icons.apple: "/apple-touch-icon.png"`
- [ ] `src/app/layout.test.ts` 全绿：icons.apple 存在 + appleWebApp.capable + appleWebApp.title
- [ ] `docs/ipad-install.md`：安装步骤 + Bark 推送配置 + 主题说明
- [ ] `npm run lint` / `npm run type-check` / `npm test` / `npm run build` 全绿
- [ ] 构建产物首页 HTML 含 `<link rel="apple-touch-icon"`

## Task 列表（依赖分组）

**G1（串行，TDD 主线）**
- Task 1 RED：写 `src/app/layout.test.ts`，断言 `metadata.icons?.apple === "/apple-touch-icon.png"`、`appleWebApp.capable === true`、`appleWebApp.title === "PRboard"`。实跑确认红（当前 metadata 无 icons）。
- Task 2 GREEN：`src/app/layout.tsx` metadata 加 `icons: { apple: "/apple-touch-icon.png" }`。实跑确认绿。
- Task 3 资源：`sips -z 180 180 public/icons/icon-192.png --out public/apple-touch-icon.png`；`file` 验证 180×180。原子 commit。

**G2（依赖 G1，可独立执行）**
- Task 4：写 `docs/ipad-install.md`（Safari 添加到主屏幕步骤、Bark 配置、eink/主题切换入口）。

**G3（依赖 G1+G2）**
- Task 5：Phase 4 全量校验（lint → type-check → test → build）+ 构建产物 head 检查。

## 测试计划

- 单测：vitest node 环境，`layout.test.ts` 纯对象断言（无渲染）。
- 构建：`next build` 后检查 `.next` 产物或本地起服务 curl 首页 head。
- 无 E2E 基建，不写 E2E。

## 风险点

- Next 16 metadata 行为（已读 generate-metadata.md，icons.apple 生成 `<link rel="apple-touch-icon">`）。
- `layout.test.ts` 命名不触发 Next 文件约定（`src/app/` 下已有 `*.test.ts` 先例）。
- HEAD 被并行会话切走：每次 commit 前校验当前分支（共享 checkout 前科）。
- 图标为二进制资源，不写单测，用 `file` + 构建产物双重验证。
