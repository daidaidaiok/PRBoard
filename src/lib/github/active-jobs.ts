import { getActiveHostSnapshots } from "@/db/host-monitor";
import { listWorkflowRunJobs, listWorkflowRuns, type WorkflowJobSummary, type WorkflowRunSummary } from "./runners";

/**
 * Live view of every workflow job that is running or waiting for a runner,
 * joined with the enrolled host snapshot for its runner name — the data
 * behind the Runner monitor's 进行中/排队中 section ("which host is my job
 * on, and how loaded is that host right now").
 *
 * GitHub cost: one jobs call per *active* run only (typically 0–3), fetched
 * exclusively while the Runner monitor page is open — the PR board never
 * touches this endpoint, keeping its hot path untouched.
 */

const ACTIVE_RUN_STATUSES = new Set(["queued", "in_progress"]);
const ACTIVE_JOB_STATUSES = new Set(["queued", "in_progress"]);

export interface ActiveJobHost {
  displayName: string;
  platform: "macos" | "windows" | "linux";
  stale: boolean;
  cpuUsageBasisPoints: number;
  memoryUsedMib: number;
  memoryTotalMib: number;
  load1: number | null;
}

export interface ActiveJobItem {
  repoFullName: string;
  workflowRunId: number;
  workflowName: string;
  jobName: string;
  status: string;
  startedAt: string | null;
  htmlUrl: string;
  /** GitHub runner carrying the job — null while the job is still queued. */
  runnerName: string | null;
  /** Enrolled host context, null when the runner name has no host or is unassigned. */
  host: ActiveJobHost | null;
}

const STATUS_ORDER: Record<string, number> = { in_progress: 0, queued: 1 };

export async function listActiveJobs(userId: number, now = new Date()): Promise<ActiveJobItem[]> {
  const runs = (await listWorkflowRuns(userId)).filter((run) => ACTIVE_RUN_STATUSES.has(run.status.toLowerCase()));
  // listWorkflowRunJobs resolves its own installation per repo; one flaky
  // repo must not blank out the whole section, so failures degrade to "no
  // jobs from that run".
  const jobLists = await Promise.all(
    runs.map((run) => listWorkflowRunJobs(userId, run.repoFullName, run.id).catch(() => [] as WorkflowJobSummary[])),
  );

  const activeJobs: Array<{ run: Pick<WorkflowRunSummary, "repoFullName" | "workflowName" | "id">; job: WorkflowJobSummary }> = [];
  for (const [index, run] of runs.entries()) {
    for (const job of jobLists[index] ?? []) {
      if (ACTIVE_JOB_STATUSES.has(job.status.toLowerCase())) activeJobs.push({ run, job });
    }
  }

  const snapshots = await getActiveHostSnapshots(
    userId,
    activeJobs.map(({ job }) => job.runnerName),
    now,
  );

  return activeJobs
    .map(({ run, job }) => {
      const snapshot = job.runnerName ? snapshots.get(job.runnerName) : undefined;
      const metric = snapshot?.latestMetric;
      return {
        repoFullName: run.repoFullName,
        workflowRunId: run.id,
        workflowName: run.workflowName,
        jobName: job.name,
        status: job.status,
        startedAt: job.startedAt,
        htmlUrl: job.htmlUrl,
        runnerName: job.runnerName,
        host:
          snapshot && metric
            ? {
                displayName: snapshot.host.displayName,
                platform: snapshot.host.platform,
                stale: snapshot.stale,
                cpuUsageBasisPoints: metric.cpuUsageBasisPoints,
                memoryUsedMib: metric.memoryUsedMib,
                memoryTotalMib: metric.memoryTotalMib,
                load1: metric.load1,
              }
            : null,
      };
    })
    .sort((left, right) => (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9));
}
