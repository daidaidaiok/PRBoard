import { beforeEach, describe, expect, it, vi } from "vitest";

const { getInstallationOctokit, getUserByGithubId, logAudit, reRunWorkflowFailedJobs, cancelWorkflowRun, forceCancelWorkflowRun, deleteWorkflowRun } = vi.hoisted(() => ({
  getInstallationOctokit: vi.fn(),
  getUserByGithubId: vi.fn(),
  logAudit: vi.fn(),
  reRunWorkflowFailedJobs: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  forceCancelWorkflowRun: vi.fn(),
  deleteWorkflowRun: vi.fn(),
}));

vi.mock("@/db/installations", () => ({ getInstallationIdForRepo: vi.fn(async () => 7) }));
vi.mock("@/db/audit", () => ({ logAudit }));
vi.mock("@/db/users", () => ({ getUserByGithubId }));
vi.mock("./app", () => ({ getInstallationOctokit }));

import { rerunFailedJobs, cancelWorkflowRun as cancelRun, forceCancelWorkflowRun as forceCancelRun, deleteWorkflowRun as deleteRun } from "./actions";

describe("rerunFailedJobs", () => {
  beforeEach(() => {
    getInstallationOctokit.mockResolvedValue({ rest: { actions: { reRunWorkflowFailedJobs } } });
    getUserByGithubId.mockResolvedValue({ id: 5 });
    reRunWorkflowFailedJobs.mockResolvedValue({ data: {} });
  });

  it("uses the Actions endpoint and audits a manual retry", async () => {
    await rerunFailedJobs({
      githubUserId: 42,
      repoFullName: "owner/repo",
      workflowRunId: 123,
      trigger: "manual",
    });

    expect(reRunWorkflowFailedJobs).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 123 });
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 5,
        action: "rerun_failed_jobs",
        result: "success",
        targetId: "123",
        detail: { trigger: "manual" },
      }),
    );
  });

  it("records an automatic retry without looking up a user", async () => {
    await rerunFailedJobs({
      githubUserId: null,
      repoFullName: "owner/repo",
      workflowRunId: 123,
      trigger: "automatic",
      runAttempt: 2,
    });

    expect(getUserByGithubId).not.toHaveBeenCalled();
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, detail: { trigger: "automatic", runAttempt: 2 } }),
    );
  });

  it("cancels, force-cancels, and deletes runs through Actions endpoints", async () => {
    getInstallationOctokit.mockResolvedValue({
      rest: { actions: {
        reRunWorkflowFailedJobs,
        cancelWorkflowRun,
        forceCancelWorkflowRun,
        deleteWorkflowRun,
      } },
    });
    await cancelRun({ githubUserId: 42, repoFullName: "owner/repo", workflowRunId: 1 });
    await forceCancelRun({ githubUserId: 42, repoFullName: "owner/repo", workflowRunId: 2 });
    await deleteRun({ githubUserId: 42, repoFullName: "owner/repo", workflowRunId: 3 });
    expect(cancelWorkflowRun).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 1 });
    expect(forceCancelWorkflowRun).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 2 });
    expect(deleteWorkflowRun).toHaveBeenCalledWith({ owner: "owner", repo: "repo", run_id: 3 });
  });
});
