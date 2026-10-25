import { describe, expect, it } from "vitest";
import {
  budgetPercent,
  buildWorkflowSnippet,
  formatAmount,
  formatRelativeTime,
  formatResetIn,
  formatUsageSummary,
  LANE_PRESETS,
  laneStatus,
  meterLabel,
  remainingPercent,
  statusBarClass,
  windowStatus,
} from "./ai-review-view";

describe("budgetPercent", () => {
  it.each([
    [100, 0, 0],
    [100, 45.4, 45],
    [100, 100, 100],
    [100, 250, 100],
  ])("limit %s used %s → %s%%", (limit, used, expected) => {
    expect(budgetPercent(limit, used)).toBe(expected);
  });

  it("has no percentage without a limit, and never divides by zero", () => {
    expect(budgetPercent(null, 50)).toBeNull();
    expect(budgetPercent(0, 50)).toBeNull();
  });
});

describe("statusBarClass", () => {
  it("maps each budget status to a distinct bar colour (yellow warn, red exhausted)", () => {
    expect(statusBarClass("ok")).toContain("emerald");
    expect(statusBarClass("warn")).toContain("amber");
    expect(statusBarClass("exhausted")).toContain("destructive");
  });
});

describe("formatAmount", () => {
  it("formats each unit readably", () => {
    expect(formatAmount("token", 1_234_567)).toBe("1,234,567 tokens");
    expect(formatAmount("usd", 4.95)).toBe("$4.95");
    expect(formatAmount("count", 12)).toBe("12 次");
    expect(formatAmount(null, 3)).toBe("—");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it.each([
    ["2026-10-16T11:59:40.000Z", "刚刚"],
    ["2026-10-16T11:55:00.000Z", "5 分钟前"],
    ["2026-10-16T09:00:00.000Z", "3 小时前"],
    ["2026-10-13T12:00:00.000Z", "3 天前"],
  ])("%s → %s", (iso, expected) => {
    expect(formatRelativeTime(new Date(iso), now)).toBe(expected);
  });

  it("shows a placeholder for never, and tolerates ISO strings from JSON", () => {
    expect(formatRelativeTime(null, now)).toBe("从未");
    expect(formatRelativeTime("2026-10-16T11:55:00.000Z", now)).toBe("5 分钟前");
  });
});

describe("buildWorkflowSnippet", () => {
  const snippet = buildWorkflowSnippet("https://prboard.example.com");

  it("references both composite actions and the one secret the repo needs", () => {
    expect(snippet).toContain("daidaidaiok/PRboard/.github/actions/ai-review-config@main");
    expect(snippet).toContain("daidaidaiok/PRboard/.github/actions/ai-review-usage@main");
    expect(snippet).toContain("secrets.PRBOARD_TOKEN");
    expect(snippet).toContain("prboard-url: https://prboard.example.com");
  });

  it("gates the review on the config's enabled output and wires the outputs into claude-code-action", () => {
    expect(snippet).toContain("steps.ai-review-config.outputs.enabled == 'true'");
    expect(snippet).toContain("--model ${{ steps.ai-review-config.outputs.model }}");
    expect(snippet).toContain("--effort ${{ steps.ai-review-config.outputs.effort }}");
    expect(snippet).toContain("${{ steps.ai-review-config.outputs.extra-args }}");
    expect(snippet).toContain("ANTHROPIC_BASE_URL: ${{ steps.ai-review-config.outputs.base-url || 'https://api.anthropic.com' }}");
    expect(snippet).toContain("source: ${{ steps.ai-review-config.outputs.source }}");
  });

  it("never embeds a token value", () => {
    expect(snippet).not.toMatch(/[A-Za-z0-9_-]{43}/);
  });
});

describe("formatUsageSummary", () => {
  it("summarises runs, tokens and cost", () => {
    expect(formatUsageSummary({ tokens: 1_234_567, costUsd: 1.5, count: 4 })).toBe("4 次 · 1,234,567 tokens · $1.50");
  });

  it("shows no money for a subscription (costUsd null) — it is billed by quota window, not by dollar", () => {
    expect(formatUsageSummary({ tokens: 1_650_670, costUsd: null, count: 3 })).toBe("3 次 · 1,650,670 tokens");
  });

  it("omits the cost when the provider does not report one", () => {
    expect(formatUsageSummary({ tokens: 10, costUsd: 0, count: 1 })).toBe("1 次 · 10 tokens");
  });

  it("says so plainly when nothing has run this month", () => {
    expect(formatUsageSummary({ tokens: 0, costUsd: 0, count: 0 })).toBe("本月暂无用量");
  });
});

import { validateLaneFields } from "./ai-review-lanes";

describe("LANE_PRESETS", () => {
  it("every preset's own defaults pass the same validation the server applies", () => {
    for (const preset of LANE_PRESETS) {
      expect(validateLaneFields({ kind: preset.kind, thinkingMode: preset.thinkingMode, model: preset.model, thinking: preset.thinking }), preset.id).toEqual({ ok: true });
    }
  });

  it("covers the review families a project actually runs", () => {
    expect(LANE_PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(["claude", "mention", "haiku", "glm", "free-pool"]));
  });

  it("presets only name credentials in secret style and never carry a value", () => {
    for (const preset of LANE_PRESETS) expect(preset.credential).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });
});

describe("meterLabel", () => {
  it.each([
    ["subscription", "订阅窗口"],
    ["usd", "按量（美元）"],
    ["plan", "套餐"],
    ["free", "免费"],
  ] as const)("%s → %s", (meter, label) => expect(meterLabel(meter)).toBe(label));
});

describe("laneStatus", () => {
  it("separates 'CI really obeys this' from 'just a record', so a panel edit never looks effective when it is not", () => {
    expect(laneStatus({ wired: true, enabled: true })).toEqual({ text: "已接入 · 运行中", tone: "on", editable: true });
    expect(laneStatus({ wired: true, enabled: false })).toEqual({ text: "已接入 · 已关闭", tone: "off", editable: true });
    expect(laneStatus({ wired: false, enabled: true })).toEqual({ text: "未接入 · 只读（改了不生效）", tone: "readonly", editable: false });
    expect(laneStatus({ wired: false, enabled: false }).editable).toBe(false);
  });
});

describe("remainingPercent", () => {
  it.each([
    [42, 58],
    [0, 100],
    [100, 0],
    [100.4, 0],
    [42.5, 57.5],
  ])("used %s%% → %s%% left", (used, left) => expect(remainingPercent(used)).toBe(left));

  it("is unknown when the SDK gave no utilization", () => {
    expect(remainingPercent(null)).toBeNull();
  });
});

describe("windowStatus", () => {
  it("is yellow from 80% and red at the pause threshold, matching the server's rule", () => {
    expect(windowStatus(79.9, 95)).toBe("ok");
    expect(windowStatus(80, 95)).toBe("warn");
    expect(windowStatus(94.9, 95)).toBe("warn");
    expect(windowStatus(95, 95)).toBe("exhausted");
  });

  it("with no pause threshold only 100% counts as exhausted", () => {
    expect(windowStatus(99, null)).toBe("warn");
    expect(windowStatus(100, null)).toBe("exhausted");
  });

  it("is ok when utilization is unknown", () => {
    expect(windowStatus(null, 95)).toBe("ok");
  });
});

describe("formatResetIn", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it.each([
    ["2026-10-16T12:00:40.000Z", "不到 1 分钟后重置"],
    ["2026-10-16T12:25:00.000Z", "25 分钟后重置"],
    ["2026-10-16T15:12:00.000Z", "3 小时 12 分钟后重置"],
    ["2026-10-16T17:00:00.000Z", "5 小时后重置"],
    ["2026-10-19T12:00:00.000Z", "3 天后重置"],
    ["2026-10-19T18:00:00.000Z", "3 天 6 小时后重置"],
  ])("%s → %s", (iso, expected) => expect(formatResetIn(iso, now)).toBe(expected));

  it("says it already reset once the time has passed, and is silent when unknown", () => {
    expect(formatResetIn("2026-10-16T11:00:00.000Z", now)).toBe("已重置");
    expect(formatResetIn(null, now)).toBe("重置时间未知");
  });
});
