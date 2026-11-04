/**
 * Night-mode time window (browser-local timezone). 18:00 (inclusive) to
 * 06:00 (exclusive) renders dark. A manual override (`ThemeMode`) takes
 * precedence over the schedule; "auto" follows it.
 */
export const NIGHT_MODE_START_HOUR = 18;
export const NIGHT_MODE_END_HOUR = 6;

/**
 * Display mode. "eink" is a dedicated e-ink preset: forced light palette,
 * no animations (see the html.eink block in globals.css). It is an explicit
 * choice and takes precedence over the night schedule.
 */
export type ThemeMode = "auto" | "light" | "dark" | "eink";

export const THEME_MODE_STORAGE_KEY = "prboard:theme-mode";

export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** Cycles in this order from the header toggle. */
export const NEXT_THEME_MODE: Record<ThemeMode, ThemeMode> = {
  auto: "light",
  light: "dark",
  dark: "eink",
  eink: "auto",
};

export function isNightMode(date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= NIGHT_MODE_START_HOUR || hour < NIGHT_MODE_END_HOUR;
}

/**
 * Returns null off-client or when storage is unreachable — both must
 * degrade to "auto" rather than throw into the caller's render path.
 */
function getBrowserStorage(): ThemeStorage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readThemeMode(storage?: ThemeStorage): ThemeMode {
  const store = storage ?? getBrowserStorage();
  if (!store) return "auto";
  let raw: string | null;
  try {
    raw = store.getItem(THEME_MODE_STORAGE_KEY);
  } catch {
    return "auto";
  }
  return raw === "light" || raw === "dark" || raw === "eink" ? raw : "auto";
}

export function writeThemeMode(mode: ThemeMode, storage?: ThemeStorage): void {
  const store = storage ?? getBrowserStorage();
  if (!store) return;
  try {
    store.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // The toggle still applies to the current page; persistence is best-effort.
  }
}

/** "eink" never resolves dark — the e-ink preset is light-only by design. */
export function resolveDark(mode: ThemeMode, date: Date = new Date()): boolean {
  return mode === "dark" || (mode === "auto" && isNightMode(date));
}

export function applyTheme(root: HTMLElement, mode: ThemeMode, date: Date = new Date()): void {
  const dark = resolveDark(mode, date);
  root.classList.toggle("dark", dark);
  // color-scheme also updates native controls (selects, scrollbars, etc.)
  // while the CSS variables above style the application itself.
  root.style.colorScheme = dark ? "dark" : "light";

  // Keep the browser/PWA toolbar aligned with the active theme when the
  // viewport metadata is present (it is emitted by the root layout).
  const themeColor = root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", dark ? "#0a0a0a" : "#ffffff");
}
