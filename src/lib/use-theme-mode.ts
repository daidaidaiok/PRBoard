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
