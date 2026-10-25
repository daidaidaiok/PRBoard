import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, createLane } = vi.hoisted(() => ({ requireSession: vi.fn(), createLane: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review-lanes", () => ({ createLane }));

import { POST } from "./route";

const repoId = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id: repoId }) };

const haiku = {
  laneKey: "haiku-web",
  label: "Haiku (web)",
  kind: "api-script",
  thinkingMode: "none",
  model: "claude-haiku-5-5",
  credential: "ANTHROPIC_API_KEY",
  meter: "usd",
};

const post = (body: unknown) =>
  new NextRequest(`http://localhost/api/settings/ai-review/repos/${repoId}/lanes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  createLane.mockImplementation(async (_u, _r, input) => ({ id: "l1", repoId, ...input }));
});

describe("POST /api/settings/ai-review/repos/[id]/lanes", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await POST(post(haiku), ctx)).status).toBe(401);
  });

  it("returns 404 for a non-uuid repo id without touching the database", async () => {
    expect((await POST(post(haiku), { params: Promise.resolve({ id: "nope" }) })).status).toBe(404);
    expect(createLane).not.toHaveBeenCalled();
  });

  it("creates a lane with safe defaults: enabled, not wired, no thinking, no provider", async () => {
    const res = await POST(post(haiku), ctx);
    expect(res.status).toBe(201);
    expect(createLane).toHaveBeenCalledWith(7, repoId, expect.objectContaining({ enabled: true, wired: false, thinking: null, providerId: null, sortOrder: 0 }));
    const json = await res.json();
    expect(json).toMatchObject({ id: "l1", laneKey: "haiku-web", wired: false, thinkingOptions: [] });
  });

  it("tells the panel which thinking choices this lane supports", async () => {
    const res = await POST(post({ ...haiku, laneKey: "glm", kind: "api-script", thinkingMode: "toggle", model: "glm-5.3", thinking: "max", credential: "ZHIPU_API_KEY", meter: "plan" }), ctx);
    expect((await res.json()).thinkingOptions).toEqual(["off", "on", "max"]);
  });

  it.each([
    ["a lane key with uppercase/spaces", { ...haiku, laneKey: "Haiku Web" }],
    ["an effort level on a lane with no thinking control", { ...haiku, thinking: "high" }],
    ["a comma list as a claude-code model (it becomes a --model argument)", { ...haiku, kind: "claude-code", thinkingMode: "effort", model: "a,b", credential: null, meter: "subscription" }],
    ["a claude-code lane that is not on the effort scale", { ...haiku, kind: "claude-code", thinkingMode: "none", model: "claude-opus-5-5", credential: null, meter: "subscription" }],
    ["a model that could smuggle arguments", { ...haiku, model: "x --allowedTools Bash" }],
    ["a credential name that is not a secret-shaped identifier", { ...haiku, credential: "my key; rm" }],
    ["an unknown field", { ...haiku, tokenHash: "x" }],
    ["an unknown meter", { ...haiku, meter: "gold" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await POST(post(body), ctx)).status).toBe(400);
    expect(createLane).not.toHaveBeenCalled();
  });

  it("maps the data layer's outcomes: not your repo → 404, duplicate key → 409, foreign provider → 400", async () => {
    createLane.mockResolvedValueOnce(null);
    expect((await POST(post(haiku), ctx)).status).toBe(404);
    createLane.mockResolvedValueOnce("conflict");
    expect((await POST(post(haiku), ctx)).status).toBe(409);
    createLane.mockResolvedValueOnce("invalid_provider");
    expect((await POST(post(haiku), ctx)).status).toBe(400);
  });
});
