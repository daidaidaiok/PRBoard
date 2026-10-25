import { describe, expect, it } from "vitest";
import { groupActiveJobsByHost } from "./active-jobs-view";
import type { ActiveJobItem } from "./active-jobs";

function jobFixture(overrides: Partial<ActiveJobItem> = {}): ActiveJobItem {
  return {
    repoFullName: "owner/other-repo",
    workflowRunId: 101,
    workflowName: "CI",
    jobName: "build",
    status: "in_progress",
    startedAt: "2026-10-03T11:50:00.000Z",
    htmlUrl: "https://github.com/owner/other-repo/actions/runs/101/job/9001",
    runnerName: "windows-runner",
    host: { displayName: "Windows 工作站", platform: "windows", stale: false, cpuUsageBasisPoints: 2_600, memoryUsedMib: 12_000, memoryTotalMib: 32_768, load1: 3.2 },
    ...overrides,
  };
}

describe("groupActiveJobsByHost", () => {
  it("merges jobs sharing a runner into one group carrying the host snapshot", () => {
    const groups = groupActiveJobsByHost([
      jobFixture({ jobName: "build" }),
      jobFixture({ jobName: "lint", host: null }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].runnerName).toBe("windows-runner");
    expect(groups[0].host?.displayName).toBe("Windows 工作站");
    expect(groups[0].jobs.map((job) => job.jobName)).toEqual(["build", "lint"]);
  });

  it("puts unassigned queued jobs into a trailing waiting bucket", () => {
    const groups = groupActiveJobsByHost([
      jobFixture({ runnerName: "windows-runner" }),
      jobFixture({ runnerName: null, host: null, status: "queued", startedAt: null, jobName: "wsl-test" }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ runnerName: null, host: null, key: "__queued__" });
    expect(groups[1].jobs).toHaveLength(1);
    expect(groups[1].jobs[0].jobName).toBe("wsl-test");
  });

  it("keeps separate groups per runner and preserves first-seen order", () => {
    const groups = groupActiveJobsByHost([
      jobFixture({ runnerName: "wsl-runner", host: { displayName: "WSL", platform: "linux", stale: false, cpuUsageBasisPoints: 0, memoryUsedMib: 0, memoryTotalMib: 0, load1: null } }),
      jobFixture({ runnerName: "windows-runner" }),
      jobFixture({ runnerName: "wsl-runner", jobName: "second", host: null }),
    ]);

    expect(groups.map((group) => group.runnerName)).toEqual(["wsl-runner", "windows-runner"]);
    expect(groups[0].jobs).toHaveLength(2);
  });

  it("returns no groups for an empty list", () => {
    expect(groupActiveJobsByHost([])).toEqual([]);
  });
});
