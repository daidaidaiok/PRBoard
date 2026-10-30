import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrCard, type PrCardProps } from "./pr-card";

const noop = () => {};
const props = {
  pr: { id: "one", title: "测试 PR", number: 1, url: "https://example.com/pr/1", repoFullName: "owner/repo", checks: [],
    isDraft: false, createdAt: "2026-10-30T00:00:00Z", updatedAt: "2026-10-30T00:00:00Z",
    author: null, installationId: 1, headRefName: "feature", baseRefName: "staging",
    mergeable: "UNKNOWN", reviewDecision: null, rollupState: null },
  compact: true, onCompactChange: noop,
  repoDisplayName: "repo", isReady: false, pendingKey: null,
  poppingCheckIds: new Set(), shakingCheckIds: new Set(),
  onMergeRequest: noop, onRerun: noop, onRerunAll: noop, onReadyGlowEnd: noop, onFlourishEnd: noop,
} satisfies PrCardProps;

describe("compact PR status", () => {
  it.each([
    ["success", "通过", "circle-check"], ["failure", "失败", "circle-x"],
    ["error", "失败", "circle-x"], ["pending", "进行中", "loader-circle"],
    ["expected", "进行中", "loader-circle"], [null, "无检查", "circle-dashed"],
  ])("shows text and a distinct icon for %s", (rollupState, label, icon) => {
    const html = renderToStaticMarkup(createElement(PrCard, {
      ...props, pr: { ...props.pr, rollupState }, compact: true, onCompactChange: noop,
    }));
    expect(html).toContain("展开 PR 卡片");
    expect(html).toContain(label);
    expect(html).toContain(icon);
    expect(html).not.toContain("收起为精简视图");
  });
});

it("wires one icon toggle and controlled cards without remounting", () => {
  const source = readFileSync("src/components/dashboard.tsx", "utf8");
  const toolbarStart = source.indexOf('aria-label="PR 卡片展示"');
  const toolbar = source.slice(toolbarStart, source.indexOf("</div>", toolbarStart));
  expect(toolbar.match(/<Button\b/g)).toHaveLength(1);
  expect(toolbar).toContain('size="icon-sm"');
  expect(toolbar).toContain('aria-label={allCompact ? "全部展开" : "全部折叠"}');
  expect(toolbar).toContain('title={allCompact ? "全部展开" : "全部折叠"}');
  expect(toolbar).toContain('onClick={() => setAllCompact(!allCompact)}');
  expect(source).toContain('displayPrs.every((pr) => compactOverrides[pr.id] ?? defaultCompact)');
  expect(source).toContain("compact={");
  expect(source).toContain("onCompactChange={handleCompactChange}");
  expect(source).toContain("key={pr.id}");
});
