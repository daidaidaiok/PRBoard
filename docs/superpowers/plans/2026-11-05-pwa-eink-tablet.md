# PWA 补强（eink 主题 + 刷新策略 + 平板适配）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 PRboard 增加 e-ink 显示模式（黑白、零动画、仅手动刷新）并补齐 iPad/安卓平板布局断点，使其在墨水屏平板与平板上可用。

**Architecture:** 主题模式从 `auto/light/dark` 三态扩为含 `eink` 的四态，沿用现有「localStorage + applyTheme 落 class」管线；eink 通过 `html.eink` class 驱动 CSS 变量覆盖 + 灰度滤镜 + 全局动画/阴影禁用；实时更新（SSE/轮询）在 eink 下由 `useIsEink()` hook 关闭，数据只来自挂载首拉与手动刷新按钮（已存在）。平板适配 = 看板列表改响应式网格 + 触控目标放大。

**Tech Stack:** Next.js 16.3.3（App Router）、React 19、Tailwind CSS 4（`pointer-coarse:` 变体内置可用，pr-card 已在用）、TypeScript、vitest（**node 环境，无 jsdom**——DOM 交互用 fake 对象测）。

**Spec:** `docs/superpowers/specs/2026-11-04-pwa-eink-tablet-design.md`

## Global Constraints

- Next 16 有破坏性变更：动手改 `layout.tsx` 前先读 `node_modules/next/dist/docs/` 中与 metadata/script 相关章节（本计划只改 bootstrap 内联脚本字符串，不动 metadata API）。
- **不修改 `public/sw.js`**；不动 localStorage 快照降级链路（`loadCachedDashboard`/`saveCachedDashboard` 原样保留）。
- eink 与 dark 互斥：`resolveDark("eink")` 恒为 false；`html.eink` 与 `html.dark` 不应同时存在。
- vitest 是 node 环境：所有新测试不得 import 依赖 DOM 的组件；DOM 用最小 fake。
- 注释风格：英文，解释「为什么」，与现有代码一致。
- 工作分支从 `staging` 切（见 spec 风险节）；共享 checkout，开工前确认 HEAD。
- 所有 eink 行为必须做到「非 eink 模式零改动」。

---

### Task 1: theme.ts — eink 模式核心（TDD）

**Files:**
- Modify: `src/lib/theme.ts`
- Test: `src/lib/theme.test.ts`

**Interfaces:**
- Produces: `ThemeMode` 含 `"eink"`；`NEXT_THEME_MODE` 循环 auto→light→dark→eink→auto；`readThemeMode`/`writeThemeMode` 接受 eink；`resolveDark("eink")` 恒 false。Task 2-6 全部依赖这些。

- [ ] **Step 1: 写失败测试**

`src/lib/theme.test.ts`：

1. 替换现有 `NEXT_THEME_MODE` 测试块：

```ts
describe("NEXT_THEME_MODE", () => {
  it("cycles auto → light → dark → eink → auto", () => {
    expect(NEXT_THEME_MODE.auto).toBe("light");
    expect(NEXT_THEME_MODE.light).toBe("dark");
    expect(NEXT_THEME_MODE.dark).toBe("eink");
    expect(NEXT_THEME_MODE.eink).toBe("auto");
  });
});
```

2. 在 `theme mode persistence` 块追加：

```ts
  it("round-trips an explicit eink override", () => {
    const storage = new MemoryStorage();
    writeThemeMode("eink", storage);
    expect(readThemeMode(storage)).toBe("eink");
  });
```

3. 在 `resolveDark` 块追加：

```ts
  it("never goes dark in eink mode", () => {
    expect(resolveDark("eink", night)).toBe(false);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: FAIL——`NEXT_THEME_MODE.dark` 是 `"auto"` 不是 `"eink"`、round-trip 得 `"auto"`。

- [ ] **Step 3: 实现**

`src/lib/theme.ts`：

```ts
/**
 * Display mode. "eink" is a dedicated e-ink preset: forced light palette,
 * no animations (see the html.eink block in globals.css). It is an explicit
 * choice and takes precedence over the night schedule.
 */
export type ThemeMode = "auto" | "light" | "dark" | "eink";
```

```ts
export const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  auto: "light",
  light: "dark",
  dark: "eink",
  eink: "auto",
};
```

`readThemeMode` 的校验行改为：

```ts
  return raw === "light" || raw === "dark" || raw === "eink" ? raw : "auto";
