import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, upsertProvider } = vi.hoisted(() => ({ requireSession: vi.fn(), upsertProvider: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ upsertProvider }));

import { POST } from "./route";

const claude = { name: "Claude", kind: "claude-oauth", baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null };
const glm = { name: "GLM", kind: "anthropic-compatible", baseUrl: "https://open.bigmodel.cn/api/anthropic", secretName: "GLM_API_KEY", budgetLimit: 5.5, budgetUnit: "usd" };

function post(body: unknown) {
  return new NextRequest("http://localhost/api/settings/ai-review/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  upsertProvider.mockImplementation(async (_user, input) => ({ id: "p1", ...input }));
});

describe("POST /api/settings/ai-review/providers", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await POST(post(claude))).status).toBe(401);
  });

  it("creates a keyless-budget oauth provider", async () => {
    const res = await POST(post(claude));
    expect(res.status).toBe(201);
    expect(upsertProvider).toHaveBeenCalledWith(7, { ...claude, quotaStopRatio: 0.95 });
  });

  it("defaults a subscription provider to pausing at 95% of a window", async () => {
    await POST(post(claude));
    expect(upsertProvider).toHaveBeenCalledWith(7, expect.objectContaining({ quotaStopRatio: 0.95 }));
  });

  it("stores a custom pause threshold (percent in the API, ratio in the DB) and allows null = never pause on utilization", async () => {
    await POST(post({ ...claude, quotaStopPercent: 90 }));
    expect(upsertProvider).toHaveBeenLastCalledWith(7, expect.objectContaining({ quotaStopRatio: 0.9 }));
    await POST(post({ ...claude, quotaStopPercent: null }));
    expect(upsertProvider).toHaveBeenLastCalledWith(7, expect.objectContaining({ quotaStopRatio: null }));
  });

  it("converts a usd budget from dollars to micro-USD for storage and back in the response", async () => {
    const res = await POST(post(glm));
    expect(res.status).toBe(201);
    expect(upsertProvider).toHaveBeenCalledWith(7, { ...glm, budgetLimit: 5_500_000, quotaStopRatio: null });
    expect((await res.json()).budgetLimit).toBe(5.5);
  });

  it.each([
    ["compatible provider without baseUrl", { ...glm, baseUrl: null }],
    ["oauth provider with a baseUrl", { ...claude, baseUrl: "https://x.example" }],
    ["http baseUrl", { ...glm, baseUrl: "http://x.example" }],
    ["budgetLimit without unit", { ...claude, budgetLimit: 10, budgetUnit: null }],
    ["unit without budgetLimit", { ...claude, budgetLimit: null, budgetUnit: "token" }],
    ["zero budget", { ...claude, budgetLimit: 0, budgetUnit: "token" }],
    ["secret name that is not a valid GitHub secret name", { ...claude, secretName: "my secret\n" }],
    ["GITHUB_ prefixed secret name (reserved by GitHub)", { ...claude, secretName: "GITHUB_TOKEN" }],
    ["secret name that is not credential-shaped (could exfiltrate another repo secret)", { ...claude, secretName: "DEPLOY_KEY" }],
    ["a dollar/token budget on a subscription provider (subscriptions are limited by window, not by money)", { ...claude, budgetLimit: 10, budgetUnit: "usd" }],
    ["a pause threshold on an API-key provider", { ...glm, quotaStopPercent: 90 }],
    ["a pause threshold below 50%", { ...claude, quotaStopPercent: 30 }],
    ["a pause threshold above 100%", { ...claude, quotaStopPercent: 120 }],
    ["a fractional pause threshold", { ...claude, quotaStopPercent: 90.5 }],
    ["unknown kind", { ...claude, kind: "openai" }],
    ["empty name", { ...claude, name: "" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await POST(post(body))).status).toBe(400);
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  it("returns 409 when the name is already taken", async () => {
    upsertProvider.mockResolvedValue("conflict");
    expect((await POST(post(claude))).status).toBe(409);
  });
});
