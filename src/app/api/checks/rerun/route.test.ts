import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rerunFailedJobs, requireSession } = vi.hoisted(() => ({ rerunFailedJobs: vi.fn(), requireSession: vi.fn() }));

vi.mock("@/lib/auth-guard", () => ({
  requireSession,
}));

vi.mock("@/lib/github/actions", () => ({
  ActionDeniedError: class ActionDeniedError extends Error {},
  rerunFailedJobs,
}));

import { POST } from "./route";

describe("POST /api/checks/rerun", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { githubId: 42 } });
    rerunFailedJobs.mockResolvedValue({});
  });

  it("uses the Actions workflow run endpoint for a manual retry", async () => {
    const req = new NextRequest("http://localhost/api/checks/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName: "owner/repo", workflowRunId: 987654321 }),
    });

    const response = await POST(req);

    expect(response.status).toBe(200);
    expect(rerunFailedJobs).toHaveBeenCalledWith({
      githubUserId: 42,
      repoFullName: "owner/repo",
      workflowRunId: 987654321,
      trigger: "manual",
    });
  });

  it("rejects an unauthenticated request before parsing its body", async () => {
    requireSession.mockResolvedValue(null);

    const response = await POST(new NextRequest("http://localhost/api/checks/rerun", { method: "POST", body: "not-json" }));

    expect(response.status).toBe(401);
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });

  it("rejects a malformed repository identifier", async () => {
    const response = await POST(new NextRequest("http://localhost/api/checks/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName: "owner/repo/extra", workflowRunId: 1 }),
    }));

    expect(response.status).toBe(400);
    expect(rerunFailedJobs).not.toHaveBeenCalled();
  });
});
