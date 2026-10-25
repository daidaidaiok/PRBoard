import { getInstallationOctokit } from "./app";
import { listWatchedRepos } from "@/db/installations";
import { isFailureConclusion } from "./retry-policy";
import { getEstimatedDurations, type DurationEstimate } from "@/db/check-durations";

export interface CheckItem {
  id: string;
  name: string;
  status: "queued" | "in_progress" | "completed" | "pending" | "requested" | "waiting" | "expected" | "unknown";
  conclusion: string | null;
  detailsUrl: string | null;
  kind: "check_run" | "status";
  workflowRunId: number | null;
  runAttempt: number | null;
  canRerun: boolean;
  /** When this check started running — only known for check_run, not status. */
  startedAt: string | null;
  /** When this check finished — only known for a completed check_run, null otherwise. */
  completedAt: string | null;
  /**
   * Historical duration estimate (recency-weighted median) for a check of
   * this name in this repo, from `check_duration_samples` — including how
   * many samples back it (`n`) and their spread, so the UI can be honest
   * about uncertainty. Null until enriched, or if there's no history yet.
   */
  durationEstimate: DurationEstimate | null;
}

export interface PullRequestSummary {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  author: { login: string; avatarUrl: string } | null;
  repoFullName: string;
  installationId: number;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  reviewDecision: string | null;
  rollupState: string | null;
  checks: CheckItem[];
}

/**
 * Shared between `QUERY` (search, many PRs) and `PR_STATUS_QUERY` (a single
 * PR, used by webhook-driven notifications) so the two never drift out of
 * sync — both need the same shape to feed `toChecks`/`selectCurrentContexts`.
 */
const STATUS_CHECK_ROLLUP_CONTEXTS = `
  contexts(first: 100) {
    nodes {
      __typename
      ... on CheckRun {
        id
        name
        status
        conclusion
        detailsUrl
        startedAt
        completedAt
        checkSuite {
          workflowRun {
            databaseId
            runAttempt
            runNumber
            createdAt
            workflow { databaseId }
          }
        }
      }
      ... on StatusContext {
        id
        context
        state
        targetUrl
      }
    }
  }
`;

const QUERY = `
  query($searchQuery: String!) {
    search(query: $searchQuery, type: ISSUE, first: 50) {
      nodes {
        ... on PullRequest {
          id
          number
          title
          url
          isDraft
          createdAt
          updatedAt
          mergeable
          reviewDecision
          author { login avatarUrl }
          repository { nameWithOwner }
          headRefName
          baseRefName
          commits(last: 1) {
            nodes {
              commit {
                statusCheckRollup {
                  state
                  ${STATUS_CHECK_ROLLUP_CONTEXTS}
                }
              }
            }
          }
        }
      }
    }
  }
`;

interface CheckRunNode {
  __typename: "CheckRun";
  id: string;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
  checkSuite: {
    workflowRun: {
      databaseId: number | null;
      runAttempt: number;
      runNumber: number;
      createdAt: string;
      workflow: { databaseId: number | null };
    } | null;
  };
}
interface StatusContextNode {
  __typename: "StatusContext";
  id: string;
  context: string;
  state: string;
  targetUrl: string | null;
}
type ContextNode = CheckRunNode | StatusContextNode;

function normalizeCheckRunStatus(status: string): CheckItem["status"] {
  switch (status.toLowerCase()) {
    case "queued":
    case "in_progress":
    case "completed":
    case "pending":
    case "requested":
    case "waiting":
      return status.toLowerCase() as CheckItem["status"];
    default:
      return "unknown";
  }
}

interface SearchResponse {
  search: {
    nodes: Array<{
      id: string;
      number: number;
      title: string;
      url: string;
      isDraft: boolean;
      createdAt: string;
      updatedAt: string;
      mergeable: string;
      reviewDecision: string | null;
      author: { login: string; avatarUrl: string } | null;
      repository: { nameWithOwner: string };
      headRefName: string;
      baseRefName: string;
      commits: {
        nodes: Array<{
          commit: {
            statusCheckRollup: { state: string; contexts: { nodes: ContextNode[] } } | null;
          };
        }>;
      };
    }>;
  };
}

