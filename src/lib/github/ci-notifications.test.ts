import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPullRequestCiStatus, sendBarkNotification, claimNotification, clearNotification, listNotifiableUsers } =
  vi.hoisted(() => ({
    getPullRequestCiStatus: vi.fn(),
    sendBarkNotification: vi.fn(),
    claimNotification: vi.fn(),
    clearNotification: vi.fn(),
    listNotifiableUsers: vi.fn(),
  }));

vi.mock("./prs", () => ({ getPullRequestCiStatus }));
vi.mock("@/lib/bark", () => ({ sendBarkNotification }));
vi.mock("@/db/notification-dedup", () => ({ claimNotification, clearNotification }));
vi.mock("@/db/notification-settings", () => ({ listNotifiableUsers }));

import { notifyDeployFailed, notifyIfConflicting, notifyWorkflowRunOutcome, resolveMergeableStatus } from "./ci-notifications";

function workflowEvent(overrides: Partial<Parameters<typeof notifyWorkflowRunOutcome>[0]> = {}) {
  return {
    installationId: 7,
    owner: "owner",
    repo: "repo",
    workflowRunId: 555,
    workflowName: "PR Check",
    runAttempt: 1,
    conclusion: "success",
    headSha: "abc123",
    htmlUrl: "https://github.com/owner/repo/actions/runs/1",
    pullRequestNumbers: [12],
    ...overrides,
  };
}

describe("notifyWorkflowRunOutcome", () => {
  beforeEach(() => {
    sendBarkNotification.mockResolvedValue({ ok: true });
    claimNotification.mockResolvedValue(true);
    clearNotification.mockResolvedValue(undefined);
    listNotifiableUsers.mockResolvedValue([{ userId: 7, barkUrl: "https://bark.example.com/key7" }]);
  });

  it("does nothing when the workflow run has no associated pull request", async () => {
    await notifyWorkflowRunOutcome(workflowEvent({ pullRequestNumbers: [] }));

    expect(getPullRequestCiStatus).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("is a no-op when installationId is null (nobody to resolve recipients from)", async () => {
    await notifyWorkflowRunOutcome(workflowEvent({ installationId: null, conclusion: "failure", runAttempt: 3 }));

    expect(listNotifiableUsers).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("pushes an exhausted-retry notification once run_attempt passes the auto-retry limit", async () => {
    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_retry_exhausted", "7:555:3");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ title: "CI 重试后仍失败", level: "timeSensitive" }),
    );
    expect(getPullRequestCiStatus).not.toHaveBeenCalled();
  });

  it("pushes an exhausted-retry notification per recipient with a user-scoped dedup key", async () => {
    listNotifiableUsers.mockResolvedValue([
      { userId: 7, barkUrl: "https://bark.example.com/key7" },
      { userId: 9, barkUrl: "https://bark.example.com/key9" },
    ]);

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

    expect(listNotifiableUsers).toHaveBeenCalledWith(7, "ci_retry_exhausted");
    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_retry_exhausted", "7:555:3");
    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_retry_exhausted", "9:555:3");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ title: "CI 重试后仍失败" }),
    );
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key9",
      expect.objectContaining({ title: "CI 重试后仍失败" }),
    );
  });

  it("does not push a duplicate exhausted-retry notification for an already-claimed attempt", async () => {
    claimNotification.mockResolvedValue(false);

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("one recipient's push failure does not block the others", async () => {
    listNotifiableUsers.mockResolvedValue([
      { userId: 7, barkUrl: "https://bark.example.com/key7" },
      { userId: 9, barkUrl: "https://bark.example.com/key9" },
    ]);
    sendBarkNotification.mockImplementation(async (barkUrl: string) => {
      if (barkUrl.includes("key7")) throw new Error("offline");
      return { ok: true };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 3 }));

    expect(sendBarkNotification).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it("does not push an exhausted-retry notification while auto-retry is still eligible", async () => {
    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "failure", runAttempt: 1 }));

    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("does not push an exhausted-retry notification for a conclusion auto-retry never covers", async () => {
    // "cancelled" is outside shouldAutoRetry's scope, so a high run_attempt
    // here (e.g. from a manual re-run) isn't *our* retries running out.
    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "cancelled", runAttempt: 3 }));

    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("pushes an all-green notification when the PR's overall rollup is success", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "MERGEABLE",
      rollupState: "success",
    });

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "success", runAttempt: 1 }));

    expect(getPullRequestCiStatus).toHaveBeenCalledWith(7, "owner", "repo", 12);
    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "ci_green", "7:12:abc123");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ title: "CI 全绿", url: "https://github.com/owner/repo/pull/12" }),
    );
  });

  it("does not push a duplicate all-green notification for a commit already notified", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "MERGEABLE",
      rollupState: "success",
    });
    claimNotification.mockResolvedValue(false);

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "success", runAttempt: 1 }));

    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("does not push an all-green notification while other workflows are still pending", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "MERGEABLE",
      rollupState: "pending",
    });

    await notifyWorkflowRunOutcome(workflowEvent({ conclusion: "success", runAttempt: 1 }));

    expect(claimNotification).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("swallows a lookup failure instead of throwing", async () => {
    getPullRequestCiStatus.mockRejectedValue(new Error("GitHub unavailable"));

    await expect(notifyWorkflowRunOutcome(workflowEvent())).resolves.toBeUndefined();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });
});

