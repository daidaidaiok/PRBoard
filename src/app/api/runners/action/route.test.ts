import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { cancelWorkflowRun, forceCancelWorkflowRun, deleteWorkflowRun, getWorkflowRunStatus, requireSession } = vi.hoisted(() => ({
  cancelWorkflowRun: vi.fn(),
  forceCancelWorkflowRun: vi.fn(),
  deleteWorkflowRun: vi.fn(),
  getWorkflowRunStatus: vi.fn(async () => "in_progress"),
  requireSession: vi.fn(),
}));
vi.mock("@/lib/github/runners", () => ({ getWorkflowRunStatus }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/db/users", () => ({ getUserByGithubId: vi.fn(async () => ({ id: 5 })) }));
vi.mock("@/lib/github/actions", () => ({ cancelWorkflowRun, forceCancelWorkflowRun, deleteWorkflowRun, ActionDeniedError: class ActionDeniedError extends Error {} }));

import { POST } from "./route";

describe("POST /api/runners/action", () => {
  beforeEach(() => requireSession.mockResolvedValue({ user: { githubId: 42 } }));

  it("dispatches a cancel action", async () => {
    const request = new NextRequest("http://localhost/api/runners/action", {
      method: "POST",
      body: JSON.stringify({ repoFullName: "owner/repo", workflowRunId: 123, action: "cancel" }),
      headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(cancelWorkflowRun).toHaveBeenCalledWith({ githubUserId: 42, repoFullName: "owner/repo", workflowRunId: 123 });
  });

  it("rejects invalid action payloads", async () => {
    const response = await POST(new NextRequest("http://localhost/api/runners/action", { method: "POST", body: "{}" }));
    expect(response.status).toBe(400);
  });

  it("rejects unauthenticated requests", async () => {
    requireSession.mockResolvedValue(null);

    const response = await POST(new NextRequest("http://localhost/api/runners/action", { method: "POST" }));

    expect(response.status).toBe(401);
    expect(getWorkflowRunStatus).not.toHaveBeenCalled();
  });

  it("rejects a malformed repository identifier", async () => {
    const response = await POST(new NextRequest("http://localhost/api/runners/action", {
      method: "POST",
      body: JSON.stringify({ repoFullName: "owner/repo/extra", workflowRunId: 123, action: "cancel" }),
    }));

    expect(response.status).toBe(400);
  });

  it("rejects deleting an active run", async () => {
    const response = await POST(new NextRequest("http://localhost/api/runners/action", {
      method: "POST",
      body: JSON.stringify({ repoFullName: "owner/repo", workflowRunId: 123, action: "delete" }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(409);
    expect(deleteWorkflowRun).not.toHaveBeenCalled();
  });
});
