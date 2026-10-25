import { describe, expect, it } from "vitest";
import { isNightMode, readThemeMode, resolveDark, writeThemeMode, NEXT_THEME_MODE, type ThemeStorage } from "@/lib/theme";

describe("isNightMode", () => {
  it("uses the night window from 18:00 through 05:59", () => {
    expect(isNightMode(new Date(2026, 0, 1, 18, 0))).toBe(true);
    expect(isNightMode(new Date(2026, 0, 2, 5, 59))).toBe(true);
  });

  it("uses the light theme from 06:00 through 17:59", () => {
    expect(isNightMode(new Date(2026, 0, 1, 6, 0))).toBe(false);
    expect(isNightMode(new Date(2026, 0, 1, 17, 59))).toBe(false);
  });
});

class MemoryStorage implements ThemeStorage {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("theme mode persistence", () => {
  it("defaults to auto when nothing is stored or the value is invalid", () => {
    expect(readThemeMode(new MemoryStorage())).toBe("auto");
    const junk = new MemoryStorage();
    junk.setItem("prboard:theme-mode", "sepia");
    expect(readThemeMode(junk)).toBe("auto");
  });

  it("round-trips an explicit light/dark override", () => {
    const storage = new MemoryStorage();
    writeThemeMode("dark", storage);
    expect(readThemeMode(storage)).toBe("dark");
    writeThemeMode("light", storage);
    expect(readThemeMode(storage)).toBe("light");
  });
});

describe("resolveDark", () => {
  const noon = new Date(2026, 0, 1, 12, 0);
  const night = new Date(2026, 0, 1, 23, 0);

  it("follows the schedule in auto mode", () => {
    expect(resolveDark("auto", noon)).toBe(false);
    expect(resolveDark("auto", night)).toBe(true);
  });

  it("lets an explicit override win over the schedule", () => {
    expect(resolveDark("light", night)).toBe(false);
    expect(resolveDark("dark", noon)).toBe(true);
  });
});

describe("NEXT_THEME_MODE", () => {
  it("cycles auto → light → dark → auto", () => {
    expect(NEXT_THEME_MODE.auto).toBe("light");
    expect(NEXT_THEME_MODE.light).toBe("dark");
    expect(NEXT_THEME_MODE.dark).toBe("auto");
  });
});
