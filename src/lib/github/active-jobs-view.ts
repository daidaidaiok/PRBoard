import type { ActiveJobHost, ActiveJobItem } from "./active-jobs";

/**
 * One render group for the Runner monitor's 进行中/排队中 section: either a
 * runner (with its host snapshot) or the shared "waiting for a free runner"
 * bucket that queued-but-unassigned jobs land in. Groups keep first-seen
 * order so the section stays stable between refreshes.
 */
export interface ActiveJobsGroup {
  /** Runner name, or "__queued__" for the shared waiting bucket. */
  key: string;
  runnerName: string | null;
  host: ActiveJobHost | null;
  jobs: ActiveJobItem[];
}

const QUEUED_BUCKET_KEY = "__queued__";

export function groupActiveJobsByHost(jobs: ActiveJobItem[]): ActiveJobsGroup[] {
  const groups = new Map<string, ActiveJobsGroup>();
  for (const job of jobs) {
    const key = job.runnerName ?? QUEUED_BUCKET_KEY;
    const group = groups.get(key);
    if (group) {
      group.jobs.push(job);
      continue;
    }
    groups.set(key, { key, runnerName: job.runnerName, host: job.host, jobs: [job] });
  }
  // The waiting bucket renders last regardless of where its jobs appeared.
  return [...groups.values()].sort((left, right) => Number(left.key === QUEUED_BUCKET_KEY) - Number(right.key === QUEUED_BUCKET_KEY));
}
