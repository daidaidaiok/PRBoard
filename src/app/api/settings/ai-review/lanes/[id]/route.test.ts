import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, getLane, updateLane, deleteLane } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  getLane: vi.fn(),
  updateLane: vi.fn(),
  deleteLane: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review-lanes", () => ({ getLane, updateLane, deleteLane }));

import { DELETE, PATCH } from "./route";

const id = "22222222-2222-4222-8222-222222222222";
const ctx = { params: Promise.resolve({ id }) };

const claudeLane = { id, repoId: "r1", laneKey: "mention", label: "mention", kind: "claude-code", thinkingMode: "effort", enabled: true, wired: true, model: "claude-opus-5-5", thinking: null, credential: "CLAUDE_CODE_OAUTH_TOKEN", meter: "subscription", providerId: null, notes: null, sortOrder: 0 };
const glmLane = { ...claudeLane, laneKey: "glm", kind: "api-script", thinkingMode: "toggle", model: "glm-5.3", thinking: "max", meter: "plan" };
const poolLane = { ...claudeLane, laneKey: "free-pool", kind: "api-script", thinkingMode: "none", model: "a/b,c/d:free", thinking: null, meter: "free" };

const patch = (body: unknown) =>
  new NextRequest(`http://localhost/api/settings/ai-review/lanes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const del = () => new NextRequest(`http://localhost/api/settings/ai-review/lanes/${id}`, { method: "DELETE" });

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  getLane.mockResolvedValue(claudeLane);
  updateLane.mockImplementation(async (_u, _i, p) => ({ ...claudeLane, ...p }));
  deleteLane.mockResolvedValue(true);
});

describe("PATCH /api/settings/ai-review/lanes/[id]", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await PATCH(patch({ enabled: false }), ctx)).status).toBe(401);
  });

  it("returns 404 for a non-uuid id, and for a lane that is not the user's", async () => {
    expect((await PATCH(patch({ enabled: false }), { params: Promise.resolve({ id: "x" }) })).status).toBe(404);
    getLane.mockResolvedValue(null);
    expect((await PATCH(patch({ enabled: false }), ctx)).status).toBe(404);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it("switches a lane off", async () => {
    const res = await PATCH(patch({ enabled: false }), ctx);
    expect(res.status).toBe(200);
    expect(updateLane).toHaveBeenCalledWith(7, id, { enabled: false });
    expect((await res.json()).enabled).toBe(false);
  });

  it("changes the model and thinking level of a claude lane", async () => {
    expect((await PATCH(patch({ model: "claude-sonnet-5-5", thinking: "medium" }), ctx)).status).toBe(200);
    expect(updateLane).toHaveBeenCalledWith(7, id, { model: "claude-sonnet-5-5", thinking: "medium" });
  });

  it("validates a changed value against THIS lane's family, not a generic rule", async () => {
    getLane.mockResolvedValue(glmLane);
    expect((await PATCH(patch({ thinking: "off" }), ctx)).status).toBe(200);
    expect((await PATCH(patch({ thinking: "high" }), ctx)).status).toBe(400);
    getLane.mockResolvedValue(poolLane);
    expect((await PATCH(patch({ model: "x/y,z/w:free,v" }), ctx)).status).toBe(200);
    expect((await PATCH(patch({ thinking: "on" }), ctx)).status).toBe(400);
    getLane.mockResolvedValue(claudeLane);
    expect((await PATCH(patch({ model: "a,b" }), ctx)).status).toBe(400);
  });

  it("lets the thinking level be cleared back to the lane's own default", async () => {
    getLane.mockResolvedValue({ ...claudeLane, thinking: "high" });
    expect((await PATCH(patch({ thinking: null }), ctx)).status).toBe(200);
    expect(updateLane).toHaveBeenCalledWith(7, id, { thinking: null });
  });

  it.each([
    ["an empty patch", {}],
    ["a field that cannot be patched (kind)", { kind: "api-script" }],
    ["a field that cannot be patched (laneKey)", { laneKey: "other" }],
    ["a non-uuid provider id", { providerId: "nope" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await PATCH(patch(body), ctx)).status).toBe(400);
    expect(updateLane).not.toHaveBeenCalled();
  });

  it("returns 400 when the provider is not the user's, 404 when the lane vanished meanwhile", async () => {
    updateLane.mockResolvedValueOnce("invalid_provider");
    expect((await PATCH(patch({ providerId: "33333333-3333-4333-8333-333333333333" }), ctx)).status).toBe(400);
    updateLane.mockResolvedValueOnce(null);
    expect((await PATCH(patch({ enabled: true }), ctx)).status).toBe(404);
  });
});

describe("DELETE /api/settings/ai-review/lanes/[id]", () => {
  it("deletes the user's lane; 404 otherwise; 401 without a session", async () => {
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(deleteLane).toHaveBeenCalledWith(7, id);
    deleteLane.mockResolvedValue(false);
    expect((await DELETE(del(), ctx)).status).toBe(404);
    requireSession.mockResolvedValue(null);
    expect((await DELETE(del(), ctx)).status).toBe(401);
  });
});
