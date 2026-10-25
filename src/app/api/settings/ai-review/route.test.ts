import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, listReviewOverview, setGlobalPause, listLanes } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listReviewOverview: vi.fn(),
  setGlobalPause: vi.fn(),
  listLanes: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ listReviewOverview, setGlobalPause }));
vi.mock("@/db/ai-review-lanes", () => ({ listLanes }));

import { GET, PUT } from "./route";

const overview = {
  paused: false,
  providers: [
    { id: "p1", name: "Claude", kind: "claude-oauth", baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null, usedThisPeriod: 0, status: "ok", totals: { inputTokens: 700, outputTokens: 300, costMicroUsd: 1_500_000, count: 4 },
      quota: { windows: [
        { type: "five_hour", utilization: 0.42, resetsAt: new Date("2026-10-16T15:00:00Z"), status: "allowed", observedAt: new Date("2026-10-16T12:00:00Z") },
        { type: "seven_day", utilization: 0.2, resetsAt: new Date("2026-10-20T00:00:00Z"), status: "allowed", observedAt: new Date("2026-10-16T12:00:00Z") },
      ], stopRatio: 0.95, status: "ok", observedAt: new Date("2026-10-16T12:00:00Z") } },
    { id: "p2", name: "GLM", kind: "anthropic-compatible", baseUrl: "https://open.bigmodel.cn/api/anthropic", secretName: "GLM_KEY", budgetLimit: 5_500_000, budgetUnit: "usd", usedThisPeriod: 4_950_000, status: "warn", totals: { inputTokens: 0, outputTokens: 0, costMicroUsd: 4_950_000, count: 9 }, quota: null },
  ],
  repos: [{ id: "r1", repoFullName: "a/b", enabled: true, providerId: "p1", model: "m", thinkingLevel: null, extraArgs: [], tokenCreatedAt: new Date("2026-10-01T00:00:00Z"), lastConfigAt: null, lastUsageAt: null }],
};

function put(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/ai-review", {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  listReviewOverview.mockResolvedValue(overview);
  listLanes.mockResolvedValue([
    { id: "l1", repoId: "r1", laneKey: "glm", label: "GLM", kind: "api-script", thinkingMode: "toggle", enabled: true, wired: false, model: "glm-5.3", thinking: "max", credential: "ZHIPU_API_KEY", meter: "plan", providerId: null, notes: null, sortOrder: 30, updatedAt: new Date("2026-10-16T00:00:00Z") },
  ]);
});

describe("GET /api/settings/ai-review", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(listReviewOverview).not.toHaveBeenCalled();
  });

  it("returns the overview scoped to the session user, usd amounts in dollars", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(listReviewOverview).toHaveBeenCalledWith(7);
    const json = await res.json();
    expect(json.providers[1]).toMatchObject({ budgetLimit: 5.5, usedThisPeriod: 4.95, budgetUnit: "usd", status: "warn" });
    expect(json.providers[0].budgetLimit).toBeNull();
    // 没设预算的服务商也要能看到本月用了多少（页面据此展示）。订阅不按钱计费，所以不返回金额。
    expect(json.providers[0].usage).toEqual({ tokens: 1000, costUsd: null, count: 4 });
    expect(json.providers[1].usage.costUsd).toBe(4.95);
    expect(JSON.stringify(json)).not.toMatch(/tokenHash/i);
  });

  it("attaches each repo's lanes (with the thinking choices each supports) so the panel can list every AI the project's CI runs", async () => {
    const json = await (await GET()).json();
    expect(json.repos[0].lanes).toEqual([
      expect.objectContaining({ id: "l1", laneKey: "glm", wired: false, model: "glm-5.3", thinking: "max", thinkingOptions: ["off", "on", "max"] }),
    ]);
    expect(listLanes).toHaveBeenCalledWith(7);
  });

  it("gives subscription providers their window readings (utilization as a percent, ISO reset time) and API-key providers none", async () => {
    const json = await (await GET()).json();
    expect(json.providers[0].quota).toEqual({
      windows: [
        { type: "five_hour", usedPercent: 42, resetsAt: "2026-10-16T15:00:00.000Z" },
        { type: "seven_day", usedPercent: 20, resetsAt: "2026-10-20T00:00:00.000Z" },
      ],
      stopPercent: 95,
      status: "ok",
      observedAt: "2026-10-16T12:00:00.000Z",
    });
    expect(json.providers[1].quota).toBeNull();
  });
});

describe("PUT /api/settings/ai-review", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await PUT(put({ paused: true }))).status).toBe(401);
    expect(setGlobalPause).not.toHaveBeenCalled();
  });

  it("rejects cross-origin requests", async () => {
    const res = await PUT(put({ paused: true }, { origin: "https://evil.example" }));
    expect(res.status).toBe(403);
    expect(setGlobalPause).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean paused value", async () => {
    expect((await PUT(put({ paused: "yes" }))).status).toBe(400);
  });

  it("sets the global pause for the session user", async () => {
    const res = await PUT(put({ paused: true }));
    expect(res.status).toBe(200);
    expect(setGlobalPause).toHaveBeenCalledWith(7, true);
    expect(await res.json()).toEqual({ paused: true });
  });
});
