import { getInstallationOctokit } from "./app";
import { listWatchedRepos, getInstallationIdForRepo } from "@/db/installations";

export const STUCK_AFTER_MINUTES = 30;
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

export interface WorkflowRun {
  id: number;
  name: string | null;
  display_title: string;
  event: string;
  status: string;
  conclusion: string | null;
  workflow_id: number;
  run_number: number;
  run_attempt: number;
  created_at: string;
  updated_at: string;
  run_started_at: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  actor: { login: string; avatar_url: string | null } | null;
}

export interface WorkflowRunSummary {
  id: number;
  repoFullName: string;
  workflowName: string;
  displayTitle: string;
  event: string;
  status: string;
  conclusion: string | null;
  workflowId: number;
  runNumber: number;
  runAttempt: number;
  createdAt: string;
  updatedAt: string;
  runStartedAt: string | null;
  htmlUrl: string;
  headBranch: string | null;
  headSha: string;
  actor: { login: string; avatarUrl: string | null } | null;
  elapsedMinutes: number;
  stuck: boolean;
}

export interface WorkflowJobSummary {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  runnerName: string | null;
  labels: string[];
  htmlUrl: string;
}

export interface RunnerSummary {
  id: number;
  name: string;
  os: string;
  status: string;
  busy: boolean;
  labels: string[];
  repoFullName: string;
}

function runStart(run: WorkflowRun): number {
  return Date.parse(run.run_started_at ?? run.created_at);
}

export function isStuckWorkflowRun(run: WorkflowRun, now = new Date()): boolean {
  if (!ACTIVE_STATUSES.has(run.status.toLowerCase())) return false;
  const started = runStart(run);
  if (!Number.isFinite(started)) return false;
  return now.getTime() - started >= STUCK_AFTER_MINUTES * 60_000;
}

export function normalizeWorkflowRun(run: WorkflowRun, repoFullName: string, now = new Date()): WorkflowRunSummary {
  const started = runStart(run);
  const elapsedMinutes = Number.isFinite(started) ? Math.max(0, Math.floor((now.getTime() - started) / 60_000)) : 0;
  return {
    id: run.id,
    repoFullName,
    workflowName: run.name ?? `Workflow #${run.workflow_id}`,
    displayTitle: run.display_title,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    workflowId: run.workflow_id,
    runNumber: run.run_number,
    runAttempt: run.run_attempt,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    runStartedAt: run.run_started_at,
    htmlUrl: run.html_url,
    headBranch: run.head_branch,
    headSha: run.head_sha,
    actor: run.actor ? { login: run.actor.login, avatarUrl: run.actor.avatar_url } : null,
    elapsedMinutes,
    stuck: isStuckWorkflowRun(run, now),
  };
}

export async function listWorkflowRuns(userId = 0, now = new Date()): Promise<WorkflowRunSummary[]> {
  const repos = await listWatchedRepos(userId);
  const byInstallation = new Map<number, typeof repos>();
  for (const repo of repos) {
    const list = byInstallation.get(repo.installationId) ?? [];
    list.push(repo);
    byInstallation.set(repo.installationId, list);
  }

  const all: WorkflowRunSummary[] = [];
  for (const [installationId, installationRepos] of byInstallation) {
    const octokit = await getInstallationOctokit(installationId);
    for (const repo of installationRepos) {
      const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
        owner: repo.owner,
        repo: repo.name,
        per_page: 50,
      });
      all.push(...(data.workflow_runs as WorkflowRun[]).map((run) => normalizeWorkflowRun(run, repo.fullName, now)));
    }
  }
  return all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

/** Fetches the current online/offline state of every watched self-hosted runner. */
export async function listSelfHostedRunners(userId: number): Promise<RunnerSummary[]> {
  const repos = await listWatchedRepos(userId);
  const byInstallation = new Map<number, typeof repos>();
  for (const repo of repos) {
    const list = byInstallation.get(repo.installationId) ?? [];
    list.push(repo);
    byInstallation.set(repo.installationId, list);
  }

  const all: RunnerSummary[] = [];
  for (const [installationId, installationRepos] of byInstallation) {
    const octokit = await getInstallationOctokit(installationId);
    for (const repo of installationRepos) {
      const rows = await octokit.paginate(octokit.rest.actions.listSelfHostedRunnersForRepo, {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
      });
      all.push(...rows.map((runner) => ({
        id: runner.id,
        name: runner.name,
        os: runner.os,
        status: runner.status,
        busy: runner.busy,
        labels: runner.labels.map((label) => label.name),
        repoFullName: repo.fullName,
      })));
    }
  }
  return all.sort((a, b) => a.repoFullName.localeCompare(b.repoFullName) || a.name.localeCompare(b.name));
}

export async function listWorkflowRunJobs(userId: number, repoFullName: string, workflowRunId: number): Promise<WorkflowJobSummary[]> {
  const installationId = await getInstallationIdForRepo(repoFullName, userId);
  if (installationId === null) throw new Error(`${repoFullName} is not a repo this app is watching`);
  const [owner, repo] = repoFullName.split("/");
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({ owner, repo, run_id: workflowRunId, per_page: 100 });
  return data.jobs.map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    runnerName: job.runner_name,
    labels: job.labels,
    htmlUrl: job.html_url ?? `https://github.com/${owner}/${repo}/actions/runs/${workflowRunId}`,
  }));
}

export async function getWorkflowRunStatus(userId: number, repoFullName: string, workflowRunId: number): Promise<string> {
  const installationId = await getInstallationIdForRepo(repoFullName, userId);
  if (installationId === null) throw new Error(`${repoFullName} is not a repo this app is watching`);
  const [owner, repo] = repoFullName.split("/");
  const octokit = await getInstallationOctokit(installationId);
  const { data } = await octokit.rest.actions.getWorkflowRun({ owner, repo, run_id: workflowRunId });
  return String(data.status);
}
