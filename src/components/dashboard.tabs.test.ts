import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(resolve(process.cwd(), "src/components/dashboard.tsx"), "utf8");
const projectTabsSection = dashboardSource.slice(
  dashboardSource.indexOf("<Tabs value={activeProject}"),
  dashboardSource.indexOf("      {error &&", dashboardSource.indexOf("<Tabs value={activeProject}")),
);

describe("dashboard project tabs", () => {
  it("disables native dragging and text selection while keeping horizontal scrolling", () => {
    expect(projectTabsSection).toMatch(/<TabsList\s+draggable=\{false\}/);
    expect(projectTabsSection).toContain("select-none");
    expect(projectTabsSection.match(/<TabsTrigger/g)?.length).toBeGreaterThan(0);
    expect(projectTabsSection.match(/draggable=\{false\}/g)?.length).toBe(
      (projectTabsSection.match(/<TabsTrigger/g)?.length ?? 0) + 1,
    );
    expect(projectTabsSection).toContain("overflow-x-auto");
  });
});
