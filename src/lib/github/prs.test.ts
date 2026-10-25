import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DurationEstimate } from "@/db/check-durations";

const { graphql, listWatchedRepos, getEstimatedDurations } = vi.hoisted(() => ({
  graphql: vi.fn(),
  listWatchedRepos: vi.fn(),
  getEstimatedDurations: vi.fn(async () => new Map<string, DurationEstimate>()),
}));

vi.mock("./app", () => ({
  getInstallationOctokit: vi.fn(async () => ({ graphql })),
}));

vi.mock("@/db/installations", () => ({ listWatchedRepos }));
vi.mock("@/db/check-durations", () => ({ getEstimatedDurations }));

import { getPullRequestCiStatus, listOpenPullRequests } from "./prs";

describe("listOpenPullRequests", () => {
  beforeEach(() => {
    listWatchedRepos.mockResolvedValue([{ installationId: 7, fullName: "owner/repo" }]);
    graphql.mockResolvedValue({
      search: {
        nodes: [
          {
            id: "PR_1",
            number: 12,
            title: "Test PR",
            url: "https://github.com/owner/repo/pull/12",
            isDraft: false,
            createdAt: "2026-08-30T00:00:00Z",
            updatedAt: "2026-08-30T00:00:00Z",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            author: { login: "owner", avatarUrl: "https://example.com/avatar" },
            repository: { nameWithOwner: "owner/repo" },
            headRefName: "feature",
            baseRefName: "staging",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "FAILURE",
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            id: "CR_1",
                            name: "test",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                            detailsUrl: "https://github.com/owner/repo/actions/runs/200",
                            checkSuite: {
                              workflowRun: {
                                databaseId: 200,
                                runAttempt: 3,
                                runNumber: 12,
                                createdAt: "2026-08-30T00:00:00Z",
                                workflow: { databaseId: 300 },
                              },
                            },
                          },
                          {
                            __typename: "CheckRun",
                            id: "CR_2",
                            name: "third-party",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                            detailsUrl: "https://example.com/check",
                            checkSuite: { workflowRun: null },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("marks only GitHub Actions check runs as rerunnable", async () => {
    const [pr] = await listOpenPullRequests();

    expect(pr.checks[0]).toMatchObject({ workflowRunId: 200, runAttempt: 3, canRerun: true });
    expect(pr.checks[1]).toMatchObject({ workflowRunId: null, runAttempt: null, canRerun: false });
  });

  it("ignores stale jobs from an older workflow run while the latest run is queued", async () => {
    graphql.mockResolvedValueOnce({
      search: {
        nodes: [
          {
            id: "PR_1",
            number: 12,
            title: "Test PR",
            url: "https://github.com/owner/repo/pull/12",
            isDraft: false,
            createdAt: "2026-08-30T00:00:00Z",
            updatedAt: "2026-08-30T01:00:00Z",
            mergeable: "MERGEABLE",
            reviewDecision: null,
            author: null,
            repository: { nameWithOwner: "owner/repo" },
            headRefName: "feature",
            baseRefName: "staging",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      state: "FAILURE",
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            id: "old-failure",
                            name: "Guard Test Coupling",
                            status: "COMPLETED",
                            conclusion: "FAILURE",
                            detailsUrl: null,
                            checkSuite: {
                              workflowRun: {
                                databaseId: 101,
                                runAttempt: 1,
                                runNumber: 20,
                                createdAt: "2026-08-30T00:00:00Z",
                                workflow: { databaseId: 7 },
                              },
                            },
                          },
                          {
                            __typename: "CheckRun",
                            id: "old-downstream",
                            name: "Rust build",
                            status: "COMPLETED",
                            conclusion: "CANCELLED",
                            detailsUrl: null,
                            checkSuite: {
                              workflowRun: {
                                databaseId: 101,
                                runAttempt: 1,
                                runNumber: 20,
                                createdAt: "2026-08-30T00:00:00Z",
                                workflow: { databaseId: 7 },
                              },
                            },
                          },
                          {
                            __typename: "CheckRun",
                            id: "new-gate",
                            name: "Guard Test Coupling",
                            status: "QUEUED",
                            conclusion: null,
                            detailsUrl: null,
                            checkSuite: {
                              workflowRun: {
                                databaseId: 102,
                                runAttempt: 1,
                                runNumber: 21,
                                createdAt: "2026-08-30T01:00:00Z",
                                workflow: { databaseId: 7 },
                              },
                            },
                          },
                          {
                            __typename: "CheckRun",
                            id: "other-workflow",
                            name: "Build",
                            status: "COMPLETED",
                            conclusion: "SUCCESS",
                            detailsUrl: null,
                            checkSuite: {
                              workflowRun: {
                                databaseId: 103,
                                runAttempt: 1,
                                runNumber: 9,
                                createdAt: "2026-08-30T01:00:00Z",
                                workflow: { databaseId: 8 },
                              },
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const [pr] = await listOpenPullRequests();

    expect(pr.rollupState).toBe("pending");
    expect(pr.checks.map((check) => check.id)).toEqual(["new-gate", "other-workflow"]);
  });

  it("orders successful PRs first while preserving updated order within each status group", async () => {
    function prNode(id: string, updatedAt: string, check?: { status: string; conclusion: string | null }) {
      return {
        id,
        number: Number(id.slice(3)),
        title: id,
        url: `https://github.com/owner/repo/pull/${id.slice(3)}`,
        isDraft: false,
        createdAt: "2026-08-30T00:00:00Z",
        updatedAt,
        mergeable: "MERGEABLE",
        reviewDecision: null,
        author: { login: "owner", avatarUrl: "https://example.com/avatar" },
        repository: { nameWithOwner: "owner/repo" },
        headRefName: id,
        baseRefName: "staging",
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: check
                  ? {
                      state: "IGNORED",
                      contexts: {
                        nodes: [
                          {
                            __typename: "CheckRun",
                            id: `CR_${id}`,
                            name: "test",
                            status: check.status,
                            conclusion: check.conclusion,
                            detailsUrl: null,
                            checkSuite: { workflowRun: null },
                          },
                        ],
                      },
                    }
                  : null,
              },
            },
          ],
        },
      };
    }

    graphql.mockResolvedValueOnce({
      search: {
        nodes: [
          prNode("PR_1", "2026-08-30T01:00:00Z", { status: "COMPLETED", conclusion: "SUCCESS" }),
          prNode("PR_2", "2026-08-30T02:00:00Z", { status: "COMPLETED", conclusion: "SUCCESS" }),
          prNode("PR_3", "2026-08-30T05:00:00Z", { status: "IN_PROGRESS", conclusion: null }),
          prNode("PR_4", "2026-08-30T04:00:00Z", { status: "COMPLETED", conclusion: "FAILURE" }),
          prNode("PR_5", "2026-08-30T03:00:00Z"),
        ],
      },
    });

    const prs = await listOpenPullRequests();

    expect(prs.map((pr) => pr.id)).toEqual(["PR_2", "PR_1", "PR_3", "PR_4", "PR_5"]);
    expect(prs.map((pr) => pr.rollupState)).toEqual(["success", "success", "pending", "failure", null]);
  });

  it("attaches historical duration estimates to check_run items, once per distinct check name in the repo", async () => {
    getEstimatedDurations.mockResolvedValueOnce(new Map([["test", { seconds: 42, etaSeconds: 55, n: 5, spreadSeconds: 6 } as DurationEstimate]]));

    const [pr] = await listOpenPullRequests();

    expect(getEstimatedDurations).toHaveBeenCalledWith("owner/repo", ["test", "third-party"]);
    expect(pr.checks[0]).toMatchObject({
      name: "test",
      kind: "check_run",
      durationEstimate: { seconds: 42, etaSeconds: 55, n: 5, spreadSeconds: 6 },
    });
  });

  it("leaves durationEstimate null for a check with no history yet", async () => {
    getEstimatedDurations.mockResolvedValueOnce(new Map());

    const [pr] = await listOpenPullRequests();

    expect(pr.checks[0].durationEstimate).toBeNull();
  });
});

describe("getPullRequestCiStatus", () => {
  it("computes the rollup state for a single PR from its status check rollup", async () => {
    graphql.mockResolvedValueOnce({
      repository: {
        pullRequest: {
          title: "Fix bug",
          url: "https://github.com/owner/repo/pull/12",
          mergeable: "CONFLICTING",
          commits: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          id: "CR_1",
                          name: "test",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                          detailsUrl: null,
                          checkSuite: { workflowRun: null },
                        },
                      ],
                    },
                  },
                },
              },
            ],
          },
        },
      },
    });

    const status = await getPullRequestCiStatus(7, "owner", "repo", 12);

    expect(status).toEqual({
      title: "Fix bug",
      url: "https://github.com/owner/repo/pull/12",
      mergeable: "CONFLICTING",
      rollupState: "success",
    });
    expect(graphql).toHaveBeenCalledWith(expect.any(String), { owner: "owner", repo: "repo", number: 12 });
  });

  it("returns null when the PR no longer exists", async () => {
    graphql.mockResolvedValueOnce({ repository: { pullRequest: null } });

    await expect(getPullRequestCiStatus(7, "owner", "repo", 999)).resolves.toBeNull();
  });
});
