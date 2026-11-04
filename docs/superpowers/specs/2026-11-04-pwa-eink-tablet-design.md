# PWA 补强：墨水屏主题 + 刷新策略 + 平板适配设计

日期：2026-11-04
状态：待用户审阅

## 背景

用户想把 PRboard 变成 iOS/Android app，覆盖 iPad 与安卓平板，条件允许时支持墨水屏。经排查（2026-11-04），PWA 基建与推送系统已大体存在：

- `src/app/manifest.ts`：manifest 已有——icons 192/512/512-maskable、`display: standalone`、theme_color。
- `public/sw.js`：离线壳已在——`/_next/static/` cache-first、导航 network-first 回退缓存 HTML、`/api/*` 直通；PR 数据的快照降级由应用层负责。
- `src/app/layout.tsx`：`appleWebApp` meta 已有（iOS/iPadOS 加到主屏幕即全屏独立窗口）。
- Bark 推送全套已在：`src/lib/bark.ts` + `src/lib/github/ci-notifications.ts`（webhook 管线内联发送）+ `/settings/notifications` 配置页（Bark URL、四类事件开关、测试按钮）。iPhone/iPad 安装 Bark 即可收推送。

结论：不需要 Capacitor/原生壳。剩余真实缺口为三块——墨水屏主题、墨水屏刷新策略、平板布局适配。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 技术路线 | PWA 补强，不引入 Capacitor/RN，不上 App Store |
| 推送 | 沿用现有 Bark；Web Push 本期不做 |
| 墨水屏覆盖范围 | 安卓系墨水屏平板（文石 Boox、Bigme 等）；reMarkable/Kindle 不支持 |
| 墨水屏主题定位 | 独立显示模式 `eink`，与 auto/light/dark 并列，强制浅色黑白 |
| eink 下实时性 | 不建 SSE 连接，仅手动刷新；低频轮询不做（YAGNI，需要时再加） |
| 平板适配方式 | 审查 + 补断点，不重写布局 |
| 动手前检查 | Next 16 有破坏性变更，实现前读 `node_modules/next/dist/docs/` 对应章节 |

## 设计

### P1 墨水屏主题（eink 显示模式）

`src/lib/theme.ts`：`ThemeMode` 从 `"auto" | "light" | "dark"` 扩为 `"auto" | "light" | "dark" | "eink"`。

- `NEXT_THEME_MODE` 循环顺序变为 auto → light → dark → eink → auto。
- `isNightMode` 调度对 eink 不生效：eink 是显式选择，优先于夜间自动切换。
- 应用方式沿用现有路径：`AutomaticTheme` 把 eink 落到 `<html>` 的主题 class/属性上，`readThemeMode`/存储 key 语义不变（`"eink"` 成为合法存储值）。

`globals.css`：新增 eink 变量覆盖块（挂 eink 主题 class 之下）：

- 颜色收敛为纯黑/纯白；border 用黑；状态（成功/失败/运行中）依赖 Badge 现有文案与图标区分，不依赖灰阶深浅。
- `box-shadow` 全部置 none，卡片改实线边框（1.5–2px）。
- 动画停用：eink class 之下 `animation-duration: 0s; transition-duration: 0s`（含 `tw-animate-css` 与 skeleton 的 pulse），避免墨水屏反复闪屏重绘。
- sonner toast、tooltip 在 eink 下走同一套变量，天然去色，不单独改造。

切换入口：`theme-toggle.tsx` 的循环点按即含 eink 档，图标从 lucide 选一个合适的（实现时定）。

### P2 墨水屏刷新策略

`dashboard.tsx`（以及 `runner-monitor.tsx`、`host-capacity-monitor.tsx` 两处 SSE 订阅）：

- eink 模式下不创建 `EventSource`、不启动轮询兜底——每次数据推送都会触发墨水屏全屏闪烁重绘，常亮看板场景不可接受。
- 头部提供手动「刷新」按钮（放 `app-header.tsx` 还是 dashboard 工具行，实现时按内聚性定），点击触发一次完整数据拉取。
- 非 eink 模式行为零改动；`sw.js` 与快照降级链路不动。

### P3 平板适配

现状：`dashboard.tsx` 仅 2 处断点、`pr-card.tsx` 3 处，响应式覆盖稀疏。

- 目标档位：iPad 竖屏 768–834、iPad 横屏 1024–1366、安卓平板 800–1280。
- 看板网格：手机 1 列（现状）→ `md` 2 列 → `xl` 3 列；列数与卡片密度以各档位截图核对后微调。
- 触控目标 ≥ 44×44：header 按钮、PR 卡片操作按钮过一遍。
- `/runners`、`/settings` 两页同步补断点。
- 验证：浏览器 device toolbar 按档位截图核对；实机抽查由用户 iPad / Boox 执行。

## 非目标

- Capacitor / App Store / TestFlight（将来如需 APNs/TestFlight 再走路线 B，本设计产出全部复用）
- Web Push（iOS 侧 Bark 已覆盖；安卓/墨水屏推送随路线 B 的 FCM/APNs 一起决策，避免本期引入 VAPID/订阅表/失败清理的整块后端工作）
- reMarkable、Kindle 支持
- 墨水屏低频轮询（只做手动刷新）

## 测试

- `src/lib/theme.test.ts`：eink 读写、循环顺序、夜间调度对 eink 不生效。
- dashboard 刷新策略单测：eink 下不建 EventSource、手动刷新触发数据拉取（vitest，参照现有组件测试风格）。
- CSS/主题：构建后浏览器按设备档位截图核对；Boox 实机由用户抽查。

## 风险与约束

- Next 16 破坏性变更（AGENTS.md 提示）：涉及 `manifest.ts`/`layout.tsx`/主题组件，动手前读 `node_modules/next/dist/docs/` 对应章节。
- 不改 `public/sw.js`、不动快照替换语义（慢网络韧性架构的关键取舍）。
- 共享 checkout 有并行会话切分支的前科：开工前确认 HEAD，feature 分支从 staging 切。
