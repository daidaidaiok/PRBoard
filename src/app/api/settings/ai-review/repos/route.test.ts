import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, createReviewRepo } = vi.hoisted(() => ({ requireSession: vi.fn(), createReviewRepo: vi.fn() }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/ai-review", () => ({ createReviewRepo }));

import { POST } from "./route";

function post(body: unknown) {
  return new NextRequest("http://localhost/api/settings/ai-review/repos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  requireSession.mockResolvedValue({ user: { userId: 7 } });
  createReviewRepo.mockResolvedValue({ repoId: "r1", token: "t".repeat(43) });
});

describe("POST /api/settings/ai-review/repos", () => {
  it("returns 401 without a session", async () => {
    requireSession.mockResolvedValue(null);
    expect((await POST(post({ repoFullName: "a/b" }))).status).toBe(401);
  });

  it.each(["", "no-slash", "a/b/c", "a b/c", "../x", "a/b\n"])("returns 400 for repoFullName %j", async (repoFullName) => {
    expect((await POST(post({ repoFullName }))).status).toBe(400);
    expect(createReviewRepo).not.toHaveBeenCalled();
  });

  it("creates the repo and returns the plaintext token exactly once, with 201", async () => {
    const res = await POST(post({ repoFullName: "owner/other-repo" }));
    expect(res.status).toBe(201);
    expect(createReviewRepo).toHaveBeenCalledWith(7, "owner/other-repo");
    expect(await res.json()).toEqual({ repoId: "r1", token: "t".repeat(43) });
  });

  it("returns 409 when the repo is already registered", async () => {
    createReviewRepo.mockResolvedValue(null);
    expect((await POST(post({ repoFullName: "a/b" }))).status).toBe(409);
  });
});
