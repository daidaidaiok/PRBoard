import type { CheckItem } from "./prs";

export const AUTO_RETRY_LIMIT = 2;
const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

export function isFailureConclusion(conclusion: string | null): boolean {
  return conclusion !== null && FAILURE_CONCLUSIONS.has(conclusion);
}

function isAutoRetryableConclusion(conclusion: string | null): boolean {
  return conclusion === "failure" || conclusion === "timed_out";
}

export function shouldAutoRetry(conclusion: string | null, runAttempt: number): boolean {
  return isAutoRetryableConclusion(conclusion) && runAttempt <= AUTO_RETRY_LIMIT;
}

/**
 * True once a conclusion this system *would* have auto-retried has used up
 * its retries. Deliberately narrower than `isFailureConclusion` — a
 * conclusion outside `shouldAutoRetry`'s scope (e.g. "cancelled") was never
 * eligible for auto-retry in the first place, so a high `runAttempt` on one
 * (from a manual re-run, say) doesn't mean *our* retries were exhausted.
 */
export function isRetryExhausted(conclusion: string | null, runAttempt: number): boolean {
  return isAutoRetryableConclusion(conclusion) && runAttempt > AUTO_RETRY_LIMIT;
}

export function getRerunnableWorkflowRunIds(checks: CheckItem[]): number[] {
  return [
    ...new Set(checks.flatMap((check) => (check.canRerun && check.workflowRunId !== null ? [check.workflowRunId] : []))),
  ];
}

export async function rerunWorkflowRuns(
  workflowRunIds: number[],
  rerun: (workflowRunId: number) => Promise<void>,
): Promise<{ succeeded: number; failed: number }> {
  const results = await Promise.allSettled(workflowRunIds.map(rerun));
  const succeeded = results.filter((result) => result.status === "fulfilled").length;
  return { succeeded, failed: results.length - succeeded };
}
