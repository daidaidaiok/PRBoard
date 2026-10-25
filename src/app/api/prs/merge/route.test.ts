import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mergePullRequest, requireSession, ActionDeniedError } = vi.hoisted(() => {
  class ActionDeniedError extends Error {}
  return { mergePullRequest: vi.fn(), requireSession: vi.fn(), ActionDeniedError };
});

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/lib/github/actions", () => ({ mergePullRequest, ActionDeniedError }));

import { POST } from "./route";

describe("POST /api/prs/merge", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { githubId: 42 } });
    mergePullRequest.mockResolvedValue({ merged: true });
  });

  it("rejects unauthenticated requests", async () => {
    requireSession.mockResolvedValue(null);

    const response = await POST(new NextRequest("http://localhost/api/prs/merge", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(mergePullRequest).not.toHaveBeenCalled();
  });

  it("returns forbidden when the repository is outside the installation", async () => {
    mergePullRequest.mockRejectedValue(new ActionDeniedError("owner/repo is not a repo this app is watching"));

    const response = await POST(new NextRequest("http://localhost/api/prs/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName: "owner/repo", prNumber: 7 }),
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "owner/repo is not a repo this app is watching" });
  });
});