```

`resolveDark` 不需要改（eink 不是 `"dark"` 也不是 `"auto"`，自然恒 false），但在其 doc comment 补一句：

```ts
/** "eink" never resolves dark — the e-ink preset is light-only by design. */
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: PASS（全文件）。

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme.ts src/lib/theme.test.ts
git commit -m "feat: add eink theme mode core"
```

---

### Task 2: applyTheme 落 eink class + theme-change 事件 + 预水合脚本

**Files:**
- Modify: `src/lib/theme.ts`（applyTheme）
- Modify: `src/app/layout.tsx`（theme-bootstrap 内联脚本）
- Test: `src/lib/theme.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `ThemeMode`。
- Produces: `THEME_CHANGE_EVENT = "prboard:theme-change"`（exported const）；applyTheme 在 `<html>` 上 toggle `eink` class、每次调用派发 theme-change 事件。Task 5 的 `useThemeMode` 依赖此事件。

- [ ] **Step 1: 写失败测试**

`src/lib/theme.test.ts` 顶部 import 改为：

```ts
import {
  applyTheme,
  isNightMode,
  readThemeMode,
  resolveDark,
  writeThemeMode,
  NEXT_THEME_MODE,
  THEME_CHANGE_EVENT,
  type ThemeStorage,
} from "@/lib/theme";
```

文件尾部追加：

```ts
function fakeRoot() {
  const toggled: Array<[string, boolean]> = [];
  const root = {
    classList: {
      toggle: (name: string, force?: boolean) => {
        toggled.push([name, force ?? false]);
      },
    },
    style: {} as CSSStyleDeclaration,
    ownerDocument: undefined,
  };
  return { root: root as unknown as HTMLElement, toggled };
}

describe("applyTheme", () => {
  const noon = new Date(2026, 0, 1, 12, 0);

  it("applies the eink class instead of dark", () => {
    const { root, toggled } = fakeRoot();
    applyTheme(root, "eink", noon);
    expect(toggled).toContainEqual(["eink", true]);
    expect(toggled).toContainEqual(["dark", false]);
    expect(root.style.colorScheme).toBe("light");
  });

  it("removes the eink class when switching back to dark", () => {
    const { root, toggled } = fakeRoot();
    applyTheme(root, "dark", noon);
    expect(toggled).toContainEqual(["eink", false]);
    expect(toggled).toContainEqual(["dark", true]);
    expect(root.style.colorScheme).toBe("dark");
  });

  it("dispatches a theme-change event in the browser", () => {
    const events: string[] = [];
    const target = new EventTarget();
    target.addEventListener(THEME_CHANGE_EVENT, (event) => events.push(event.type));
    const originalWindow = globalThis.window;
    (globalThis as { window?: unknown }).window = target;
    try {
      const { root } = fakeRoot();
      applyTheme(root, "eink", noon);
      expect(events).toEqual([THEME_CHANGE_EVENT]);
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });
});
```

（applyTheme 对 `ownerDocument: undefined` 的 fake 走 `?.` 可选链跳过 theme-color meta，无需 DOM。node 22 全局有 `EventTarget`/`Event`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: FAIL——`THEME_CHANGE_EVENT` 未导出、eink class 未落。

- [ ] **Step 3: 实现 applyTheme**

`src/lib/theme.ts` 顶部（`THEME_MODE_STORAGE_KEY` 附近）加：

```ts
/**
 * Fired on `window` by `applyTheme` after every application. Consumers
 * (e.g. useThemeMode) re-read the persisted mode instead of duplicating
 * the auto-schedule logic.
 */
export const THEME_CHANGE_EVENT = "prboard:theme-change";
```

`applyTheme` 改为：

```ts
export function applyTheme(root: HTMLElement, mode: ThemeMode, date: Date = new Date()): void {
  const dark = resolveDark(mode, date);
  root.classList.toggle("dark", dark);
  // eink and dark are mutually exclusive (resolveDark forces light for
  // eink); toggling both keeps a stale class from surviving mode switches.
  root.classList.toggle("eink", mode === "eink");
  // color-scheme also updates native controls (selects, scrollbars, etc.)
  // while the CSS variables above style the application itself.
  root.style.colorScheme = dark ? "dark" : "light";

  // Keep the browser/PWA toolbar aligned with the active theme when the
  // viewport metadata is present (it is emitted by the root layout).
  const themeColor = root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");

  // Browser only — applyTheme never runs on the server.
  if (typeof window !== "undefined") window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}
```

