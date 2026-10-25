import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, updateReviewRepo, deleteReviewRepo } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  updateReviewRepo: vi.fn(),
  deleteReviewRepo: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ updateReviewRepo, deleteReviewRepo, DEFAULT_REVIEW_MODEL: "claude-opus-5-5" }));

import { DELETE, PATCH } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };

function patch(body: unknown) {
  return new NextRequest(`http://localhost/api/settings/ai-review/repos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  updateReviewRepo.mockResolvedValue(true);
  deleteReviewRepo.mockResolvedValue(true);
});

describe("PATCH /api/settings/ai-review/repos/[id]", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await PATCH(patch({ enabled: true }), ctx)).status).toBe(401);
  });

  it("updates the allowed fields for the session user", async () => {
    const res = await PATCH(patch({ enabled: true, thinkingLevel: "high", model: "claude-opus-5-5", extraArgs: ["--max-turns", "40"] }), ctx);
    expect(res.status).toBe(200);
    expect(updateReviewRepo).toHaveBeenCalledWith(7, id, { enabled: true, thinkingLevel: "high", model: "claude-opus-5-5", extraArgs: ["--max-turns", "40"] });
  });

  it("allows clearing the provider with null", async () => {
    expect((await PATCH(patch({ providerId: null }), ctx)).status).toBe(200);
    expect(updateReviewRepo).toHaveBeenCalledWith(7, id, { providerId: null });
  });

  it.each([
    ["empty patch", {}],
    ["unknown field (tokenHash)", { tokenHash: "x" }],
    ["bad thinking level", { thinkingLevel: "extreme" }],
    ["newline injection in model", { model: "x\n--dangerous" }],
    ["non-whitelisted extra arg", { extraArgs: ["--allowedTools", "Bash"] }],
    ["non-uuid providerId", { providerId: "nope" }],
  ])("returns 400 for %s", async (_name, body) => {
    expect((await PATCH(patch(body), ctx)).status).toBe(400);
    expect(updateReviewRepo).not.toHaveBeenCalled();
  });

  it("returns 404 for a repo that is not the user's (or a foreign provider)", async () => {
    updateReviewRepo.mockResolvedValue(false);
    expect((await PATCH(patch({ enabled: true }), ctx)).status).toBe(404);
  });

  it("returns 404 for a non-uuid path id without touching the database", async () => {
    const res = await PATCH(patch({ enabled: true }), { params: Promise.resolve({ id: "not-a-uuid" }) });
    expect(res.status).toBe(404);
    expect(updateReviewRepo).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/ai-review/repos/[id]", () => {
  const del = () => new NextRequest(`http://localhost/api/settings/ai-review/repos/${id}`, { method: "DELETE" });

  it("deletes the user's repo", async () => {
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(deleteReviewRepo).toHaveBeenCalledWith(7, id);
  });

  it("returns 404 for someone else's repo and 401 without a session", async () => {
    deleteReviewRepo.mockResolvedValue(false);
    expect((await DELETE(del(), ctx)).status).toBe(404);
    requireSession.mockResolvedValue(null);
    expect((await DELETE(del(), ctx)).status).toBe(401);
  });
});