function toChecks(nodes: ContextNode[]): CheckItem[] {
  return nodes.map((c) => {
    if (c.__typename === "CheckRun") {
      return {
        id: c.id,
        name: c.name,
        status: normalizeCheckRunStatus(c.status ?? "unknown"),
        conclusion: c.conclusion ? c.conclusion.toLowerCase() : null,
        detailsUrl: c.detailsUrl,
        kind: "check_run",
        workflowRunId: c.checkSuite.workflowRun?.databaseId ?? null,
        runAttempt: c.checkSuite.workflowRun?.runAttempt ?? null,
        canRerun: c.checkSuite.workflowRun?.databaseId !== null && c.checkSuite.workflowRun?.databaseId !== undefined,
        startedAt: c.startedAt,
        completedAt: c.completedAt,
        durationEstimate: null,
      };
    }
    const state = c.state.toLowerCase();
    const isWaiting = state === "pending" || state === "expected";
    return {
      id: c.id,
      name: c.context,
      status: isWaiting ? (state as "pending" | "expected") : "completed",
      conclusion: isWaiting ? null : state,
      detailsUrl: c.targetUrl,
      kind: "status",
      workflowRunId: null,
      runAttempt: null,
      canRerun: false,
      startedAt: null,
      completedAt: null,
      durationEstimate: null,
    };
  });
}

/**
 * Re-running a check (a fresh push, or "re-run failed jobs") doesn't replace
 * its old check-run object — GitHub creates a new workflow run or attempt and
 * `statusCheckRollup.contexts` can return both. The current-run selection
 * below prevents an older cancelled run from affecting the PR's status.
 */
function compareRunVersion(
  a: NonNullable<CheckRunNode["checkSuite"]["workflowRun"]>,
  b: NonNullable<CheckRunNode["checkSuite"]["workflowRun"]>,
): number {
  return a.runNumber - b.runNumber || a.runAttempt - b.runAttempt || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

/**
 * A workflow can expose the old run's cancelled jobs together with the new
 * run's queued jobs. The new run may not have created every downstream job
 * yet, so filtering only by check name leaves stale failures behind. Select
 * the newest run per workflow first; contexts from different workflows with
 * the same job name must remain independent.
 */
function selectCurrentContexts(nodes: ContextNode[]): ContextNode[] {
  const latestByWorkflow = new Map<number, NonNullable<CheckRunNode["checkSuite"]["workflowRun"]>>();
  for (const node of nodes) {
    if (node.__typename !== "CheckRun") continue;
    const run = node.checkSuite.workflowRun;
    const workflowId = run?.workflow.databaseId;
    if (
      run &&
      workflowId !== null &&
      workflowId !== undefined &&
      (!latestByWorkflow.has(workflowId) || compareRunVersion(run, latestByWorkflow.get(workflowId)!) > 0)
    ) {
      latestByWorkflow.set(workflowId, run);
    }
  }

  return nodes.filter((node) => {
    if (node.__typename !== "CheckRun") return true;
    const run = node.checkSuite.workflowRun;
    if (!run || run.workflow.databaseId === null) return true;
    const latest = latestByWorkflow.get(run.workflow.databaseId);
    return latest?.databaseId === run.databaseId && latest.runAttempt === run.runAttempt;
  });
}

/**
 * Computed from the de-duplicated checks rather than trusting GitHub's own
 * `statusCheckRollup.state` verbatim — that field is computed over the raw,
 * pre-dedup context list, so a stale `cancelled` run from before a re-run
 * would otherwise still drag the whole PR's status to "failure".
 */
function computeRollupState(checks: CheckItem[]): string | null {
  if (checks.length === 0) return null;
  let pending = false;
  for (const check of checks) {
    if (check.status !== "completed") {
      pending = true;
      continue;
    }
    if (isFailureConclusion(check.conclusion)) return "failure";
  }
  return pending ? "pending" : "success";
}

const PR_STATUS_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        title
        url
        mergeable
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                ${STATUS_CHECK_ROLLUP_CONTEXTS}
              }
            }
          }
        }
      }
    }
  }
