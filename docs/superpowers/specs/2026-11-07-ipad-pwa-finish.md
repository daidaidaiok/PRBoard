# iPad 移植收尾：apple-touch-icon + 安装指南

日期：2026-11-07
状态：实施中

## 背景

2026-11-04 定的路线 A（PWA 补强）已全部合并（PR #13/#14/#15）：墨水屏主题、刷新策略、平板双列网格、触控目标、iOS 圆角。PWA 基建（manifest standalone、`appleWebApp` meta、sw.js 离线壳、Bark 推送）齐备。

**iOS/iPadOS 侧仅剩两个真实缺口**：

1. **无 `apple-touch-icon` link**：iOS Safari「添加到主屏幕」不读 manifest `icons`，只认 `<link rel="apple-touch-icon">`。缺失时主屏图标是网页截图。
2. **无安装文档**：用户不知道最终安装步骤（Safari 添加到主屏幕、Bark 推送配置）。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 技术路线 | PWA 收尾（用户未答复路线选择，按 2026-11-04 已落地路线 A 继续；Capacitor 路线 B 列遗留事项） |
| 图标生成 | macOS 自带 `sips` 从 `public/icons/icon-192.png` 缩出 180×180 → `public/apple-touch-icon.png`；不引入 sharp/imagemagick（搜索先行：Adopt 系统工具） |
| metadata 写法 | Next 16 内置 `metadata.icons.apple`（generate-metadata.md 确认生成 `<link rel="apple-touch-icon">`） |
| viewportFit | **不加**：`statusBarStyle: "default"` 下内容不延伸到状态栏区域，`viewport-fit=cover` 无实际效果（YAGNI，同 eink 低频轮询判例） |
| 启动画面 | 不做（`apple-touch-startup-image` 需按设备档位出多张图，收益低） |

## 设计

### 1. apple-touch-icon

> **实施修正（PR#18 review）**：初版用 `sips` 从 `icon-192.png` 生成 `public/apple-touch-icon.png` + `metadata.icons.apple`，被 Bugbot 两条 finding 推翻——① `icon-192.png` 是圆角渲染，iOS 再套遮罩会缩图标留空角；② Next 16 显式 export `metadata.icons` 会抑制文件约定 `icon.svg`/`apple-icon.png` 的自动输出（实测确认）。仓库本有 `scripts/tools/generate-icons.mjs` 生成的全出血 `src/app/apple-icon.png`（`rx="112"` → `rx="0"`）专供此用。

最终方案：**不写 `metadata.icons`**，直接用 Next 文件约定 `src/app/apple-icon.png`（自动输出 `<link rel="apple-touch-icon" sizes="180x180">`）；`layout.tsx` 加注释防止回归。测试锁「不显式声明 icons」。

### 2. metadata 完整性测试（TDD）

`src/app/layout.test.ts`：导入 `metadata` 与 `viewport`，断言 iOS 安装链路关键项不回退——`icons.apple` 存在、`appleWebApp.capable` 为 true、`appleWebApp.title` 为 PRboard、`display: standalone` 由 manifest 保证（不在此测）。锁住"加到主屏幕"体验不因后续重构丢失。

### 3. iPad 安装指南

`docs/ipad-install.md`：Safari 打开站点 → 分享 → 添加到主屏幕（得全屏独立 app）；Bark App 装 App、`/settings/notifications` 配 URL 收 CI 推送；墨水屏/平板主题切换入口说明。

## 非目标

- Capacitor / App Store / TestFlight（路线 B，遗留事项跟踪）
- Web Push（Bark 已覆盖）
- `apple-touch-startup-image` 启动画面
- viewportFit / statusBarStyle 变更

## 测试

- `src/app/layout.test.ts`：metadata iOS 关键字段断言（vitest，node 环境，纯对象导入无渲染）。
- 图标：`sips` 生成后 `file` 确认 180×180；构建产物 head 检查（`next build` 后 curl/HTML 检查，人工步骤记录在 PR 自测）。

## 风险与约束

- Next 16 破坏性变更：已读 `node_modules/next/dist/docs/` 对应章节（generate-metadata.md icons 节）。
- 不改 `public/sw.js`、不动快照替换语义。
- feature 分支 `feat/ios-pwa-finish` 从 origin/staging c6cf1b4 切出，worktree 隔离（并行会话切分支前科）。
