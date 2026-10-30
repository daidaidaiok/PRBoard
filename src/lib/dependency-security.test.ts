import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));

function atLeast(version: string, minimum: string): boolean {
  const actual = version.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== floor[i]) return actual[i] > floor[i];
  }
  return true;
}

describe("dependency security baseline", () => {
  it.each([
    ["next", "16.4.3"], ["eslint-config-next", "16.4.3"],
    ["zod", "4.6.6"], ["systeminformation", "5.33.19"], ["shadcn", "4.23.0"],
  ])("locks %s at or above patched baseline %s", (name, minimum) => {
    expect(atLeast(lock.packages[`node_modules/${name}`].version, minimum)).toBe(true);
  });

  it("keeps the Next.js lint config aligned with the framework", () => {
    expect(manifest.devDependencies["eslint-config-next"]).toBe(manifest.dependencies.next);
    expect(lock.packages["node_modules/eslint-config-next"].version).toBe(lock.packages["node_modules/next"].version);
  });

  it("keeps the manifest and root lockfile dependency declarations in sync", () => {
    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages[""].devDependencies).toEqual(manifest.devDependencies);
  });
});