- [ ] **Step 4: 更新 layout.tsx 预水合脚本**

先按 Global Constraints 读 `node_modules/next/dist/docs/` 中 Script/metadata 相关章节。然后把 `theme-bootstrap` 内联脚本改为（eink 必须在首帧前落 class，否则 e-ink 用户每次加载都先闪一帧带动画的浅色主题）：

```js
(() => {
  let mode = "auto";
  try { mode = localStorage.getItem("THEME_MODE_STORAGE_KEY_VALUE") || "auto"; } catch (e) {}
  if (mode !== "auto" && mode !== "light" && mode !== "dark" && mode !== "eink") mode = "auto";
  const eink = mode === "eink";
  const hour = new Date().getHours();
  const dark = !eink && (mode === "dark" || (mode === "auto" && (hour >= 18 || hour < 6)));
  const root = document.documentElement;
  root.classList.toggle("dark", dark);
  root.classList.toggle("eink", eink);
  root.style.colorScheme = dark ? "dark" : "light";
  const themeColor = document.querySelector('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
})();
```

注意：现脚本用模板字符串注入了 `${THEME_MODE_STORAGE_KEY}`、`${NIGHT_MODE_START_HOUR}`、`${NIGHT_MODE_END_HOUR}` 三个常量，改写时保留这三处注入，只改校验行与新增 eink 两行。（上面代码里的 `THEME_MODE_STORAGE_KEY_VALUE`、`18`、`6` 实际写为 `${THEME_MODE_STORAGE_KEY}`、`${NIGHT_MODE_START_HOUR}`、`${NIGHT_MODE_END_HOUR}`。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/lib/theme.test.ts`
Expected: PASS。

- [ ] **Step 6: Commit**

```bash
git add src/lib/theme.ts src/app/layout.tsx src/lib/theme.test.ts
git commit -m "feat: apply eink class pre-hydration and notify theme consumers"
```

---

### Task 3: theme-toggle 加入 eink 档

**Files:**
- Modify: `src/components/theme-toggle.tsx:9-13`

**Interfaces:**
- Consumes: Task 1 的 `ThemeMode`/`NEXT_THEME_MODE`（`MODE_META: Record<ThemeMode, …>` 缺 eink 会编译失败——本任务补齐）。
- Produces: header 循环切换 auto→light→dark→eink。

- [ ] **Step 1: 实现**

```tsx
import { Contrast, Moon, Sun, SunMoon } from "lucide-react";

const MODE_META: Record<ThemeMode, { icon: typeof Sun; label: string }> = {
  auto: { icon: SunMoon, label: "跟随时间" },
  light: { icon: Sun, label: "浅色" },
  dark: { icon: Moon, label: "深色" },
  eink: { icon: Contrast, label: "墨水屏" },
};
```

组件 doc comment 第 16 行同步改为 `cycling auto → light → dark → eink`。

- [ ] **Step 2: 验证**

Run: `npm run type-check && npm run lint`
Expected: PASS（Record 完整性由类型系统保证）。

- [ ] **Step 3: Commit**

```bash
git add src/components/theme-toggle.tsx
git commit -m "feat: add eink preset to the theme toggle cycle"
```

---

### Task 4: globals.css eink 覆盖块

**Files:**
- Modify: `src/app/globals.css`（追加在 `.dark { … }` 块之后、`@layer base` 之前）

**Interfaces:**
- Consumes: Task 2 落在 `<html>` 的 `eink` class。
- Produces: eink 视觉模式；Task 9 的验证依赖它。

- [ ] **Step 1: 实现**

```css
/* E-ink display mode (ThemeMode "eink"): pure black-on-white, zero
   shadows, zero animation — every repaint flashes e-ink panels, so the
   board only changes when the user refreshes or content actually changes.
   grayscale(1) flattens Tailwind status colors (emerald/red/…) that live
   outside these variables; statuses stay legible via their icons and text.
   Sits after .dark so, if both classes ever coexisted, eink wins. */
