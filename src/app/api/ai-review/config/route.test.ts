import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateReviewToken, loadReviewConfigInput, touchReviewConfigPull, loadLaneConfig } = vi.hoisted(() => ({
  authenticateReviewToken: vi.fn(),
  loadReviewConfigInput: vi.fn(),
  touchReviewConfigPull: vi.fn(),
  loadLaneConfig: vi.fn(),
}));

vi.mock("@/db/ai-review", () => ({ authenticateReviewToken, loadReviewConfigInput, touchReviewConfigPull }));
vi.mock("@/db/ai-review-lanes", () => ({ loadLaneConfig }));

// resolveReviewConfig is deliberately NOT mocked: the reason precedence
// (paused > disabled > no_provider > budget_exhausted) is exactly what this
// endpoint promises to CI.
import { GET } from "./route";

const token = "a".repeat(43);
const auth = { repoId: "r1", userId: 7, repoFullName: "daidaidaiok/PRboard", providerId: "p1" };

const enabledInput = {
  paused: false,
  repo: { enabled: true, model: "claude-opus-5-5", thinkingLevel: "high", extraArgs: ["--max-turns", "40"] },
  provider: { kind: "claude-oauth", baseUrl: null, secretName: "CLAUDE_CODE_OAUTH_TOKEN", budgetLimit: null, budgetUnit: null },
  usedThisPeriod: 0,
};

function request(options: { repo?: string | null; authorization?: string | null; lane?: string } = {}) {
  const { repo = "daidaidaiok/PRboard", authorization = `Bearer ${token}` } = options;
  const url = new URL("http://localhost/api/ai-review/config");
  if (repo !== null) url.searchParams.set("repo", repo);
  if (options.lane !== undefined) url.searchParams.set("lane", options.lane);
  return new NextRequest(url, { headers: authorization === null ? {} : { authorization } });
}

beforeEach(() => {
  authenticateReviewToken.mockResolvedValue(auth);
  loadReviewConfigInput.mockResolvedValue(enabledInput);
  touchReviewConfigPull.mockResolvedValue(undefined);
});

describe("GET /api/ai-review/config", () => {
  it("returns 401 without a bearer token and never queries the database", async () => {
    const res = await GET(request({ authorization: null }));
    expect(res.status).toBe(401);
    expect(authenticateReviewToken).not.toHaveBeenCalled();
  });

  it("returns 401 for a malformed token without querying the database", async () => {
    const res = await GET(request({ authorization: "Bearer short" }));
    expect(res.status).toBe(401);
    expect(authenticateReviewToken).not.toHaveBeenCalled();
  });

  it("returns 401 for an unknown token", async () => {
    authenticateReviewToken.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
  });

  it("stamps the last-pull time only after the repo check passes", async () => {
    await GET(request({ repo: "owner/other-repo" }));
    expect(touchReviewConfigPull).not.toHaveBeenCalled();
    await GET(request());
    expect(touchReviewConfigPull).toHaveBeenCalledWith("r1");
  });

  it("returns 400 when the repo query parameter is missing", async () => {
    expect((await GET(request({ repo: null }))).status).toBe(400);
  });

  it("returns 403 when the token belongs to a different repo, without loading its config", async () => {
    const res = await GET(request({ repo: "owner/other-repo" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(loadReviewConfigInput).not.toHaveBeenCalled();
  });

  it("matches the repo name case-insensitively, as GitHub does", async () => {
    expect((await GET(request({ repo: "DaiDaiDaiOK/prboard" }))).status).toBe(200);
  });

  it("returns the full config when enabled, with exactly the documented fields", async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      enabled: true,
      providerKind: "claude-oauth",
      baseUrl: null,
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      model: "claude-opus-5-5",
      thinking: "high",
      extraArgs: ["--max-turns", "40"],
    });
  });

  it.each([
    ["paused", { ...enabledInput, paused: true }],
    ["disabled", { ...enabledInput, repo: { ...enabledInput.repo, enabled: false } }],
    ["no_provider", { ...enabledInput, provider: null }],
    ["budget_exhausted", { ...enabledInput, provider: { ...enabledInput.provider, budgetLimit: 10, budgetUnit: "count" }, usedThisPeriod: 10 }],
  ])("returns enabled:false with reason %s (HTTP 200, not an error)", async (reason, input) => {
    loadReviewConfigInput.mockResolvedValue(input);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, reason });
  });

  it("returns 502 when the database is unavailable, so the action falls back to its defaults", async () => {
    loadReviewConfigInput.mockRejectedValue(new Error("connection refused"));
    expect((await GET(request())).status).toBe(502);
  });

  it("returns 502 when token verification itself fails", async () => {
    authenticateReviewToken.mockRejectedValue(new Error("connection refused"));
    expect((await GET(request())).status).toBe(502);
  });
});

describe("GET /api/ai-review/config?lane=", () => {
  const lane = { id: "l1", enabled: true, kind: "api-script", model: "glm-5.3", thinking: "max", credential: "ZHIPU_API_KEY", providerId: null };

  beforeEach(() => {
    loadLaneConfig.mockResolvedValue({ lane, paused: false, resolution: null });
  });

  it("serves one lane's config instead of the repo-level one, scoped to the token's repo", async () => {
    const res = await GET(request({ lane: "glm" }));
    expect(res.status).toBe(200);
    expect(loadLaneConfig).toHaveBeenCalledWith("r1", 7, "glm");
    expect(loadReviewConfigInput).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({
      enabled: true,
      kind: "api-script",
      providerKind: null,
      baseUrl: null,
      secretName: "ZHIPU_API_KEY",
      model: "glm-5.3",
      thinking: "max",
      extraArgs: [],
    });
  });

  it("returns enabled:false with the reason when the lane is switched off", async () => {
    loadLaneConfig.mockResolvedValue({ lane: { ...lane, enabled: false }, paused: false, resolution: null });
    expect(await (await GET(request({ lane: "glm" }))).json()).toEqual({ enabled: false, reason: "disabled" });
  });

  it("returns 404 for a lane PRboard does not know, which the action treats as 'use the built-in default'", async () => {
    loadLaneConfig.mockResolvedValue(null);
    expect((await GET(request({ lane: "nope" }))).status).toBe(404);
  });

  it.each(["Bad Lane", "a;b", "-x", ""])("returns 400 for the lane name %j without querying", async (laneName) => {
    expect((await GET(request({ lane: laneName }))).status).toBe(400);
    expect(loadLaneConfig).not.toHaveBeenCalled();
  });

  it("never reaches the lane for a token that belongs to a different repo", async () => {
    expect((await GET(request({ repo: "owner/other-repo", lane: "glm" }))).status).toBe(403);
    expect(loadLaneConfig).not.toHaveBeenCalled();
  });

  it("returns 502 when the lane lookup fails, so the action falls back", async () => {
    loadLaneConfig.mockRejectedValue(new Error("db down"));
    expect((await GET(request({ lane: "glm" }))).status).toBe(502);
  });
});
