import { describe, expect, it, vi } from "vitest";
import { handleWorkflowRunCompleted, type WorkflowRunCompleted } from "./workflow-retry";

function event(overrides: Partial<WorkflowRunCompleted> = {}): WorkflowRunCompleted {
  return {
    repoFullName: "owner/repo",
    workflowRunId: 123,
    runAttempt: 1,
    conclusion: "failure",
    hasPullRequest: true,
    ...overrides,
  };
}

function dependencies() {
  return {
    claim: vi.fn(async () => 9 as number | null),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    rerun: vi.fn(async () => undefined),
  };
}

describe("handleWorkflowRunCompleted", () => {
  it("automatically reruns an eligible first failure and completes its claim", async () => {
    const deps = dependencies();

    await expect(handleWorkflowRunCompleted(event(), deps)).resolves.toBe("retried");
    expect(deps.rerun).toHaveBeenCalledWith(event());
    expect(deps.complete).toHaveBeenCalledWith(9);
  });

  it("stops after the second automatic retry", async () => {
    const deps = dependencies();

    await expect(handleWorkflowRunCompleted(event({ runAttempt: 3 }), deps)).resolves.toBe("not-eligible");
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.rerun).not.toHaveBeenCalled();
  });

  it("does not automatically rerun a workflow unrelated to a pull request", async () => {
    const deps = dependencies();

    await expect(handleWorkflowRunCompleted(event({ hasPullRequest: false }), deps)).resolves.toBe("not-eligible");
    expect(deps.claim).not.toHaveBeenCalled();
    expect(deps.rerun).not.toHaveBeenCalled();
  });

  it("does not rerun a duplicate webhook delivery", async () => {
    const deps = dependencies();
    deps.claim.mockResolvedValue(null);

    await expect(handleWorkflowRunCompleted(event(), deps)).resolves.toBe("duplicate");
    expect(deps.rerun).not.toHaveBeenCalled();
  });

  it("marks a failed request so a later delivery can retry", async () => {
    const deps = dependencies();
    const failure = new Error("GitHub unavailable");
    deps.rerun.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

    await expect(handleWorkflowRunCompleted(event(), deps)).rejects.toThrow("GitHub unavailable");
    expect(deps.fail).toHaveBeenCalledWith(9, failure);

    await expect(handleWorkflowRunCompleted(event(), deps)).resolves.toBe("retried");
    expect(deps.rerun).toHaveBeenCalledTimes(2);
  });

  it("does not release the claim when only completion persistence fails", async () => {
    const deps = dependencies();
    deps.complete.mockRejectedValue(new Error("database unavailable"));

    await expect(handleWorkflowRunCompleted(event(), deps)).rejects.toThrow("database unavailable");
    expect(deps.rerun).toHaveBeenCalledOnce();
    expect(deps.fail).not.toHaveBeenCalled();
  });
});
