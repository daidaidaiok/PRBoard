import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(resolve(process.cwd(), "src/components/dashboard.tsx"), "utf8");
const switcherSource = readFileSync(resolve(process.cwd(), "src/components/project-switcher.tsx"), "utf8");

describe("dashboard project switcher", () => {
  it("uses a bottom sheet switcher instead of top tabs", () => {
    expect(dashboardSource).toContain("ProjectSwitcher");
    expect(dashboardSource).not.toContain("<Tabs value={activeProject}");
    expect(dashboardSource).toContain("pb-28");
    expect(switcherSource).toContain('aria-label="选择项目"');
    expect(switcherSource).toContain("切换项目");
    expect(switcherSource).toContain("fixed inset-x-0 bottom-0");
  });
});
