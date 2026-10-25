import { describe, expect, it } from "vitest";
import {
  getRerunnableWorkflowRunIds,
  isFailureConclusion,
  isRetryExhausted,
  rerunWorkflowRuns,
  shouldAutoRetry,
} from "./retry-policy";
import { makeCheckItem as check } from "./test-helpers";

describe("automatic retry policy", () => {
  it.each([
    ["failure", 1, true],
    ["timed_out", 2, true],
    ["failure", 3, false],
    ["cancelled", 1, false],
    ["success", 1, false],
  ])("conclusion=%s attempt=%i => %s", (conclusion, attempt, expected) => {
    expect(shouldAutoRetry(conclusion, attempt)).toBe(expected);
  });
});

describe("isRetryExhausted", () => {
  it.each([
    ["failure", 3, true],
    ["timed_out", 4, true],
    ["failure", 2, false],
    // Never auto-retried in the first place — a high run_attempt here (e.g.
    // from a manual re-run) doesn't mean our own retries were exhausted.
    ["cancelled", 3, false],
    ["action_required", 3, false],
    ["success", 3, false],
  ])("conclusion=%s attempt=%i => %s", (conclusion, attempt, expected) => {
    expect(isRetryExhausted(conclusion, attempt)).toBe(expected);
  });
});

describe("manual retry selection", () => {
  it.each(["failure", "error", "timed_out", "cancelled", "action_required", "startup_failure"])(
    "treats %s as a failed conclusion",
    (conclusion) => expect(isFailureConclusion(conclusion)).toBe(true),
  );

  it("deduplicates jobs from the same workflow and excludes third-party checks", () => {
    expect(
      getRerunnableWorkflowRunIds([
        check({ id: "job-1", workflowRunId: 100 }),
        check({ id: "job-2", workflowRunId: 100 }),
        check({ id: "job-3", workflowRunId: 200 }),
        check({ id: "external", workflowRunId: null, runAttempt: null, canRerun: false }),
      ]),
    ).toEqual([100, 200]);
  });

  it("reports partial batch failures without discarding successful reruns", async () => {
    const rerun = async (workflowRunId: number) => {
      if (workflowRunId === 200) throw new Error("GitHub unavailable");
    };

    await expect(rerunWorkflowRuns([100, 200, 300], rerun)).resolves.toEqual({ succeeded: 2, failed: 1 });
  });
});
