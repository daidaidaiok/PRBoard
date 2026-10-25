"use client";

import { useEffect } from "react";
import { applyTheme, readThemeMode } from "@/lib/theme";

/**
 * Keeps the UI aligned with the user's theme mode (or the day/night
 * schedule when in "auto") without requiring a refresh. Re-checked once
 * per minute so a page left open crosses the boundary automatically.
 */
export function AutomaticTheme() {
  useEffect(() => {
    const updateTheme = () => applyTheme(document.documentElement, readThemeMode());

    updateTheme();
    const interval = window.setInterval(updateTheme, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  return null;
}
