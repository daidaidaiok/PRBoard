import { describe, expect, it } from "vitest";
import {
  budgetStatus,
  currentPeriodStart,
  DEFAULT_QUOTA_STOP_RATIO,
  isAllowedSecretName,
  quotaStatus,
  quotaWindowLabel,
  resolveLaneConfig,
  resolveReviewConfig,
  type QuotaWindow,
  usedInUnit,
  validateReviewFields,
  type ReviewConfigInput,
} from "./ai-review-config";

const baseInput: ReviewConfigInput = {
  paused: false,
  repo: { enabled: true, model: "claude-opus-5-5", thinkingLevel: "high", extraArgs: [] },
  provider: {
    kind: "claude-oauth",
    baseUrl: null,
    secretName: "CLAUDE_CODE_OAUTH_TOKEN",
    budgetLimit: null,
    budgetUnit: null,
  },
  usedThisPeriod: 0,
};

describe("resolveReviewConfig", () => {
  it("returns the full config when everything is enabled", () => {
    expect(resolveReviewConfig(baseInput)).toEqual({
      enabled: true,
      providerKind: "claude-oauth",
      baseUrl: null,
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      model: "claude-opus-5-5",
      thinking: "high",
      extraArgs: [],
    });
  });

  it("global pause wins over every other state", () => {
    const input = { ...baseInput, paused: true, repo: { ...baseInput.repo, enabled: false }, provider: null };
    expect(resolveReviewConfig(input)).toEqual({ enabled: false, reason: "paused" });
  });

  it("reports disabled when the repo switch is off", () => {
    const input = { ...baseInput, repo: { ...baseInput.repo, enabled: false } };
    expect(resolveReviewConfig(input)).toEqual({ enabled: false, reason: "disabled" });
  });

  it("reports no_provider when the repo has no provider (e.g. provider deleted)", () => {
    expect(resolveReviewConfig({ ...baseInput, provider: null })).toEqual({ enabled: false, reason: "no_provider" });
  });

  it("is exhausted exactly at the budget limit but not one below", () => {
    const provider = { ...baseInput.provider!, budgetLimit: 100, budgetUnit: "token" as const };
    expect(resolveReviewConfig({ ...baseInput, provider, usedThisPeriod: 100 })).toEqual({
      enabled: false,
      reason: "budget_exhausted",
    });
    expect(resolveReviewConfig({ ...baseInput, provider, usedThisPeriod: 99 }).enabled).toBe(true);
  });

  it("never exhausts when budgetLimit is null", () => {
    expect(resolveReviewConfig({ ...baseInput, usedThisPeriod: 1e12 }).enabled).toBe(true);
  });

  it("drops non-string extraArgs defensively before emitting", () => {
    const input = { ...baseInput, repo: { ...baseInput.repo, extraArgs: ["--max-turns", "5", 7, null] } };
    const result = resolveReviewConfig(input);
    expect(result.enabled && result.extraArgs).toEqual(["--max-turns", "5"]);
  });
});

describe("budgetStatus", () => {
  it.each([
    [100, 89, "ok"],
    [100, 90, "warn"],
    [100, 99, "warn"],
    [100, 100, "exhausted"],
    [null, 1e9, "ok"],
  ] as const)("limit %s used %s → %s", (limit, used, expected) => {
    expect(budgetStatus(limit, used)).toBe(expected);
  });
});