html.eink {
  --background: oklch(1 0 0);
  --foreground: oklch(0 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0 0 0);
  --primary: oklch(0 0 0);
  --primary-foreground: oklch(1 0 0);
  --secondary: oklch(1 0 0);
  --secondary-foreground: oklch(0 0 0);
  --muted: oklch(1 0 0);
  --muted-foreground: oklch(0.35 0 0);
  --accent: oklch(0.9 0 0);
  --accent-foreground: oklch(0 0 0);
  --destructive: oklch(0.25 0 0);
  --border: oklch(0.25 0 0);
  --input: oklch(0.25 0 0);
  --ring: oklch(0.35 0 0);
  filter: grayscale(1);
}

html.eink *,
html.eink *::before,
html.eink *::after {
  box-shadow: none !important;
  animation: none !important;
  transition: none !important;
}
```

已知取舍（写在 PR 描述即可）：`filter` 落在 `html` 上会为 fixed 后代（sonner toaster）建立包含块——html 的盒子即视口，实际锚定不变；ci-ready-glow 等 outline 动画已被全局禁用。

- [ ] **Step 2: 验证构建**

Run: `npm run build`
Expected: PASS（CSS 编译无错）。

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: eink palette, grayscale and zero-motion overrides"
```

---

### Task 5: use-theme-mode hook + dashboard eink 刷新策略

**Files:**
- Create: `src/lib/use-theme-mode.ts`
- Modify: `src/components/dashboard.tsx`

**Interfaces:**
- Consumes: Task 2 的 `THEME_CHANGE_EVENT`。
- Produces: `useThemeMode(): ThemeMode`、`useIsEink(): boolean`（`src/lib/use-theme-mode.ts`，仿现有 `src/lib/use-online-status.ts` 的 lib-hook 先例）。Task 6 复用。dashboard 在 eink 下：不建 EventSource、轮询只挂载首拉一次不排程、状态徽标显示「手动」。

- [ ] **Step 1: 创建 hook**

`src/lib/use-theme-mode.ts`（新文件）：

```ts
import { useEffect, useState } from "react";
import { readThemeMode, THEME_CHANGE_EVENT, type ThemeMode } from "@/lib/theme";

/**
 * Current theme mode, kept in sync with the header toggle and the auto
 * scheduler via the theme-change event applyTheme dispatches. Starts as
 * "auto" so SSR and hydration agree — same pattern as ThemeToggle.
 */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("auto");
  useEffect(() => {
    const sync = () => setMode(readThemeMode());
    // eslint-disable-next-line react-hooks/set-state-in-effect
    sync();
    window.addEventListener(THEME_CHANGE_EVENT, sync);
    return () => window.removeEventListener(THEME_CHANGE_EVENT, sync);
  }, []);
  return mode;
}

/**
 * True when the user picked the e-ink display mode. Consumers gate
 * repaint-heavy behavior (SSE, scheduled polling) on it — every repaint
 * flashes an e-ink panel.
 */
export function useIsEink(): boolean {
  return useThemeMode() === "eink";
}
```

- [ ] **Step 2: dashboard 接入**

`src/components/dashboard.tsx`：

1. import 区（`use-online-status` 旁）加：

```ts
import { useIsEink } from "@/lib/use-theme-mode";
```

2. 组件体（`const online = useOnlineStatus()` 附近）加：

```ts
  const isEink = useIsEink();
```

3. 轮询 effect（现 229-255 行）——eink 下保留挂载首拉，但不排下一次：

```ts
  useEffect(() => {
    // react-hooks/set-state-in-effect flags any effect that eventually calls
    // setState, including this standard fetch-on-mount-and-poll pattern —
    // there's no derived-state alternative here, this is genuinely
    // synchronizing with an external system (GitHub via our API).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = () => {
      // Offline: skip the fetch entirely (it would just burn the 20s timeout)
      // and park briefly — the `online` event below refreshes immediately.
      if (!navigator.onLine) {
        if (!isEink) timer = setTimeout(tick, OFFLINE_RETRY_MS);
        return;
      }
      void fetchPrs({ silent: true }).then(() => {
        if (cancelled) return;
        const streak = failureStreakRef.current;
        const delay = streak > 0 ? Math.min(QUICK_RETRY_MS * 2 ** (streak - 1), MAX_POLL_INTERVAL_MS) : FALLBACK_POLL_INTERVAL_MS;
        // E-ink: no scheduled refetches — every repaint flashes the panel.
        // Data comes from this mount fetch and the manual refresh button.
        if (!isEink) timer = setTimeout(tick, delay);
      });
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchPrs, isEink]);
```

4. SSE effect（现 268-282 行）加 eink 早退：

