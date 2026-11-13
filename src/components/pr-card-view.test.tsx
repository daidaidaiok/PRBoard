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

describe("review gate badge", () => {
  const renderFull = (
    reviewDecision: string | null,
    mergeable = "MERGEABLE",
    rollupState: string | null = "success",
    reviewFindings?: { id: string; author: string; body: string }[],
  ) =>
    renderToStaticMarkup(
      createElement(PrCard, {
        ...props,
        pr: { ...props.pr, reviewDecision, mergeable, rollupState, reviewFindings },
        compact: false,
        onCompactChange: noop,
      }),
    );

  it.each([
    ["CHANGES_REQUESTED", "待修复", "circle-x"],
    ["REVIEW_REQUIRED", "待 review", "circle-dashed"],
  ])("shows %s as a blocking badge and keeps merge disabled", (reviewDecision, label, icon) => {
    const html = renderFull(reviewDecision);
    expect(html).toContain(label);
    expect(html).toContain(icon);
    // disabled 属性本身（disabled=""），排除 class 里的 disabled:* 工具类名。
    expect(html).toMatch(/<button\b[^>]*?\sdisabled(?==|>|\s)/);
    expect(html).not.toContain("可合并");
  });

  it("shows no review badge when everything is resolved — the lit merge button IS the ready signal", () => {
    const html = renderFull("APPROVED", "MERGEABLE", "success");
    expect(html).not.toContain("可合并");
    expect(html).not.toContain("待修复");
    expect(html).not.toContain("待 review");
    expect(html).not.toMatch(/<button\b[^>]*?\sdisabled(?==|>|\s)/);
  });

  it.each([
    ["failure", "失败"],
    ["pending", "进行中"],
    ["expected", "进行中"],
  ])("shows no review badge while CI is %s either", (rollupState, rollupLabel) => {
    const html = renderFull("APPROVED", "MERGEABLE", rollupState);
    expect(html).not.toContain("可合并");
    expect(html).toContain(rollupLabel);
  });

  it("does not double-label while conflicting", () => {
    const html = renderFull("CHANGES_REQUESTED", "CONFLICTING");
    expect(html).toContain("解决冲突");
    expect(html).not.toContain("可合并");
  });

  it("shows no gate badge without review info", () => {
    const html = renderFull(null, "UNKNOWN");
    expect(html).not.toContain("待修复");
    expect(html).not.toContain("待 review");
    expect(html).not.toContain("可合并");
  });

  it("shows the blocking badge in compact view too", () => {
    const html = renderToStaticMarkup(
      createElement(PrCard, {
        ...props,
        pr: { ...props.pr, reviewDecision: "CHANGES_REQUESTED" },
        compact: true,
        onCompactChange: noop,
      }),
    );
    expect(html).toContain("待修复");
  });

  it("lists each review finding with its author and body in the full view", () => {
    const html = renderFull("CHANGES_REQUESTED", "MERGEABLE", "success", [
      { id: "t1", author: "cursor[bot]", body: "Merge badge ignores failing CI\n\nmore detail below" },
      { id: "t2", author: "alice", body: "这个循环会越界" },
    ]);
    expect(html).toContain("cursor[bot]");
    expect(html).toContain("Merge badge ignores failing CI");
    expect(html).toContain("alice");
    expect(html).toContain("这个循环会越界");
    // 列出的内容必须可点回 GitHub
    expect(html).toMatch(/href="https:\/\/example\.com\/pr\/1"/);
  });

  it("shows the finding count on the badge", () => {
    const html = renderFull("CHANGES_REQUESTED", "MERGEABLE", "success", [
      { id: "t1", author: "cursor[bot]", body: "a" },
      { id: "t2", author: "alice", body: "b" },
    ]);
    expect(html).toContain("待修复 ×2");
  });

  it("hides the findings block in compact view", () => {
    const html = renderToStaticMarkup(
      createElement(PrCard, {
        ...props,
        pr: {
          ...props.pr,
          reviewDecision: "CHANGES_REQUESTED",
          reviewFindings: [{ id: "t1", author: "alice", body: "越界" }],
        },
        compact: true,
        onCompactChange: noop,
      }),
    );
    expect(html).toContain("待修复 ×1");
    expect(html).not.toContain("越界");
  });

  it("does not render a findings block when nothing is unresolved", () => {
    const html = renderFull("APPROVED", "MERGEABLE", "success", []);
    expect(html).not.toContain("alice");
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
