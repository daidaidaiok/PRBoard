import type { CheckItem } from "./prs";

export function makeCheckItem(overrides: Partial<CheckItem> = {}): CheckItem {
  return {
    id: "check",
    name: "test",
    status: "completed",
    conclusion: "failure",
    detailsUrl: null,
    kind: "check_run",
    workflowRunId: 100,
    runAttempt: 1,
    canRerun: true,
    startedAt: null,
    completedAt: null,
    durationEstimate: null,
    ...overrides,
  };
}