```ts
  useEffect(() => {
    // E-ink: no live updates at all — see the poll effect above.
    if (isEink) return;
    const source = new EventSource("/api/events");
    // …中间监听逻辑原样保留…
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [fetchPrs, isEink]);
```

5. 状态徽标（现 462-465 行）——eink 下 SSE 永不连接，显示「轮询中」是误导：

```tsx
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`size-1.5 rounded-full ${isEink ? "bg-zinc-500" : live ? "bg-emerald-500" : "bg-zinc-400"}`} />
            {isEink ? "手动" : live ? "实时" : "轮询中"}
          </span>
```

（`online` 事件监听 effect 原样保留——恢复联网后的一次性静默刷新对 eink 同样有益且不周期性重绘。）

- [ ] **Step 3: 验证**

Run: `npm run lint && npm run type-check && npm test`
Expected: PASS。（hook 与 effect 门控行为依赖浏览器 EventSource，仓库无组件测试基建，行为验证在 Task 9 手动清单覆盖。）

- [ ] **Step 4: Commit**

```bash
git add src/lib/use-theme-mode.ts src/components/dashboard.tsx
git commit -m "feat: eink mode skips SSE and scheduled polling on the dashboard"
```

---

### Task 6: runner / host 监控页 eink 门控

**Files:**
- Modify: `src/components/runner-monitor.tsx`（91-120、127-136 行两个 effect + SSE effect）
- Modify: `src/components/host-capacity-monitor.tsx`（195-206 行轮询 effect + 213 行起 SSE effect）

**Interfaces:**
- Consumes: Task 5 的 `useIsEink()`。
- Produces: 无新接口；两页 eink 下只保留挂载首拉 + 手动刷新按钮（两页均已有）。

- [ ] **Step 1: runner-monitor**

import 加 `import { useIsEink } from "@/lib/use-theme-mode";`，组件体加 `const isEink = useIsEink();`。

轮询 effect（91-107 行）改为：

```ts
  useEffect(() => {
    // Runner online/offline transitions are not included in PR webhooks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (navigator.onLine) refreshAll();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (!isEink) {
      timer = setInterval(() => {
        // Defensive: an SSE event may have just refreshed — stay inside the
        // shared throttle window instead of stacking a poll on top of it.
        if (Date.now() - lastRefreshAt.current < RUNNER_SSE_MIN_REFRESH_MS) return;
        if (navigator.onLine) refreshAll();
      }, POLL_INTERVAL_MS);
      // Reconnect: the next 5min tick is too late, refresh immediately.
      window.addEventListener("online", refreshAll);
    }
    // E-ink: mount fetch + manual refresh only — no scheduled refreshes.
    return () => {
      if (timer) clearInterval(timer);
      window.removeEventListener("online", refreshAll);
    };
  }, [refreshAll, isEink]);
```

visibilitychange effect（111-120 行）入口加：

```ts
      if (isEink) return;
```

（放 `onVisibilityChange` 回调首行，`document.visibilityState` 检查之前之后皆可，统一放最前面；依赖数组加 `isEink`。）

SSE effect（127-136 行）加 `if (isEink) return;` 早退，依赖数组加 `isEink`。

- [ ] **Step 2: host-capacity-monitor**

同样接 `useIsEink()`。轮询 effect（195-206 行）：

```ts
  useEffect(() => {
    // This component synchronizes with the independent host telemetry API.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHosts(true);
    // E-ink: mount fetch + manual refresh only.
    if (isEink) return;
    const timer = setInterval(() => {
      if (Date.now() - lastRefreshAt.current < SSE_MIN_REFRESH_MS) return;
      void loadHosts(true);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadHosts, isEink]);
```

SSE effect（213 行起）加 `if (isEink) return;` 早退 + 依赖数组。

- [ ] **Step 3: 验证**

Run: `npm run lint && npm run type-check && npm test`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/components/runner-monitor.tsx src/components/host-capacity-monitor.tsx
git commit -m "feat: eink mode gates SSE and polls on monitor pages"
```

---

### Task 7: 看板平板网格

**Files:**
- Modify: `src/components/dashboard.tsx`（skeleton 容器与 PR 列表容器，两处相同字符串）

**Interfaces:**
- Consumes: 无。
- Produces: `md`（≥768，iPad 竖屏）2 列、`xl`（≥1280）3 列的 PR 网格；`md:items-start` 让不等高卡片顶对齐。

- [ ] **Step 1: 实现**

`src/components/dashboard.tsx` 中 `<div className="flex flex-col gap-3">` 出现两处（skeleton 占位容器与 `visiblePrs?.map` 列表容器，约 546/556 行），**两处都**改为：

```tsx
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 md:items-start">
```

（用 Edit 工具 `replace_all` 一次替换两处；改完 `grep -n "flex flex-col gap-3" src/components/dashboard.tsx` 确认看板区域内无残留。）

- [ ] **Step 2: 验证构建**

Run: `npm run build`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/dashboard.tsx
git commit -m "feat: two-column tablet grid for the PR board"
```

