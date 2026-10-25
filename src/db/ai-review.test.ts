import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ai-review.ts imports ./index (the drizzle client), which throws without a
// live DATABASE_URL — same treatment as notification-settings.test.ts. Every
// db.<op>() call pops the next queued result and returns a chainable thenable
// that records each builder call, so tests can assert both the result mapping
// and the structure (e.g. which SQL the aggregate runs) without Postgres.
const { calls, queue, db } = vi.hoisted(() => {
  const calls: Array<{ op: string; steps: Array<[string, unknown[]]> }> = [];
  const queue: unknown[] = [];
  function chain(op: string) {
    const record = { op, steps: [] as Array<[string, unknown[]]> };
    calls.push(record);
    const result = queue.length ? queue.shift() : [];
    const proxy: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          record.steps.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  const db = {
    select: vi.fn((...args: unknown[]) => {
      const c = chain("select");
      calls.at(-1)!.steps.push(["select", args]);
      return c;
    }),
    insert: vi.fn(() => chain("insert")),
    update: vi.fn(() => chain("update")),
    delete: vi.fn(() => chain("delete")),
  };
  return { calls, queue, db };
});

vi.mock("./index", () => ({ db }));

import {
  authenticateReviewToken,
  claimBudgetAlert,
  releaseBudgetAlert,
  touchReviewConfigPull,
  upsertQuotaWindows,
  createReviewRepo,
  deleteProvider,
  deleteReviewRepo,
  listReviewOverview,
  loadProviderBudget,
  loadReviewConfigInput,
  recordReviewUsage,
  rotateReviewToken,
  setGlobalPause,
  updateReviewRepo,
  upsertProvider,
} from "./ai-review";
import { hashIngestToken } from "@/lib/host-ingest-auth";
import { aiReviewUsage } from "./schema";

const dialect = new PgDialect();

function stepArgs(callIndex: number, method: string) {
  return calls[callIndex].steps.find(([name]) => name === method)?.[1] ?? [];
}

function renderSql(expr: unknown) {
  return dialect.sqlToQuery(expr as Parameters<typeof dialect.sqlToQuery>[0]);
}

beforeEach(() => {
  calls.length = 0;
  queue.length = 0;
});

describe("authenticateReviewToken", () => {
  it("returns null for an unknown token and does not touch lastConfigAt", async () => {
    queue.push([]);
    expect(await authenticateReviewToken("wrong")).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("looks the repo up by the token's sha256 digest, never the plaintext", async () => {
    queue.push([{ repoId: "r1", userId: 7, repoFullName: "a/b", providerId: "p1" }]);
    const token = "t".repeat(43);
    expect(await authenticateReviewToken(token)).toEqual({ repoId: "r1", userId: 7, repoFullName: "a/b", providerId: "p1" });
    const where = renderSql(stepArgs(0, "where")[0]);
    expect(where.params).toContain(hashIngestToken(token));
    expect(where.params).not.toContain(token);
    // 鉴权本身是只读的：lastConfigAt 只在 config 路由通过仓库校验后才刷新。
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("recordReviewUsage", () => {
  const usage = { providerId: "p1", model: "m", inputTokens: 1, outputTokens: 2, costMicroUsd: null, prNumber: 3, runId: 9, runAttempt: 1 };

  it("reports recorded when the insert returns a row", async () => {
    queue.push([{ id: 1 }]);
    expect(await recordReviewUsage("r1", usage)).toBe("recorded");
  });

  it("reports duplicate when the (repo, run, attempt) conflict swallows the insert", async () => {
    queue.push([]);
    expect(await recordReviewUsage("r1", usage)).toBe("duplicate");
    expect(calls[0].steps.map(([name]) => name)).toContain("onConflictDoNothing");
  });
});

describe("loadReviewConfigInput", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const repoRow = { enabled: true, model: "m", thinkingLevel: "high", extraArgs: [], providerId: "p1" };
  const providerRow = { kind: "claude-oauth", baseUrl: null, secretName: "S", budgetLimit: 1000, budgetUnit: "token" };

  it("converts the period's usage totals into the provider's budget unit", async () => {
    queue.push([repoRow], [{ paused: true }], [providerRow], [{ inputTokens: 700, outputTokens: 300, costMicroUsd: 5, count: 2 }]);
    const input = await loadReviewConfigInput("r1", 7, now);
    expect(input.paused).toBe(true);
    expect(input.provider).toEqual(providerRow);
    expect(input.usedThisPeriod).toBe(1000);
  });

  it("limits the aggregate to the current UTC month and the provider", async () => {
    queue.push([repoRow], [], [providerRow], [{ inputTokens: 0, outputTokens: 0, costMicroUsd: 0, count: 0 }]);
    const input = await loadReviewConfigInput("r1", 7, now);
    expect(input.paused).toBe(false);
    const where = renderSql(stepArgs(3, "where")[0]);
    expect(where.params).toContain("p1");
    expect(where.params.map(String).some((p) => p.includes("2026-10-01"))).toBe(true);
    expect(where.sql).toContain(">=");
  });

  it("returns provider null without aggregating when the repo has no provider", async () => {
    queue.push([{ ...repoRow, providerId: null }], [{ paused: false }]);
    const input = await loadReviewConfigInput("r1", 7, now);
    expect(input.provider).toBeNull();
    expect(input.usedThisPeriod).toBe(0);
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe("token lifecycle", () => {
  it("createReviewRepo returns the plaintext token once and stores only its digest", async () => {
    queue.push([{ id: "x" }]);
    const created = await createReviewRepo(7, "a/b");
    expect(created).not.toBeNull();
    expect(created!.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const values = stepArgs(0, "values")[0] as { tokenHash: string; enabled: boolean };
    expect(values.tokenHash).toBe(hashIngestToken(created!.token));
    expect(values.enabled).toBe(false);
  });

  it("createReviewRepo returns null when the repo is already registered", async () => {
    queue.push([]);
    expect(await createReviewRepo(7, "a/b")).toBeNull();
  });

  it("rotateReviewToken stores the new digest and returns the new plaintext", async () => {
    queue.push([{ id: "r1" }]);
    const token = await rotateReviewToken(7, "r1");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const set = stepArgs(0, "set")[0] as { tokenHash: string };
    expect(set.tokenHash).toBe(hashIngestToken(token!));
  });

  it("rotateReviewToken returns null for another user's repo", async () => {
    queue.push([]);
    expect(await rotateReviewToken(8, "r1")).toBeNull();
  });
});

describe("user scoping", () => {
  it("updateReviewRepo returns false when the repo belongs to someone else", async () => {
    queue.push([]);
    expect(await updateReviewRepo(8, "r1", { enabled: true })).toBe(false);
  });

  it("updateReviewRepo refuses a providerId owned by another user", async () => {
    queue.push([]); // provider ownership lookup finds nothing
    expect(await updateReviewRepo(7, "r1", { providerId: "foreign" })).toBe(false);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("deleteReviewRepo and deleteProvider return false for another user's rows", async () => {
    queue.push([], []);
    expect(await deleteReviewRepo(8, "r1")).toBe(false);
    expect(await deleteProvider(8, "p1")).toBe(false);
  });
});

describe("claimBudgetAlert", () => {
  it("claims through a single conditional UPDATE and reports whether it won the slot", async () => {
    queue.push([{ id: "p1" }], []);
    expect(await claimBudgetAlert("p1", "2026-10", "warn")).toBe(true);
    expect(await claimBudgetAlert("p1", "2026-10", "warn")).toBe(false);
    const set = stepArgs(0, "set")[0] as { budgetAlertPeriod: string; budgetAlertLevel: string };
    expect(set).toEqual({ budgetAlertPeriod: "2026-10", budgetAlertLevel: "warn" });
  });

  it("only lets 'exhausted' overwrite a 'warn' claim of the same month (never the reverse)", async () => {
    queue.push([], []);
    await claimBudgetAlert("p1", "2026-10", "warn");
    await claimBudgetAlert("p1", "2026-10", "exhausted");
    const warnWhere = renderSql(stepArgs(0, "where")[0]).sql;
    const exhaustedWhere = renderSql(stepArgs(1, "where")[0]).sql;
    expect(exhaustedWhere).toContain('"budget_alert_level" =');
    expect(warnWhere).not.toBe(exhaustedWhere);
  });
});

describe("loadProviderBudget", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");

  it("returns null when the provider does not belong to the user", async () => {
    queue.push([]);
    expect(await loadProviderBudget(8, "p1", now)).toBeNull();
  });

  it("returns the provider's usage in its own budget unit (no quota block for API-key providers)", async () => {
    queue.push(
      [{ name: "GLM", kind: "anthropic-compatible", budgetLimit: 1000, budgetUnit: "token", quotaStopRatio: null }],
      [{ inputTokens: 600, outputTokens: 400, costMicroUsd: 0, count: 3 }],
    );
    expect(await loadProviderBudget(7, "p1", now)).toEqual({ name: "GLM", kind: "anthropic-compatible", budgetLimit: 1000, budgetUnit: "token", used: 1000, quota: null });
  });

  it("adds the subscription windows for a claude-oauth provider", async () => {
    queue.push(
      [{ name: "Claude", kind: "claude-oauth", budgetLimit: null, budgetUnit: null, quotaStopRatio: 0.9 }],
      [{ inputTokens: 1, outputTokens: 1, costMicroUsd: 0, count: 1 }],
      [{ windowType: "five_hour", utilization: 0.5, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed" }],
    );
    const result = await loadProviderBudget(7, "p1", now);
    expect(result?.quota).toEqual({
      stopRatio: 0.9,
      windows: [{ type: "five_hour", utilization: 0.5, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed" }],
    });
  });
});

describe("listReviewOverview", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const providerA = { id: "pA", userId: 7, name: "A", kind: "anthropic-compatible", baseUrl: "https://x.example", secretName: "A_KEY", budgetLimit: 1000, budgetUnit: "token" };
  const providerB = { id: "pB", userId: 7, name: "B", kind: "claude-oauth", baseUrl: null, secretName: "B_KEY", budgetLimit: null, budgetUnit: null };
  const repo = { id: "r1", repoFullName: "a/b", enabled: true, providerId: "pB", model: "m", thinkingLevel: null, extraArgs: [], tokenCreatedAt: now, lastConfigAt: null };

  function queueOverview() {
    queue.push(
      [{ paused: true }],
      [providerA, providerB],
      [repo, { ...repo, id: "r2", repoFullName: "a/c" }],
      [
        { providerId: "pA", inputTokens: 600, outputTokens: 300, costMicroUsd: 0, count: 2 },
        { providerId: "pB", inputTokens: 50, outputTokens: 5, costMicroUsd: 1_500_000, count: 3 },
      ],
      [{ repoId: "r1", lastUsageAt: new Date("2026-10-15T00:00:00Z") }],
    );
  }

  it("derives budget status per provider and joins each repo's last usage time", async () => {
    queueOverview();
    const overview = await listReviewOverview(7, now);
    expect(overview.paused).toBe(true);
    expect(overview.providers.map((p) => [p.id, p.usedThisPeriod, p.status])).toEqual([["pA", 900, "warn"], ["pB", 0, "ok"]]);
    expect(overview.repos.map((r) => [r.id, r.lastUsageAt])).toEqual([["r1", new Date("2026-10-15T00:00:00Z")], ["r2", null]]);
  });

  it("exposes raw period totals even for a provider with no budget, so usage stays visible", async () => {
    queueOverview();
    const overview = await listReviewOverview(7, now);
    expect(overview.providers[1].totals).toEqual({ inputTokens: 50, outputTokens: 5, costMicroUsd: 1_500_000, count: 3 });
  });

  it("gives a provider without usage rows zeroed totals", async () => {
    queue.push([], [providerB], [], [], []);
    const overview = await listReviewOverview(7, now);
    expect(overview.paused).toBe(false);
    expect(overview.providers[0].totals).toEqual({ inputTokens: 0, outputTokens: 0, costMicroUsd: 0, count: 0 });
  });

  it("restricts the usage aggregate to this user's providers and the current UTC month", async () => {
    queueOverview();
    await listReviewOverview(7, now);
    const where = renderSql(stepArgs(3, "where")[0]);
    expect(where.params).toContain(7);
    expect(where.params.map(String).some((p) => p.includes("2026-10-01"))).toBe(true);
  });
});

describe("upsertProvider", () => {
  const input = { name: "GLM", kind: "anthropic-compatible" as const, baseUrl: "https://x.example", secretName: "K", budgetLimit: 1000, budgetUnit: "token" as const, quotaStopRatio: null };

  it("keeps the budget-alert dedup state when only non-budget fields change", async () => {
    queue.push([{ budgetLimit: 1000, budgetUnit: "token" }], [{ id: "p1", ...input, name: "renamed" }]);
    await upsertProvider(7, { ...input, name: "renamed" }, "p1");
    const set = stepArgs(1, "set")[0] as Record<string, unknown>;
    expect(set).not.toHaveProperty("budgetAlertPeriod");
    expect(set).not.toHaveProperty("budgetAlertLevel");
  });

  it.each([
    ["limit", { budgetLimit: 2000 }],
    ["unit", { budgetUnit: "count" as const }],
  ])("resets the dedup state when the budget %s changes", async (_name, change) => {
    queue.push([{ budgetLimit: 1000, budgetUnit: "token" }], [{ id: "p1", ...input }]);
    await upsertProvider(7, { ...input, ...change }, "p1");
    expect(stepArgs(1, "set")[0]).toMatchObject({ budgetAlertPeriod: null, budgetAlertLevel: null });
  });

  it("returns null without updating when the provider is not the user's", async () => {
    queue.push([]);
    expect(await upsertProvider(8, input, "p1")).toBeNull();
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("setGlobalPause", () => {
  it("upserts the user's single settings row", async () => {
    await setGlobalPause(7, true);
    expect(stepArgs(0, "values")[0]).toMatchObject({ userId: 7, paused: true });
    expect(calls[0].steps.map(([n]) => n)).toContain("onConflictDoUpdate");
  });
});

describe("touchReviewConfigPull", () => {
  it("stamps lastConfigAt on the repo", async () => {
    await touchReviewConfigPull("r1");
    expect(stepArgs(0, "set")[0]).toHaveProperty("lastConfigAt");
  });
});

describe("releaseBudgetAlert", () => {
  it("clears only the exact (month, level) claim so a failed push can be retried", async () => {
    await releaseBudgetAlert("p1", "2026-10", "exhausted");
    expect(stepArgs(0, "set")[0]).toEqual({ budgetAlertPeriod: null, budgetAlertLevel: null });
    const where = renderSql(stepArgs(0, "where")[0]);
    expect(where.params).toEqual(expect.arrayContaining(["p1", "2026-10", "exhausted"]));
  });
});

describe("upsertProvider name conflicts", () => {
  const input = { name: "GLM", kind: "claude-oauth" as const, baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null, quotaStopRatio: 0.95 };

  it("returns 'conflict' (not an unhandled throw) when renaming onto an existing name", async () => {
    queue.push([{ budgetLimit: null, budgetUnit: null }], Object.assign(new Error("duplicate key"), { code: "23505" }));
    expect(await upsertProvider(7, input, "p1")).toBe("conflict");
  });

  it("wraps drizzle's DrizzleQueryError, whose pg code lives on .cause", async () => {
    queue.push([{ budgetLimit: null, budgetUnit: null }], Object.assign(new Error("Failed query"), { cause: { code: "23505" } }));
    expect(await upsertProvider(7, input, "p1")).toBe("conflict");
  });

  it("still rethrows unrelated database errors", async () => {
    queue.push([{ budgetLimit: null, budgetUnit: null }], new Error("connection reset"));
    await expect(upsertProvider(7, input, "p1")).rejects.toThrow("connection reset");
  });

  it("reports a create-time name clash as 'conflict' too", async () => {
    queue.push([]);
    expect(await upsertProvider(7, input)).toBe("conflict");
  });
});

describe("usage retention", () => {
  it("keeps usage rows when their repo is removed, so provider budgets cannot be reset by remove + re-add", () => {
    expect(aiReviewUsage.repoId.notNull).toBe(false);
  });
});

describe("subscription quota windows", () => {
  const now = new Date("2026-10-16T12:00:00.000Z");
  const oauth = { kind: "claude-oauth", baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null, quotaStopRatio: 0.95 };
  const repoRow = { enabled: true, model: "m", thinkingLevel: "high", extraArgs: [], providerId: "p1" };
  const zero = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, count: 0 };
  const windowRow = { windowType: "five_hour", utilization: 0.42, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed", observedAt: now };

  it("upsertQuotaWindows overwrites each (provider, window) row with the latest reading", async () => {
    await upsertQuotaWindows("p1", [{ type: "five_hour", utilization: 0.5, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed" }]);
    const values = stepArgs(0, "values")[0] as Array<{ providerId: string; windowType: string; utilization: number }>;
    expect(values).toEqual([expect.objectContaining({ providerId: "p1", windowType: "five_hour", utilization: 0.5 })]);
    expect(calls[0].steps.map(([n]) => n)).toContain("onConflictDoUpdate");
  });

  it("upsertQuotaWindows is a no-op for an empty report", async () => {
    await upsertQuotaWindows("p1", []);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("loadReviewConfigInput hands the subscription windows and stop ratio to the resolver for claude-oauth providers", async () => {
    queue.push([repoRow], [], [oauth], [zero], [windowRow]);
    const input = await loadReviewConfigInput("r1", 7, now);
    expect(input.quota).toEqual({
      windows: [{ type: "five_hour", utilization: 0.42, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed" }],
      stopRatio: 0.95,
    });
  });

  it("does not look up windows for API-key providers", async () => {
    queue.push([repoRow], [], [{ ...oauth, kind: "anthropic-compatible", baseUrl: "https://x.example", quotaStopRatio: null }], [zero]);
    const input = await loadReviewConfigInput("r1", 7, now);
    expect(input.quota).toBeUndefined();
    expect(db.select).toHaveBeenCalledTimes(4);
  });

  it("the overview carries each subscription provider's windows, binding status and when it was observed", async () => {
    const provider = { id: "pA", userId: 7, name: "Claude", kind: "claude-oauth", baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null, quotaStopRatio: 0.95 };
    queue.push(
      [],
      [provider],
      [],
      [],
      [],
      [
        { providerId: "pA", windowType: "five_hour", utilization: 0.97, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed", observedAt: now },
        { providerId: "pA", windowType: "seven_day", utilization: 0.3, resetsAt: new Date("2026-10-20T00:00:00Z"), status: "allowed", observedAt: now },
      ],
    );
    const overview = await listReviewOverview(7, now);
    const quota = overview.providers[0].quota!;
    expect(quota.status).toBe("exhausted");
    expect(quota.stopRatio).toBe(0.95);
    expect(quota.windows.map((w) => w.type)).toEqual(["five_hour", "seven_day"]);
    expect(quota.observedAt).toEqual(now);
  });

  it("API-key providers have no quota block", async () => {
    const provider = { id: "pB", userId: 7, name: "GLM", kind: "anthropic-compatible", baseUrl: "https://x.example", secretName: "GLM_API_KEY", budgetLimit: null, budgetUnit: null, quotaStopRatio: null };
    queue.push([], [provider], [], [], [], []);
    expect((await listReviewOverview(7, now)).providers[0].quota).toBeNull();
  });
});
