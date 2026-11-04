# 全站圆角体系对齐 iOS（2026-11-05）

## 目标

PRboard 界面中圆角矩形的圆角与 iPhone / iPad 实体机的圆角观感一致：全站 radius 刻度对齐 iOS 原生数值家族，连续曲率用 CSS `corner-shape` 渐进增强。

用户已确认方案：**全站体系对齐 iOS**（否掉了「仅外层容器按机型匹配屏幕圆角」）。

## 现状

- 圆角单源在 `src/app/globals.css` 的 `@theme inline`：`--radius: 0.9rem`（14.4px，staging 毛玻璃改造后）派生 `calc` 链（sm=0.6×…4xl=2.6×），实际值 8.64/11.52/14.4/20.16/25.92/31.68/37.44——非整数奇数值，嵌套时不齐。
- 主要表面：PR 卡片 `Card` 用**硬编码 `rounded-[1.25rem]`**（20px），底部切换器/看板/预览页共 **8 处 `rounded-[22px]`、各 1 处 `[24px]/[28px]`**——毛玻璃 PR 留下的硬编码，全部绕过 token 体系。
- 依据（iOS 原生实测/惯例）：控件按钮 ~10pt、上下文菜单 ~12pt、iOS 26 卡片家族 20pt 档、sheet 弹层 ~24pt、大面板 28pt+；物理机屏幕圆角 iPhone 39–55pt、iPad 18–26pt——嵌套圆角按同族比例缩进才显「和实体机一致」。

## 变更

### 1. `src/app/globals.css` — token 刻度重写

| token | 旧 | 新 | 对齐对象 |
|---|---|---|---|
| `--radius-sm` | 6px | **8px** | 小控件（状态点角、小徽标） |
| `--radius-md` | 8px | **10px** | 按钮/输入/菜单项（iOS 控件 10pt） |
| `--radius-lg` | 10px | **12px** | 菜单容器/Tab 按钮（iOS 菜单 ~12pt） |
| `--radius-xl` | 14px | **20px** | 卡片/弹窗主体（iOS 26 卡片档） |
| `--radius-2xl` | 18px | **24px** | 底部弹层面板（iOS 26 sheet） |
| `--radius-3xl` | 22px | **28px** | 预留大面板 |
| `--radius-4xl` | 26px | **32px** | 胶囊类（badge h-5 下等效 full，不变观感） |
| `--radius`（基值） | 0.625rem | **不动** | sonner toast、button 的 `min(var(--radius-md),Npx)` clamp 依赖 |

实现方式：`calc(var(--radius) * k)` 链改为显式 px（数值即意图，防止基值改动连锁漂移）。

### 2. `src/components/project-switcher.tsx` — 去硬编码

两处 `rounded-[22px]` → `rounded-2xl`（24px，并入 token 体系）。

### 3. `src/app/globals.css` — 连续曲率渐进增强

```css
@supports (corner-shape: squircle) {
  [data-slot="card"], [data-slot="dialog-content"], … 大表面选择器 { corner-shape: squircle; }
}
```

Safari 26 稳定版不支持（仅 Tech Preview；正式支持在 Safari 27），不支持的浏览器整条忽略，零风险。**不做 SVG clip-path / polyfill**——会破坏毛玻璃 ring/shadow。

## 范围外（明确不做）

- 按机型匹配外层容器屏幕圆角（媒体查询查表 55pt/47pt…）——用户否掉
- `rounded-full` 全部不动（24 处 pill/圆点）
- sonner toast、按钮 min-clamp 行为不变
- 桌面端不单独区分刻度（全站统一，桌面观感同步现代化为可接受副作用）

## 验收标准

- [ ] `globals.css` 七档 token 为上表新值，`--radius` 基值不变
- [ ] `project-switcher.tsx` 无 `rounded-[<px>]` 硬编码
- [ ] `@supports (corner-shape: squircle)` 块存在且覆盖 card/dialog 等大表面
- [ ] vitest 新增 design-token 回归测试全绿（先红后绿）
- [ ] 全量 lint / type-check / test / build 绿
- [ ] 浏览器实测卡片/弹层/切换器圆角（design-preview 路由或登录后看板）