---

### Task 8: 触控目标 ≥44px（pointer-coarse）

**Files:**
- Modify: `src/components/app-header.tsx`（两个 icon Link）
- Modify: `src/components/theme-toggle.tsx`（Button）
- Modify: `src/components/pr-card.tsx`（合并按钮、解决冲突按钮、收起/重跑 icon-xs 按钮）

**Interfaces:**
- Consumes: Tailwind 4 内置 `pointer-coarse:` 变体（pr-card:325 已在用，编译已验证）。
- Produces: 触屏设备上 header 按钮 44px、卡片主操作按钮 44px 高。

- [ ] **Step 1: 实现**

app-header 两个 Link（通知设置、Runner 监控）的 className：`size-8` → `size-8 pointer-coarse:size-11`。

theme-toggle 的 Button className：`size-8 rounded-lg …` → `size-8 pointer-coarse:size-11 rounded-lg …`。

pr-card：
- 合并按钮（278 行起）与「解决冲突」按钮（269 行）：`size="sm"` 保持，加 `className="pointer-coarse:h-11 pointer-coarse:px-4"`（合并按钮已有条件 className 时用模板串拼接，保留 `motion-safe:animate-ci-ready` 分支）。
- 收起为精简视图按钮（261 行）与重跑类 `size="icon-xs"` 按钮：className 加 `pointer-coarse:size-8`（行内密集小钮不做满 44，44 会撑破卡片头；32px + `touch-manipulation` 是密度与可点性的折中）。

- [ ] **Step 2: 验证**

Run: `npm run lint && npm run type-check && npm run build`
Expected: PASS。

- [ ] **Step 3: Commit**

```bash
git add src/components/app-header.tsx src/components/theme-toggle.tsx src/components/pr-card.tsx
git commit -m "feat: larger touch targets on coarse pointers"
```

---

### Task 9: 全量门禁 + 手动验证清单

**Files:**
- 无代码改动（验证任务）；发现问题回对应 task 修

- [ ] **Step 1: 全量门禁**

```bash
npm run lint && npm run type-check && npm test && npm run build
```

Expected: 全绿。

- [ ] **Step 2: 浏览器手动清单（dev server + device toolbar）**

`npm run dev` 后验证：

1. 主题循环点按：跟随时间 → 浅色 → 深色 → 墨水屏 → 跟随时间；切到墨水屏后整页纯黑白、无任何动画、卡片无阴影。
2. eink 下 DevTools Network：**无** `events`（SSE）连接；状态徽标显示「手动」；点刷新按钮有 spinner 一次后静止。
3. eink 下等 3 分钟确认无自动重绘（轮询已停）。
4. 非 eink 各模式：状态徽标「实时/轮询中」、SSE 正常、行为与改动前一致（回归）。
5. 断点截图：375（iPhone SE，1 列）、820（iPad Air 竖，2 列）、1280（横屏/桌面，3 列）、触控模拟（DevTools sensors → touch）下 header 按钮 44px。
6. 刷新页面无主题闪烁（bootstrap 脚本首帧落 eink class）。
7. `/runners`（单列全宽卡片 + HostCapacityMonitor）与 `/settings/notifications`（max-w-2xl 居中）在 820 宽下无横向溢出、按钮可点——这两页现有布局在平板档位已合理，预期无需改动；若发现溢出，按 Task 7 同款断点补。

- [ ] **Step 3: e-ink 实机清单（用户执行，Boox）**

浏览器打开站点 → 切墨水屏模式 → 检查：空闲无闪屏、无残影加重、刷新按钮可用、（可选）加到主屏幕全屏运行。

- [ ] **Step 4: 收尾 Commit（如有修复）+ 汇报**

```bash
git add -A && git commit -m "fix: eink/tablet sweep fixes from manual verification"
```

（无修复则跳过。）