describe("resolveMergeableStatus", () => {
  it("returns immediately when mergeable resolves on the first fetch", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "CONFLICTING",
      rollupState: null,
    });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await resolveMergeableStatus(7, "owner", "repo", 12, sleep);

    expect(status?.mergeable).toBe("CONFLICTING");
    expect(getPullRequestCiStatus).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries with backoff while mergeable reads unknown, then returns the resolved value", async () => {
    getPullRequestCiStatus
      .mockResolvedValueOnce({ title: "t", url: "u", mergeable: "UNKNOWN", rollupState: null })
      .mockResolvedValueOnce({ title: "t", url: "u", mergeable: "UNKNOWN", rollupState: null })
      .mockResolvedValueOnce({ title: "t", url: "u", mergeable: "CONFLICTING", rollupState: null });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await resolveMergeableStatus(7, "owner", "repo", 12, sleep);

    expect(status?.mergeable).toBe("CONFLICTING");
    expect(getPullRequestCiStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 2000);
    expect(sleep).toHaveBeenNthCalledWith(2, 4000);
  });

  it("gives up and returns the last unknown reading after exhausting retries", async () => {
    getPullRequestCiStatus.mockResolvedValue({ title: "t", url: "u", mergeable: "UNKNOWN", rollupState: null });
    const sleep = vi.fn().mockResolvedValue(undefined);

    const status = await resolveMergeableStatus(7, "owner", "repo", 12, sleep);

    expect(status?.mergeable).toBe("UNKNOWN");
    expect(getPullRequestCiStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("notifyIfConflicting", () => {
  beforeEach(() => {
    sendBarkNotification.mockResolvedValue({ ok: true });
    claimNotification.mockResolvedValue(true);
    clearNotification.mockResolvedValue(undefined);
    listNotifiableUsers.mockResolvedValue([{ userId: 7, barkUrl: "https://bark.example.com/key7" }]);
  });

  it("pushes a conflict notification when the PR is conflicting", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "CONFLICTING",
      rollupState: null,
    });

    await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ title: "PR 存在冲突" }),
    );
  });

  it("pushes conflict notifications per recipient with user-scoped claims", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "CONFLICTING",
      rollupState: "failure",
    });

    await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ title: "PR 存在冲突" }),
    );
  });

  it("does not push a duplicate conflict notification while still unresolved", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "CONFLICTING",
      rollupState: null,
    });
    claimNotification.mockResolvedValue(false);

    await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("clears the conflict claim once the PR is mergeable again, without pushing", async () => {
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "MERGEABLE",
      rollupState: "success",
    });

    await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

    expect(clearNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("clears per-user conflict claims when the PR becomes mergeable", async () => {
    getPullRequestCiStatus.mockResolvedValue({ title: "t", url: "u", mergeable: "MERGEABLE", rollupState: "success" });

    await notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });

    expect(clearNotification).toHaveBeenCalledWith("owner/repo", "pr_conflict", "7:12");
  });

  it("does nothing (no claim, no clear) while mergeability is still unknown", async () => {
    // notifyIfConflicting retries with a real setTimeout-based backoff
    // (resolveMergeableStatus's default `sleep`) before giving up — fake the
    // clock so this test doesn't actually wait out the ~6s of delays.
    vi.useFakeTimers();
    getPullRequestCiStatus.mockResolvedValue({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "UNKNOWN",
      rollupState: null,
    });

    const result = notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 });
    await vi.advanceTimersByTimeAsync(2000 + 4000);
    await result;
    vi.useRealTimers();

    expect(claimNotification).not.toHaveBeenCalled();
    expect(clearNotification).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("skips the lookup entirely when there is no installation", async () => {
    await notifyIfConflicting({ installationId: null, owner: "owner", repo: "repo", number: 12 });

    expect(getPullRequestCiStatus).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("swallows a lookup failure instead of throwing", async () => {
    getPullRequestCiStatus.mockRejectedValue(new Error("GitHub unavailable"));

    await expect(
      notifyIfConflicting({ installationId: 7, owner: "owner", repo: "repo", number: 12 }),
    ).resolves.toBeUndefined();
  });
});

function deployEvent(overrides: Partial<Parameters<typeof notifyDeployFailed>[0]> = {}) {
  return {
    installationId: 7,
    repoFullName: "owner/repo",
    checkRunId: 42,
    checkName: "Vercel",
    conclusion: "failure",
    appSlug: "vercel",
    headSha: "abc1234",
    detailsUrl: "https://vercel.com/deploy/1",
    ...overrides,
  };
}

describe("notifyDeployFailed", () => {
  beforeEach(() => {
    sendBarkNotification.mockResolvedValue({ ok: true });
    claimNotification.mockResolvedValue(true);
  });

  it("pushes per recipient when a vercel deploy check fails", async () => {
    await notifyDeployFailed(deployEvent());

    expect(listNotifiableUsers).toHaveBeenCalledWith(7, "deploy_failed");
    expect(claimNotification).toHaveBeenCalledWith("owner/repo", "deploy_failed", "7:42");
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({
        title: "Vercel 部署失败 (failure)",
        level: "timeSensitive",
        url: "https://vercel.com/deploy/1",
      }),
    );
  });

  it("ignores non-vercel check apps", async () => {
    await notifyDeployFailed(deployEvent({ appSlug: "github-actions" }));
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("ignores successful or neutral conclusions", async () => {
    for (const conclusion of ["success", "neutral", "skipped", null]) {
      await notifyDeployFailed(deployEvent({ conclusion }));
    }
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("falls back to the commit URL when details_url is absent", async () => {
    await notifyDeployFailed(deployEvent({ detailsUrl: null }));
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://bark.example.com/key7",
      expect.objectContaining({ url: "https://github.com/owner/repo/commit/abc1234" }),
    );
  });

  it("does nothing without an installation context", async () => {
    await notifyDeployFailed(deployEvent({ installationId: null }));
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });
});
