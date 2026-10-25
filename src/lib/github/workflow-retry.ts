export interface WorkflowRunCompleted {
  repoFullName: string;
  workflowRunId: number;
  runAttempt: number;
  conclusion: string | null;
  hasPullRequest: boolean;
}

interface RetryDependencies {
  claim: (event: WorkflowRunCompleted) => Promise<number | null>;
  complete: (claimId: number) => Promise<void>;
  fail: (claimId: number, error: unknown) => Promise<void>;
  rerun: (event: WorkflowRunCompleted) => Promise<unknown>;
}

const defaultDependencies: RetryDependencies = {
  claim: async (event) => (await import("@/db/workflow-retries")).claimAutoRetry(event),
  complete: async (claimId) => (await import("@/db/workflow-retries")).completeAutoRetryClaim(claimId),
  fail: async (claimId, error) => (await import("@/db/workflow-retries")).failAutoRetryClaim(claimId, error),
  rerun: async (event) =>
    (await import("./actions")).rerunFailedJobs({
      githubUserId: null,
      repoFullName: event.repoFullName,
      workflowRunId: event.workflowRunId,
      trigger: "automatic",
      runAttempt: event.runAttempt,
    }),
};

export async function handleWorkflowRunCompleted(
  event: WorkflowRunCompleted,
  dependencies: RetryDependencies = defaultDependencies,
): Promise<"retried" | "not-eligible" | "duplicate"> {
  if (!event.hasPullRequest || !shouldAutoRetry(event.conclusion, event.runAttempt)) return "not-eligible";

  const claimId = await dependencies.claim(event);
  if (claimId === null) return "duplicate";

  try {
    await dependencies.rerun(event);
  } catch (error) {
    await dependencies.fail(claimId, error);
    throw error;
  }

  await dependencies.complete(claimId);
  return "retried";
}
import { shouldAutoRetry } from "./retry-policy";
