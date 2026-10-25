import { beforeEach, describe, expect, it, vi } from "vitest";

const { listWorkflowRuns, listWorkflowRunJobs, getActiveHostSnapshots } = vi.hoisted(() => ({
  listWorkflowRuns: vi.fn(),
  listWorkflowRunJobs: vi.fn(),
  getActiveHostSnapshots: vi.fn(),
}));

vi.mock("@/lib/github/runners", () => ({ listWorkflowRuns, listWorkflowRunJobs }));
vi.mock("@/db/host-monitor", () => ({ getActiveHostSnapshots }));

import { listActiveJobs } from "./active-jobs";

const NOW = new Date("2026-10-03T12:00:00.000Z");

function runFixture(overrides: Partial<{ id: number; repoFullName: string; workflowName: string; status: string }> = {}) {
  return {
    id: 101,
    repoFullName: "owner/other-repo",
    workflowName: "CI",
    status: "in_progress",
    ...overrides,
  };
}

function jobFixture(overrides: Partial<{ id: number; name: string; status: string; runnerName: string | null; startedAt: string | null }> = {}) {
  return {
    id: 9001,
    name: "build",
    status: "in_progress",
    conclusion: null,
    startedAt: "2026-10-03T11:50:00.000Z",
    completedAt: null,
    runnerName: "windows-runner",
    labels: ["self-hosted"],
    htmlUrl: "https://github.com/owner/other-repo/actions/runs/101/job/9001",
    ...overrides,
  };
}

describe("listActiveJobs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps only queued/in_progress runs and jobs, mapping runner names onto host snapshots", async () => {
    listWorkflowRuns.mockResolvedValue([
      runFixture({ id: 101, status: "in_progress" }),
      runFixture({ id: 102, status: "queued" }),
      runFixture({ id: 103, status: "completed" }),
    ]);
    listWorkflowRunJobs.mockImplementation((_userId: number, _repo: string, runId: number) =>
      runId === 101
        ? Promise.resolve([jobFixture({ id: 9001, status: "in_progress" }), jobFixture({ id: 9002, status: "completed" })])
        : Promise.resolve([jobFixture({ id: 9003, status: "queued", runnerName: null, startedAt: null })]),
    );
    getActiveHostSnapshots.mockResolvedValue(
      new Map([["windows-runner", { host: { displayName: "Windows 工作站", platform: "windows" }, latestMetric: { cpuUsageBasisPoints: 2_600, memoryUsedMib: 12_000, memoryTotalMib: 32_768, load1: 3.2 }, stale: false }]]),
    );

    const jobs = await listActiveJobs(7, NOW);

    expect(jobs).toHaveLength(2);
    const running = jobs.find((job) => job.jobName === "build");
    expect(running).toMatchObject({
      repoFullName: "owner/other-repo",
      workflowRunId: 101,
      workflowName: "CI",
      status: "in_progress",
      runnerName: "windows-runner",
    });
    expect(running?.host).toMatchObject({ displayName: "Windows 工作站", cpuUsageBasisPoints: 2_600, load1: 3.2 });
    const queued = jobs.find((job) => job.jobName === "build" && job.status === "queued");
    expect(queued?.runnerName).toBeNull();
    expect(queued?.host).toBeNull();
    // The completed run never triggers a jobs fetch.
    expect(listWorkflowRunJobs).toHaveBeenCalledTimes(2);
  });

  it("renders jobs whose runner has no enrolled host with host = null", async () => {
    listWorkflowRuns.mockResolvedValue([runFixture({ id: 101 })]);
    listWorkflowRunJobs.mockResolvedValue([jobFixture({ runnerName: "unknown-runner" })]);
    getActiveHostSnapshots.mockResolvedValue(new Map());

    const jobs = await listActiveJobs(7, NOW);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].runnerName).toBe("unknown-runner");
    expect(jobs[0].host).toBeNull();
  });

  it("skips a repo whose jobs fetch fails instead of failing the whole list", async () => {
    listWorkflowRuns.mockResolvedValue([
      runFixture({ id: 101, repoFullName: "owner/other-repo" }),
      runFixture({ id: 202, repoFullName: "daidaidaiok/PRboard" }),
    ]);
    listWorkflowRunJobs.mockImplementation((_userId: number, repo: string) =>
      repo === "owner/other-repo" ? Promise.reject(new Error("secondary rate limit")) : Promise.resolve([jobFixture({ runnerName: null, status: "queued" })]),
    );
    getActiveHostSnapshots.mockResolvedValue(new Map());

    const jobs = await listActiveJobs(7, NOW);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].repoFullName).toBe("daidaidaiok/PRboard");
  });

  it("puts in_progress jobs before queued ones", async () => {
    listWorkflowRuns.mockResolvedValue([runFixture({ id: 101 })]);
    listWorkflowRunJobs.mockResolvedValue([
      jobFixture({ id: 9003, status: "queued", runnerName: null, startedAt: null }),
      jobFixture({ id: 9001, status: "in_progress" }),
    ]);
    getActiveHostSnapshots.mockResolvedValue(new Map());

    const jobs = await listActiveJobs(7, NOW);

    expect(jobs.map((job) => job.status)).toEqual(["in_progress", "queued"]);
  });
});
