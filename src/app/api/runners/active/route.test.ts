import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireSession, listActiveJobs } = vi.hoisted(() => ({
  requireSession: vi.fn(),
  listActiveJobs: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/lib/github/active-jobs", () => ({ listActiveJobs }));

import { GET } from "./route";

const activeJob = {
  repoFullName: "owner/other-repo",
  workflowRunId: 101,
  workflowName: "CI",
  jobName: "build",
  status: "in_progress",
  startedAt: "2026-10-03T11:50:00.000Z",
  htmlUrl: "https://github.com/owner/other-repo/actions/runs/101/job/9001",
  runnerName: "windows-runner",
  host: { displayName: "Windows 工作站", platform: "windows", stale: false, cpuUsageBasisPoints: 2_600, memoryUsedMib: 12_000, memoryTotalMib: 32_768, load1: 3.2 },
};

describe("GET /api/runners/active", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 42 } });
    listActiveJobs.mockResolvedValue([activeJob]);
  });

  it("rejects an unauthenticated request", async () => {
    requireSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(listActiveJobs).not.toHaveBeenCalled();
  });

  it("returns active jobs joined with host snapshots", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const data = (await response.json()) as { jobs: unknown[]; checkedAt: string };
    expect(data.jobs).toEqual([activeJob]);
    expect(Number.isNaN(Date.parse(data.checkedAt))).toBe(false);
    expect(listActiveJobs).toHaveBeenCalledWith(42);
  });

  it("degrades to a 502 when the aggregate fails", async () => {
    listActiveJobs.mockRejectedValue(new Error("boom"));

    const response = await GET();

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "active jobs unavailable" });
  });
});
