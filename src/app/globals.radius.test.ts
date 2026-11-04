import { readdirSync, readFileSync, statSync } from "node:fs";
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

// Corner radii must come from the token scale above; hardcoded rounded-[Npx]
// bypassed it during the glass redesign and left the family inconsistent.
// Allowlist: rounded-[2px] (deliberate hairline fill), rounded-[min(…)]
// (token clamps in button.tsx).
const sourceFiles = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = resolve(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(tsx|ts|css)$/.test(path) && !path.endsWith("globals.radius.test.ts") ? [path] : [];
  });
})(resolve(process.cwd(), "src"));

describe("continuous-corner progressive enhancement", () => {
  // Safari 26 ignores corner-shape (stable support lands in Safari 27); the
  // @supports guard keeps older browsers on plain border-radius.
  it("applies squircle corners to the large glass surfaces", () => {
    const block = css.match(/@supports\s*\(corner-shape:\s*squircle\)\s*\{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    for (const selector of ['[data-slot="card"]', '[data-slot="dialog-content"]', ".glass-panel"]) {
      expect(block?.[0]).toContain(selector);
    }
  });
});

describe("no hardcoded corner radii outside the token scale", () => {
  it("routes every non-trivial radius through a rounded-* token utility", () => {
    const offenders = sourceFiles.flatMap((file) =>
      (readFileSync(file, "utf8").match(/rounded(?:-(?:t|b|l|r|tl|tr|bl|br|s|e))?-\[[^\]]+\]/g) ?? [])
        .filter((hit) => {
          const value = hit.match(/\[([^\]]+)\]$/)?.[1] ?? "";
          return /^\d+(\.\d+)?(px|rem)$/.test(value) && value !== "2px";
        })
        .map((hit) => `${file}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });
});
