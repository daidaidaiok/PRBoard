import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInstallationOctokit, listWatchedRepos } = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  listWatchedRepos: vi.fn(),
}));
vi.mock("@/db/installations", () => ({ listWatchedRepos, getInstallationIdForRepo: vi.fn() }));
vi.mock("./app", () => ({ getInstallationOctokit }));
import { isStuckWorkflowRun, listSelfHostedRunners, normalizeWorkflowRun, type WorkflowRun } from "./runners";

const baseRun: WorkflowRun = {
  id: 123,
  name: "CI",
  display_title: "CI",
  event: "push",
  status: "in_progress",
  conclusion: null,
  workflow_id: 7,
  run_number: 4,
  run_attempt: 1,
  created_at: "2026-08-30T10:00:00Z",
  updated_at: "2026-08-30T10:20:00Z",
  run_started_at: "2026-08-30T10:01:00Z",
  html_url: "https://github.com/owner/repo/actions/runs/123",
  head_branch: "main",
  head_sha: "abc",
  actor: { login: "octocat", avatar_url: "https://github.com/octocat.png" },
};

describe("workflow runner helpers", () => {
  it("normalizes a workflow run and computes elapsed minutes", () => {
    const normalized = normalizeWorkflowRun(baseRun, "owner/repo", new Date("2026-08-30T10:40:00Z"));
    expect(normalized).toMatchObject({
      id: 123,
      repoFullName: "owner/repo",
      workflowName: "CI",
      status: "in_progress",
      elapsedMinutes: 39,
      stuck: true,
    });
  });

  it("falls back to created_at when run_started_at is missing", () => {
    expect(isStuckWorkflowRun({ ...baseRun, run_started_at: null }, new Date("2026-08-30T10:31:00Z"))).toBe(true);
  });

  it("does not mark completed runs as stuck", () => {
    expect(isStuckWorkflowRun({ ...baseRun, status: "completed", conclusion: "success" }, new Date("2026-08-30T12:00:00Z"))).toBe(false);
  });
});

describe("listSelfHostedRunners", () => {
  beforeEach(() => {
    listWatchedRepos.mockResolvedValue([{ installationId: 7, owner: "owner", name: "repo", fullName: "owner/repo" }]);
    const paginate = vi.fn().mockResolvedValue([
      { id: 2, name: "mac-runner", os: "macOS", status: "online", busy: false, labels: [{ name: "self-hosted" }] },
      { id: 3, name: "linux-runner", os: "Linux", status: "offline", busy: false, labels: [{ name: "linux" }] },
    ]);
    getInstallationOctokit.mockResolvedValue({ paginate, rest: { actions: { listSelfHostedRunnersForRepo: vi.fn() } } });
  });

  it("returns online/offline state for watched repositories", async () => {
    await expect(listSelfHostedRunners(42)).resolves.toEqual([
      expect.objectContaining({ id: 3, name: "linux-runner", status: "offline", repoFullName: "owner/repo" }),
      expect.objectContaining({ id: 2, name: "mac-runner", status: "online", repoFullName: "owner/repo" }),
    ]);
    expect(listWatchedRepos).toHaveBeenCalledWith(42);
    expect(getInstallationOctokit).toHaveBeenCalledTimes(1);
  });
});
