import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Design-token regression guard: the whole UI derives its corner radii from
// the @theme inline tokens in globals.css, so any drift here silently changes
// every surface. Values are the iOS-aligned scale from
// docs/specs/2026-11-05-ios-radius-alignment.md.
const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");

function themeToken(name: string): string {
  const match = css.match(new RegExp(`--radius-${name}\\s*:\\s*([^;]+);`));
  if (!match) throw new Error(`--radius-${name} not found in globals.css`);
  return match[1].trim();
}

describe("iOS-aligned radius scale", () => {
  it.each([
    ["sm", "8px"],
    ["md", "10px"],
    ["lg", "12px"],
    ["xl", "20px"],
    ["2xl", "24px"],
    ["3xl", "28px"],
    ["4xl", "32px"],
  ])("--radius-%s is %s", (name, expected) => {
    expect(themeToken(name)).toBe(expected);
  });

  it("keeps the base --radius at 0.9rem (sonner toast and button clamps depend on it)", () => {
    const base = css.match(/(?<![\w-])--radius:\s*([^;]+);/);
    expect(base?.[1]?.trim()).toBe("0.9rem");
  });
});