`;

interface PullRequestStatusResponse {
  repository: {
    pullRequest: {
      title: string;
      url: string;
      mergeable: string;
      commits: {
        nodes: Array<{
          commit: { statusCheckRollup: { contexts: { nodes: ContextNode[] } } | null };
        }>;
      };
    } | null;
  } | null;
}

export interface PullRequestCiStatus {
  title: string;
  url: string;
  mergeable: string;
  rollupState: string | null;
}

/**
 * Single-PR counterpart to `listOpenPullRequests`, used by webhook-driven
 * notifications that only care about one PR at a time and can't wait for
 * the dashboard's next poll. Reuses the same dedup/rollup logic so a
 * "CI 全绿" push agrees with what the dashboard would show.
 */
export async function getPullRequestCiStatus(
  installationId: number,
  owner: string,
  repo: string,
  number: number,
): Promise<PullRequestCiStatus | null> {
  const octokit = await getInstallationOctokit(installationId);
  const data = await octokit.graphql<PullRequestStatusResponse>(PR_STATUS_QUERY, { owner, repo, number });

  const pr = data.repository?.pullRequest;
  if (!pr) return null;

  const rollup = pr.commits.nodes[0]?.commit?.statusCheckRollup;
  const checks = rollup ? toChecks(selectCurrentContexts(rollup.contexts.nodes)) : [];
  return { title: pr.title, url: pr.url, mergeable: pr.mergeable, rollupState: computeRollupState(checks) };
}

/**
 * Fetches every open PR across all watched repos, grouped by installation
 * (each installation's token can only see its own repos). No caching layer
 * — this hits GitHub directly on every call, which is fine at personal
 * scale and keeps CI status honestly real-time.
 */
export async function listOpenPullRequests(userId = 0): Promise<PullRequestSummary[]> {
  const repos = await listWatchedRepos(userId);
  if (repos.length === 0) return [];

  const byInstallation = new Map<number, string[]>();
  for (const r of repos) {
    const list = byInstallation.get(r.installationId) ?? [];
    list.push(r.fullName);
    byInstallation.set(r.installationId, list);
  }

  const all: PullRequestSummary[] = [];
  for (const [installationId, fullNames] of byInstallation) {
    const octokit = await getInstallationOctokit(installationId);
    const searchQuery = `is:pr is:open ${fullNames.map((f) => `repo:${f}`).join(" ")}`;
    const data = await octokit.graphql<SearchResponse>(QUERY, { searchQuery });

    for (const node of data.search.nodes) {
      const rollup = node.commits.nodes[0]?.commit?.statusCheckRollup;
      const checks = rollup ? toChecks(selectCurrentContexts(rollup.contexts.nodes)) : [];
      all.push({
        id: node.id,
        number: node.number,
        title: node.title,
        url: node.url,
        isDraft: node.isDraft,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        author: node.author,
        repoFullName: node.repository.nameWithOwner,
        installationId,
        headRefName: node.headRefName,
        baseRefName: node.baseRefName,
        mergeable: node.mergeable,
        reviewDecision: node.reviewDecision,
        rollupState: computeRollupState(checks),
        checks,
      });
    }
  }

  // Best-effort: progress-bar estimates are a nice-to-have layered on top of
  // the GitHub-truth PR list above. A DB hiccup here (pool exhaustion, a
  // network blip) must not turn into a 500 for the whole dashboard — worst
  // case, checks just render without an estimate this time.
  try {
    await attachEstimatedDurations(all);
  } catch (error) {
    console.error("[prs] failed to attach estimated durations", error);
  }

  all.sort((a, b) => {
    const successPriority = Number(b.rollupState === "success") - Number(a.rollupState === "success");
    return successPriority || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
  return all;
}

/**
 * Fills in `durationEstimate` on every check_run, one query per
 * distinct repo (not per PR or per check) — a repo's checks share the same
 * historical sample pool regardless of which PR they're running on.
 */
async function attachEstimatedDurations(prs: PullRequestSummary[]): Promise<void> {
  const namesByRepo = new Map<string, Set<string>>();
  for (const pr of prs) {
    for (const check of pr.checks) {
      if (check.kind !== "check_run") continue;
      const names = namesByRepo.get(pr.repoFullName) ?? new Set<string>();
      names.add(check.name);
      namesByRepo.set(pr.repoFullName, names);
    }
  }
  if (namesByRepo.size === 0) return;

  const entries = await Promise.all(
    [...namesByRepo.entries()].map(
      async ([repoFullName, names]) => [repoFullName, await getEstimatedDurations(repoFullName, [...names])] as const,
    ),
  );
  const estimatesByRepo = new Map(entries);

  for (const pr of prs) {
    const estimates = estimatesByRepo.get(pr.repoFullName);
    if (!estimates) continue;
    for (const check of pr.checks) {
      if (check.kind === "check_run") check.durationEstimate = estimates.get(check.name) ?? null;
    }
  }
}