describe("currentPeriodStart", () => {
  it("is the first instant of the UTC month", () => {
    expect(currentPeriodStart(new Date("2026-10-31T23:59:59.999Z")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rolls over at the first millisecond of the next month", () => {
    expect(currentPeriodStart(new Date("2026-11-01T00:00:00.000Z")).toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });
});

describe("validateReviewFields", () => {
  const ok = { model: "claude-opus-5-5", thinkingLevel: "high", extraArgs: [] as unknown };

  it("accepts a clean set of fields", () => {
    expect(validateReviewFields(ok)).toEqual({ ok: true });
    expect(validateReviewFields({ ...ok, thinkingLevel: null, baseUrl: "https://open.bigmodel.cn/api/anthropic" })).toEqual({ ok: true });
    expect(validateReviewFields({ ...ok, extraArgs: ["--max-turns", "40"] })).toEqual({ ok: true });
  });

  it.each(["low", "medium", "high", "xhigh", "max"])("accepts thinking level %s", (level) => {
    expect(validateReviewFields({ ...ok, thinkingLevel: level }).ok).toBe(true);
  });

  it.each([
    ["unknown thinking level", { ...ok, thinkingLevel: "extreme" }],
    ["newline injection in model", { ...ok, model: "x\n--dangerous" }],
    ["empty model", { ...ok, model: "" }],
    ["model starting with dashes", { ...ok, model: "--model" }],
    ["non-whitelisted extra arg", { ...ok, extraArgs: ["--allowedTools"] }],
    ["extraArgs not an array", { ...ok, extraArgs: "--max-turns 5" }],
    ["extra arg with newline", { ...ok, extraArgs: ["--max-turns", "5\n--x"] }],
    ["non-numeric max-turns value", { ...ok, extraArgs: ["--max-turns", "abc"] }],
    ["plain http baseUrl", { ...ok, baseUrl: "http://x.example" }],
  ])("rejects %s", (_name, fields) => {
    expect(validateReviewFields(fields).ok).toBe(false);
  });
});

describe("usedInUnit", () => {
  const totals = { inputTokens: 700, outputTokens: 300, costMicroUsd: 2_500_000, count: 4 };

  it("sums input and output tokens for the token unit", () => {
    expect(usedInUnit("token", totals)).toBe(1000);
  });

  it("reports usd in micro-USD, the same unit budgetLimit is stored in", () => {
    expect(usedInUnit("usd", totals)).toBe(2_500_000);
  });

  it("counts rows for the count unit", () => {
    expect(usedInUnit("count", totals)).toBe(4);
  });

  it("is 0 when no unit is configured", () => {
    expect(usedInUnit(null, totals)).toBe(0);
  });
});

describe("isAllowedSecretName", () => {
  it.each(["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_2", "GLM_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "AI_REVIEW_DEEPSEEK"])(
    "allows the provider-credential-shaped name %s",
    (name) => expect(isAllowedSecretName(name)).toBe(true),
  );

  it.each(["DEPLOY_KEY", "DATABASE_URL", "AUTH_SECRET", "NPM_TOKEN", "BARK_DEVICE_KEY", "GITHUB_TOKEN", "glm_api_key", "X"])(
    "refuses %s so a config cannot point the review at an unrelated repo secret",
    (name) => expect(isAllowedSecretName(name)).toBe(false),
  );
});

describe("quotaStatus (Claude subscription windows)", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const later = new Date("2026-10-16T15:00:00.000Z");
  const win = (over: Partial<QuotaWindow>): QuotaWindow => ({
    type: "five_hour",
    utilization: 0.1,
    resetsAt: later,
    status: "allowed",
    ...over,
  });

  it("is ok when there is no data yet (nothing reported = nothing to stop on)", () => {
    expect(quotaStatus([], DEFAULT_QUOTA_STOP_RATIO, now)).toEqual({ status: "ok", binding: null });
  });

  it("warns from 80% and exhausts exactly at the stop ratio", () => {
    expect(quotaStatus([win({ utilization: 0.79 })], 0.95, now).status).toBe("ok");
    expect(quotaStatus([win({ utilization: 0.8 })], 0.95, now).status).toBe("warn");
    expect(quotaStatus([win({ utilization: 0.949 })], 0.95, now).status).toBe("warn");
    expect(quotaStatus([win({ utilization: 0.95 })], 0.95, now).status).toBe("exhausted");
  });

  it("is bound by the most-used window, not the first one", () => {
    const result = quotaStatus([win({ type: "five_hour", utilization: 0.2 }), win({ type: "seven_day_opus", utilization: 0.97 })], 0.95, now);
    expect(result.status).toBe("exhausted");
    expect(result.binding?.type).toBe("seven_day_opus");
  });

  it("ignores a window whose reset time has passed — it has rolled over and the stale reading must not keep reviews paused forever", () => {
    const stale = win({ utilization: 0.99, resetsAt: new Date("2026-10-16T11:59:59.000Z") });
    expect(quotaStatus([stale], 0.95, now)).toEqual({ status: "ok", binding: null });
  });

  it("trusts the SDK's own 'rejected' status even without a utilization figure", () => {
    expect(quotaStatus([win({ utilization: null, status: "rejected" })], 0.95, now).status).toBe("exhausted");
    expect(quotaStatus([win({ utilization: null, status: "allowed_warning" })], 0.95, now).status).toBe("warn");
  });

  it("with stopRatio null it never pauses on utilization, but a real rejection still stops", () => {
    expect(quotaStatus([win({ utilization: 0.99 })], null, now).status).toBe("warn");
    expect(quotaStatus([win({ utilization: 0.99, status: "rejected" })], null, now).status).toBe("exhausted");
  });

  it("keeps a window with an unknown reset time (cannot prove it rolled over)", () => {
    expect(quotaStatus([win({ utilization: 0.96, resetsAt: null })], 0.95, now).status).toBe("exhausted");
  });
});

describe("quotaWindowLabel", () => {
  it.each([
    ["five_hour", "5 小时窗口"],
    ["seven_day", "7 天窗口"],
    ["seven_day_opus", "Opus 7 天窗口"],
    ["seven_day_sonnet", "Sonnet 7 天窗口"],
    ["something_new", "something_new"],
  ])("%s → %s", (type, label) => expect(quotaWindowLabel(type)).toBe(label));
});

describe("resolveReviewConfig with subscription quota", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const quota = (utilization: number) => ({
    windows: [{ type: "five_hour", utilization, resetsAt: new Date("2026-10-16T15:00:00.000Z"), status: "allowed" as const }],
    stopRatio: 0.95,
  });

  it("returns quota_exhausted when a subscription window is at the stop ratio", () => {
    expect(resolveReviewConfig({ ...baseInput, quota: quota(0.96), now })).toEqual({ enabled: false, reason: "quota_exhausted" });
  });

  it("keeps running below the stop ratio, and when no quota data exists", () => {
    expect(resolveReviewConfig({ ...baseInput, quota: quota(0.9), now }).enabled).toBe(true);
    expect(resolveReviewConfig(baseInput).enabled).toBe(true);
  });

  it("ranks budget_exhausted ahead of quota_exhausted when both apply", () => {
    const provider = { ...baseInput.provider!, budgetLimit: 10, budgetUnit: "count" as const };
    expect(resolveReviewConfig({ ...baseInput, provider, usedThisPeriod: 10, quota: quota(0.99), now })).toEqual({
      enabled: false,
      reason: "budget_exhausted",
    });
  });
});

describe("resolveLaneConfig", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const lane = { enabled: true, kind: "api-script" as const, model: "claude-haiku-5-5", thinking: null, credential: "ANTHROPIC_API_KEY" };
  const subscription = {
    provider: { kind: "claude-oauth" as const, baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null },
    usedThisPeriod: 0,
    quota: { windows: [{ type: "five_hour", utilization: 0.97, resetsAt: new Date("2026-10-16T15:00:00.000Z"), status: "allowed" as const }], stopRatio: 0.95 },
  };

  it("serves a lane that has no provider straight from its own record, keeping the credential name for display", () => {
    expect(resolveLaneConfig({ paused: false, lane, resolution: null, now })).toEqual({
      enabled: true,
      kind: "api-script",
      providerKind: null,
      baseUrl: null,
      secretName: "ANTHROPIC_API_KEY",
      model: "claude-haiku-5-5",
      thinking: null,
      extraArgs: [],
    });
  });

  it("global pause and the lane's own switch both turn it off, pause first", () => {
    expect(resolveLaneConfig({ paused: true, lane: { ...lane, enabled: false }, resolution: null, now })).toEqual({ enabled: false, reason: "paused" });
    expect(resolveLaneConfig({ paused: false, lane: { ...lane, enabled: false }, resolution: null, now })).toEqual({ enabled: false, reason: "disabled" });
  });

  it("a lane linked to a subscription provider stops when that subscription's window is used up", () => {
    expect(resolveLaneConfig({ paused: false, lane: { ...lane, kind: "claude-code", model: "claude-opus-5-5", thinking: "high" }, resolution: subscription, now })).toEqual({
      enabled: false,
      reason: "quota_exhausted",
    });
  });

  it("a lane linked to a provider takes the provider's endpoint and secret name, but keeps its own model and thinking", () => {
    const resolution = { ...subscription, quota: { windows: [], stopRatio: 0.95 } };
    expect(resolveLaneConfig({ paused: false, lane: { ...lane, kind: "claude-code", model: "claude-sonnet-5-5", thinking: "low" }, resolution, now })).toEqual({
      enabled: true,
      kind: "claude-code",
      providerKind: "claude-oauth",
      baseUrl: null,
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      model: "claude-sonnet-5-5",
      thinking: "low",
      extraArgs: [],
    });
  });

  it("a lane whose provider has been deleted behaves like a lane with none, not like an error", () => {
    expect(resolveLaneConfig({ paused: false, lane, resolution: null, now }).enabled).toBe(true);
  });
});
