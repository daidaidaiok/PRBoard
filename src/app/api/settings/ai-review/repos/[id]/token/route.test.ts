import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, rotateReviewToken } = vi.hoisted(() => ({ requireSession: vi.fn(), rotateReviewToken: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ rotateReviewToken }));

import { POST } from "./route";

const id = "11111111-1111-4111-8111-111111111111";
const ctx = { params: Promise.resolve({ id }) };
const req = () => new NextRequest(`http://localhost/api/settings/ai-review/repos/${id}/token`, { method: "POST" });

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  rotateReviewToken.mockResolvedValue("n".repeat(43));
});

describe("POST /api/settings/ai-review/repos/[id]/token", () => {
  it("rotates the token for the session user and returns the new plaintext once", async () => {
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(rotateReviewToken).toHaveBeenCalledWith(7, id);
    expect(await res.json()).toEqual({ token: "n".repeat(43) });
  });

  it("returns 404 for someone else's repo and 401 without a session", async () => {
    rotateReviewToken.mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(404);
    requireSession.mockResolvedValue(null);
    expect((await POST(req(), ctx)).status).toBe(401);
  });
});
