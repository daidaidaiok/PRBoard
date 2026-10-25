import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { listWorkflowRunJobs, requireSession } = vi.hoisted(() => ({ listWorkflowRunJobs: vi.fn(), requireSession: vi.fn() }));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/lib/github/runners", () => ({ listWorkflowRunJobs }));

import { GET } from "./route";

describe("GET /api/runners/jobs", () => {
  beforeEach(() => requireSession.mockResolvedValue({ user: { githubId: 42 } }));

  it("rejects unauthenticated requests", async () => {
    requireSession.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/runners/jobs?repoFullName=owner/repo&workflowRunId=1"));

    expect(response.status).toBe(401);
    expect(listWorkflowRunJobs).not.toHaveBeenCalled();
  });

  it("does not expose workflow jobs outside an installed repository", async () => {
    listWorkflowRunJobs.mockRejectedValue(new Error("owner/repo is not a repo this app is watching"));

    const response = await GET(new NextRequest("http://localhost/api/runners/jobs?repoFullName=owner/repo&workflowRunId=1"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "repository is not watched" });
  });
});
