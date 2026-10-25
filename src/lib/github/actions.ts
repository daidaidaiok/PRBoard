import { getInstallationIdForRepo } from "@/db/installations";
import { logAudit } from "@/db/audit";
import { getUserByGithubId } from "@/db/users";
import { getInstallationOctokit } from "./app";

export class ActionDeniedError extends Error {}

async function resolveInstallation(repoFullName: string, userId: number | null) {
  const installationId = await getInstallationIdForRepo(repoFullName, userId ?? undefined);
  if (installationId === null) {
    throw new ActionDeniedError(`${repoFullName} is not a repo this app is watching`);
  }
  return installationId;
}

/**
 * Every high-privilege action follows the same shape: resolve the repo to
 * an installation (denying anything outside what the App was actually
 * installed on), run the GitHub call, and log the outcome — success,
 * failure, or denial — before returning. Nothing here trusts the caller's
 * claimed installationId; it's always re-derived from the db.
 */
async function withAudit<T>(
  params: {
    githubUserId: number | null;
    action:
      | "merge_pr"
      | "rerun_check_run"
      | "rerun_workflow"
      | "rerun_failed_jobs"
      | "cancel_workflow"
      | "force_cancel_workflow"
      | "delete_workflow_run";
    repoFullName: string;
    prNumber?: number;
    targetId?: string;
    detail?: Record<string, unknown>;
  },
  fn: (installationId: number) => Promise<T>,
): Promise<T> {
  const user = params.githubUserId === null ? null : await getUserByGithubId(params.githubUserId);
  const userId = user?.id ?? null;

  let installationId: number;
  try {
    installationId = await resolveInstallation(params.repoFullName, user?.id ?? null);
  } catch (err) {
    await logAudit({
      userId,
      action: params.action,
      result: "denied",
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      targetId: params.targetId,
      detail: { ...params.detail, message: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }

  try {
    const result = await fn(installationId);
    await logAudit({
      userId,
      action: params.action,
      result: "success",
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      targetId: params.targetId,
      detail: params.detail,
    });
    return result;
  } catch (err) {
    await logAudit({
      userId,
      action: params.action,
      result: "failure",
      repoFullName: params.repoFullName,
      prNumber: params.prNumber,
      targetId: params.targetId,
      detail: { ...params.detail, message: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}

export async function mergePullRequest(params: { githubUserId: number; repoFullName: string; prNumber: number }) {
  const [owner, repo] = params.repoFullName.split("/");
  return withAudit(
    { githubUserId: params.githubUserId, action: "merge_pr", repoFullName: params.repoFullName, prNumber: params.prNumber },
    async (installationId) => {
      const octokit = await getInstallationOctokit(installationId);
      const { data } = await octokit.rest.pulls.merge({ owner, repo, pull_number: params.prNumber });
      return data;
    },
  );
}

export async function rerunFailedJobs(params: {
  githubUserId: number | null;
  repoFullName: string;
  workflowRunId: number;
  trigger: "manual" | "automatic";
  runAttempt?: number;
}) {
  const [owner, repo] = params.repoFullName.split("/");
  return withAudit(
    {
      githubUserId: params.githubUserId,
      action: "rerun_failed_jobs",
      repoFullName: params.repoFullName,
      targetId: String(params.workflowRunId),
      detail: { trigger: params.trigger, ...(params.runAttempt === undefined ? {} : { runAttempt: params.runAttempt }) },
    },
    async (installationId) => {
      const octokit = await getInstallationOctokit(installationId);
      const { data } = await octokit.rest.actions.reRunWorkflowFailedJobs({
        owner,
        repo,
        run_id: params.workflowRunId,
      });
      return data;
    },
  );
}

async function runAction(params: {
  githubUserId: number;
  repoFullName: string;
  workflowRunId: number;
  action: "cancel_workflow" | "force_cancel_workflow" | "delete_workflow_run";
  call: (octokit: Awaited<ReturnType<typeof getInstallationOctokit>>, owner: string, repo: string, runId: number) => Promise<unknown>;
}) {
  const [owner, repo] = params.repoFullName.split("/");
  return withAudit(
    {
      githubUserId: params.githubUserId,
      action: params.action,
      repoFullName: params.repoFullName,
      targetId: String(params.workflowRunId),
    },
    async (installationId) => {
      const octokit = await getInstallationOctokit(installationId);
      return params.call(octokit, owner, repo, params.workflowRunId);
    },
  );
}

export function cancelWorkflowRun(params: { githubUserId: number; repoFullName: string; workflowRunId: number }) {
  return runAction({
    ...params,
    action: "cancel_workflow",
    call: (octokit, owner, repo, runId) => octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: runId }),
  });
}

export function forceCancelWorkflowRun(params: { githubUserId: number; repoFullName: string; workflowRunId: number }) {
  return runAction({
    ...params,
    action: "force_cancel_workflow",
    call: (octokit, owner, repo, runId) => octokit.rest.actions.forceCancelWorkflowRun({ owner, repo, run_id: runId }),
  });
}

export function deleteWorkflowRun(params: { githubUserId: number; repoFullName: string; workflowRunId: number }) {
  return runAction({
    ...params,
    action: "delete_workflow_run",
    call: (octokit, owner, repo, runId) => octokit.rest.actions.deleteWorkflowRun({ owner, repo, run_id: runId }),
  });
}
