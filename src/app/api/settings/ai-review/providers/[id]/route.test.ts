import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, upsertProvider, deleteProvider } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  upsertProvider: vi.fn(),
  deleteProvider: vi.fn(),
}));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ upsertProvider, deleteProvider }));

import { DELETE, PUT } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const body = { name: "GLM", kind: "anthropic-compatible", baseUrl: "https://open.bigmodel.cn/api/anthropic", secretName: "GLM_API_KEY", budgetLimit: 1_000_000, budgetUnit: "token" };

const put = (payload: unknown) =>
  new NextRequest(`http://localhost/api/settings/ai-review/providers/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
const del = () => new NextRequest(`http://localhost/api/settings/ai-review/providers/${id}`, { method: "DELETE" });

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  upsertProvider.mockImplementation(async (_user, input, providerId) => ({ id: providerId, ...input }));
  deleteProvider.mockResolvedValue(true);
});

describe("PUT /api/settings/ai-review/providers/[id]", () => {
  it("replaces the provider for the session user", async () => {
    const res = await PUT(put(body), ctx);
    expect(res.status).toBe(200);
    expect(upsertProvider).toHaveBeenCalledWith(7, { ...body, quotaStopRatio: null }, id);
  });

  it("returns 409 when the new name collides with another provider", async () => {
    upsertProvider.mockResolvedValue("conflict");
    expect((await PUT(put(body), ctx)).status).toBe(409);
  });

  it("returns 400 on invalid input, 404 when not found, 401 without a session", async () => {
    expect((await PUT(put({ ...body, baseUrl: "http://x" }), ctx)).status).toBe(400);
    upsertProvider.mockResolvedValue(null);
    expect((await PUT(put(body), ctx)).status).toBe(404);
    requireSession.mockResolvedValue(null);
    expect((await PUT(put(body), ctx)).status).toBe(401);
  });
});

describe("DELETE /api/settings/ai-review/providers/[id]", () => {
  it("deletes the user's provider; 404 for someone else's; 401 without a session", async () => {
    expect((await DELETE(del(), ctx)).status).toBe(200);
    expect(deleteProvider).toHaveBeenCalledWith(7, id);
    deleteProvider.mockResolvedValue(false);
    expect((await DELETE(del(), ctx)).status).toBe(404);
    requireSession.mockResolvedValue(null);
    expect((await DELETE(del(), ctx)).status).toBe(401);
  });
});
