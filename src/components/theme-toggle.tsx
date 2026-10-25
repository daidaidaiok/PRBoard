"use client";

import { useEffect, useState } from "react";
import { Moon, Sun, SunMoon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { applyTheme, NEXT_THEME_MODE, readThemeMode, writeThemeMode, type ThemeMode } from "@/lib/theme";

const MODE_META: Record<ThemeMode, { icon: typeof Sun; label: string }> = {
  auto: { icon: SunMoon, label: "跟随时间" },
  light: { icon: Sun, label: "浅色" },
  dark: { icon: Moon, label: "深色" },
};

/**
 * Manual theme override, cycling auto → light → dark. Reads the persisted
 * mode in an effect (not the state initializer) so server render and
 * hydration agree; a stored override flashes in one commit later.
 */
export function ThemeToggle() {
  const [mode, setMode] = useState<ThemeMode | null>(null);

  useEffect(() => {
    // Persisted mode reads in an effect (not the state initializer) so SSR
    // and hydration agree — same pattern as the dashboard's cache preload.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMode(readThemeMode());
  }, []);

  const cycle = () => {
    const next = NEXT_THEME_MODE[mode ?? "auto"];
    setMode(next);
    writeThemeMode(next);
    applyTheme(document.documentElement, next);
  };

  const meta = MODE_META[mode ?? "auto"];
  const Icon = meta.icon;
  const label =
    mode === null ? "主题" : `主题：${meta.label}（点击切换为${MODE_META[NEXT_THEME_MODE[mode]].label}）`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={label}
            title={label}
            onClick={cycle}
            className="size-8 rounded-lg text-muted-foreground hover:text-foreground"
          />
        }
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
