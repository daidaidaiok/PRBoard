import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateReviewToken, recordReviewUsage, upsertQuotaWindows, checkBudgetAlert } = vi.hoisted(() => ({
  authenticateReviewToken: vi.fn(),
  recordReviewUsage: vi.fn(),
  upsertQuotaWindows: vi.fn(),
  checkBudgetAlert: vi.fn(),
}));

vi.mock("@/db/ai-review", () => ({ authenticateReviewToken, recordReviewUsage, upsertQuotaWindows }));
vi.mock("@/db/ai-review-budget-alert", () => ({ checkBudgetAlert }));

import { POST } from "./route";

const token = "a".repeat(43);
const auth = { repoId: "r1", userId: 7, repoFullName: "daidaidaiok/PRboard", providerId: "p1" };

function body(overrides: Record<string, unknown> = {}) {
  return {
    repo: "daidaidaiok/PRboard",
    model: "claude-opus-5-5",
    inputTokens: 1200,
    outputTokens: 340,
    costMicroUsd: 54_000,
    prNumber: 42,
    runId: 123456789,
    runAttempt: 1,
    ...overrides,
  };
}

function request(payload: unknown, options: { authorization?: string | null; raw?: string } = {}) {
  const { authorization = `Bearer ${token}` } = options;
  return new NextRequest("http://localhost/api/ai-review/usage", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(authorization === null ? {} : { authorization }) },
    body: options.raw ?? JSON.stringify(payload),
  });
}

beforeEach(() => {
  authenticateReviewToken.mockResolvedValue(auth);
  recordReviewUsage.mockResolvedValue("recorded");
  upsertQuotaWindows.mockResolvedValue(undefined);
  checkBudgetAlert.mockResolvedValue("none");
});

describe("POST /api/ai-review/usage", () => {
  it("returns 401 without a valid bearer token", async () => {
    expect((await POST(request(body(), { authorization: null }))).status).toBe(401);
    authenticateReviewToken.mockResolvedValue(null);
    expect((await POST(request(body()))).status).toBe(401);
    expect(recordReviewUsage).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request before reading or parsing its body", async () => {
    authenticateReviewToken.mockResolvedValue(null);
    const res = await POST(request(null, { raw: "not json at all" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when the reported repo is not the token's repo", async () => {
    const res = await POST(request(body({ repo: "owner/other-repo" })));
    expect(res.status).toBe(403);
    expect(recordReviewUsage).not.toHaveBeenCalled();
  });

  it("records usage against the token's repo and provider, returning 202", async () => {
    const res = await POST(request(body()));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, result: "recorded" });
    expect(recordReviewUsage).toHaveBeenCalledWith("r1", {
      providerId: "p1",
      model: "claude-opus-5-5",
      inputTokens: 1200,
      outputTokens: 340,
      costMicroUsd: 54_000,
      prNumber: 42,
      runId: 123456789,
      runAttempt: 1,
    });
  });

  it("accepts a report without optional cost and PR number", async () => {
    const minimal = body({ costMicroUsd: undefined, prNumber: undefined });
    expect((await POST(request(minimal))).status).toBe(202);
    expect(recordReviewUsage).toHaveBeenCalledWith("r1", expect.objectContaining({ costMicroUsd: null, prNumber: null }));
  });

  it("checks the provider's budget after a fresh record, but not for duplicates", async () => {
    await POST(request(body()));
    expect(checkBudgetAlert).toHaveBeenCalledWith(7, "p1");
    checkBudgetAlert.mockClear();
    recordReviewUsage.mockResolvedValue("duplicate");
    await POST(request(body()));
    expect(checkBudgetAlert).not.toHaveBeenCalled();
  });

  it("skips the budget check when the repo has no provider", async () => {
    authenticateReviewToken.mockResolvedValue({ ...auth, providerId: null });
    await POST(request(body()));
    expect(checkBudgetAlert).not.toHaveBeenCalled();
  });

  it("still returns 202 when the best-effort budget check fails", async () => {
    checkBudgetAlert.mockRejectedValue(new Error("bark down"));
    const res = await POST(request(body()));
    expect(res.status).toBe(202);
  });

  describe("subscription window readings (rateLimits)", () => {
    const rateLimits = [
      { type: "five_hour", utilization: 0.42, resetsAt: "2026-10-16T15:00:00.000Z", status: "allowed" },
      { type: "seven_day", utilization: 0.2, resetsAt: "2026-10-20T00:00:00.000Z", status: "allowed_warning" },
    ];

    it("stores the readings against the repo's provider, converting reset times to Dates", async () => {
      const res = await POST(request(body({ rateLimits })));
      expect(res.status).toBe(202);
      expect(upsertQuotaWindows).toHaveBeenCalledWith("p1", [
        { type: "five_hour", utilization: 0.42, resetsAt: new Date("2026-10-16T15:00:00.000Z"), status: "allowed" },
        { type: "seven_day", utilization: 0.2, resetsAt: new Date("2026-10-20T00:00:00.000Z"), status: "allowed_warning" },
      ]);
    });

    it("accepts readings that carry only a status (the SDK sometimes omits utilization and reset time)", async () => {
      await POST(request(body({ rateLimits: [{ type: "five_hour", utilization: null, resetsAt: null, status: "rejected" }] })));
      expect(upsertQuotaWindows).toHaveBeenCalledWith("p1", [{ type: "five_hour", utilization: null, resetsAt: null, status: "rejected" }]);
    });

    it("does nothing with readings when the repo has no provider", async () => {
      authenticateReviewToken.mockResolvedValue({ ...auth, providerId: null });
      expect((await POST(request(body({ rateLimits })))).status).toBe(202);
      expect(upsertQuotaWindows).not.toHaveBeenCalled();
    });

    it("never fails the report because the readings could not be saved", async () => {
      upsertQuotaWindows.mockRejectedValue(new Error("db down"));
      expect((await POST(request(body({ rateLimits })))).status).toBe(202);
    });

    it.each([
      ["utilization above 1", [{ type: "five_hour", utilization: 1.4, resetsAt: null, status: "allowed" }]],
      ["negative utilization", [{ type: "five_hour", utilization: -0.1, resetsAt: null, status: "allowed" }]],
      ["a window type with odd characters", [{ type: "five hour; drop", utilization: 0.1, resetsAt: null, status: "allowed" }]],
      ["an unknown status", [{ type: "five_hour", utilization: 0.1, resetsAt: null, status: "weird" }]],
      ["a non-date reset time", [{ type: "five_hour", utilization: 0.1, resetsAt: "tomorrow", status: "allowed" }]],
      ["more than 8 windows", Array.from({ length: 9 }, (_, i) => ({ type: `w${i}`, utilization: 0.1, resetsAt: null, status: "allowed" }))],
    ])("returns 400 for %s", async (_name, bad) => {
      expect((await POST(request(body({ rateLimits: bad })))).status).toBe(400);
      expect(upsertQuotaWindows).not.toHaveBeenCalled();
    });
  });

  it("reports a repeated run as duplicate, still 200-class", async () => {
    recordReviewUsage.mockResolvedValue("duplicate");
    const res = await POST(request(body()));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, result: "duplicate" });
  });

  it("returns 413 for an oversized body before parsing it", async () => {
    const res = await POST(request(null, { raw: JSON.stringify(body({ model: "x".repeat(5000) })) }));
    expect(res.status).toBe(413);
  });

  it.each([
    ["unknown field", body({ extra: 1 })],
    ["negative tokens", body({ inputTokens: -1 })],
    ["fractional tokens", body({ outputTokens: 1.5 })],
    ["absurd token count", body({ inputTokens: 1e12 })],
    ["zero runAttempt", body({ runAttempt: 0 })],
    ["missing runId", body({ runId: undefined })],
  ])("returns 400 for %s", async (_name, payload) => {
    expect((await POST(request(payload))).status).toBe(400);
  });

  it("returns 400 for non-JSON", async () => {
    expect((await POST(request(null, { raw: "not json" }))).status).toBe(400);
  });

  it("returns 502 when the database is unavailable", async () => {
    recordReviewUsage.mockRejectedValue(new Error("connection refused"));
    expect((await POST(request(body()))).status).toBe(502);
  });
});
