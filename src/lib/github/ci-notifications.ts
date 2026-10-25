import { isRetryExhausted } from "./retry-policy";
import { getPullRequestCiStatus } from "./prs";
import { sendBarkNotification } from "@/lib/bark";
import type { BarkNotification } from "@/lib/bark";
import { claimNotification, clearNotification } from "@/db/notification-dedup";
import type { NotificationKind } from "@/db/notification-dedup";
import { listNotifiableUsers } from "@/db/notification-settings";

export interface WorkflowRunNotificationEvent {
  installationId: number | null;
  owner: string;
  repo: string;
  workflowRunId: number;
  workflowName: string;
  runAttempt: number;
  conclusion: string | null;
  headSha: string;
  htmlUrl: string;
  pullRequestNumbers: number[];
}

type Recipient = { userId: number; barkUrl: string };

/**
 * Per-recipient claim + push. The dedup key embeds the userId because the
 * `notification_dedup` unique index is global — without the prefix the first
 * recipient's claim would silently suppress everyone else's push for the
 * same event. Individual failures are logged, never rethrown: one user's
 * dead Bark server must not block the others.
 */
async function pushToRecipients(
  repoFullName: string,
  kind: NotificationKind,
  dedupKey: string,
  recipients: Recipient[],
  logLabel: string,
  notification: BarkNotification,
): Promise<void> {
  await Promise.allSettled(
    recipients.map(async (recipient) => {
      try {
        if (!(await claimNotification(repoFullName, kind, `${recipient.userId}:${dedupKey}`))) return;
        const result = await sendBarkNotification(recipient.barkUrl, notification);
        if (!result.ok) {
          console.error(`[ci-notifications] ${logLabel} push failed`, {
            repoFullName,
            userId: recipient.userId,
            status: result.status,
          });
        }
      } catch (error) {
        console.error(`[ci-notifications] ${logLabel} push failed`, {
          repoFullName,
          userId: recipient.userId,
          error,
        });
      }
    }),
  );
}

/**
 * Pushes the two CI-outcome notifications the auto-retry pipeline
 * (`handleWorkflowRunCompleted`) itself never announces: it only acts when
 * there's something to *do* (retry), so "all green" and "retries exhausted"
 * — the two states where it deliberately does nothing more — need a
 * separate observer. Recipients come from `listNotifiableUsers` (users on
 * the installation with a Bark URL and the kind's switch on); each gets an
 * independent user-scoped claim via `claimNotification`, so a redelivered
 * webhook (GitHub's delivery is at-least-once) or two workflow runs both
 * observing the same PR go green don't double-push. Errors are caught per
 * item/per recipient and logged, never rethrown — a failed push must never
 * fail the webhook delivery or block the retry claim it runs alongside.
 */
export async function notifyWorkflowRunOutcome(event: WorkflowRunNotificationEvent): Promise<void> {
  if (event.pullRequestNumbers.length === 0) return;
  if (event.installationId === null) return; // no installation → nobody to resolve recipients from
  const repoFullName = `${event.owner}/${event.repo}`;
  const installationId = event.installationId;

  if (isRetryExhausted(event.conclusion, event.runAttempt)) {
    try {
      const recipients = await listNotifiableUsers(installationId, "ci_retry_exhausted");
      await pushToRecipients(repoFullName, "ci_retry_exhausted", `${event.workflowRunId}:${event.runAttempt}`, recipients, "retry-exhausted", {
        title: "CI 重试后仍失败",
        body: `${repoFullName} · ${event.workflowName} · 第 ${event.runAttempt} 次尝试仍失败`,
        url: event.htmlUrl,
        level: "timeSensitive",
      });
    } catch (error) {
      console.error("[ci-notifications] retry-exhausted push failed", { repoFullName, workflowRunId: event.workflowRunId, error });
    }
    return;
  }

  if (event.conclusion !== "success") return;

  await Promise.allSettled(
    event.pullRequestNumbers.map(async (number) => {
      try {
        const status = await getPullRequestCiStatus(installationId, event.owner, event.repo, number);
        if (status?.rollupState !== "success") return;

        const recipients = await listNotifiableUsers(installationId, "ci_green");
        await pushToRecipients(repoFullName, "ci_green", `${number}:${event.headSha}`, recipients, "all-green", {
          title: "CI 全绿",
          body: `${repoFullName} · #${number} ${status.title}`,
          url: status.url,
          level: "timeSensitive",
        });
      } catch (error) {
        console.error("[ci-notifications] all-green push failed", { repoFullName, number, error });
      }
    }),
  );
}

export interface PullRequestNotificationEvent {
  installationId: number | null;
  owner: string;
  repo: string;
  number: number;
}

// GitHub computes `mergeable` in a background job kicked off by the same
// push that triggers this webhook, so it routinely still reads "UNKNOWN"
// immediately after — `synchronize` (the event most likely to introduce a
// conflict) is also the event least likely to have it resolved yet. Safe to
// wait here: this already runs inside `after()`, past the webhook response.
const CONFLICT_CHECK_RETRY_DELAYS_MS = [2000, 4000];

export async function resolveMergeableStatus(
  installationId: number,
  owner: string,
  repo: string,
  number: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
) {
  let status = await getPullRequestCiStatus(installationId, owner, repo, number);
  for (const delayMs of CONFLICT_CHECK_RETRY_DELAYS_MS) {
    if (!status || status.mergeable !== "UNKNOWN") break;
    await sleep(delayMs);
    status = await getPullRequestCiStatus(installationId, owner, repo, number);
  }
  return status;
}

/**
 * Claimed per recipient via `claimNotification` (user-scoped dedup key) so a
 * still-conflicting PR doesn't re-push to a user on every subsequent commit;
 * once it reads definitively `MERGEABLE` again the claims are cleared for the
 * same recipient list — users without a Bark URL can never have claimed, so
 * they need no cleanup — meaning the *next* time the PR turns conflicting
 * notifies again instead of staying permanently suppressed. A `mergeable`
 * that's still "UNKNOWN" after retrying (see `resolveMergeableStatus`) is
 * left alone entirely — neither claimed nor cleared — so a later event gets
 * a fair shot at resolving it.
 */
export async function notifyIfConflicting(event: PullRequestNotificationEvent): Promise<void> {
  if (event.installationId === null) return;
  const repoFullName = `${event.owner}/${event.repo}`;

  try {
    const status = await resolveMergeableStatus(event.installationId, event.owner, event.repo, event.number);
    if (!status) return;
    if (status.mergeable !== "MERGEABLE" && status.mergeable !== "CONFLICTING") return;

    const recipients = await listNotifiableUsers(event.installationId, "pr_conflict");

    if (status.mergeable === "MERGEABLE") {
      await Promise.allSettled(
        recipients.map((recipient) => clearNotification(repoFullName, "pr_conflict", `${recipient.userId}:${event.number}`)),
      );
      return;
    }

    await pushToRecipients(repoFullName, "pr_conflict", String(event.number), recipients, "conflict", {
      title: "PR 存在冲突",
      body: `${repoFullName} · #${event.number} ${status.title}`,
      url: status.url,
      level: "timeSensitive",
    });
  } catch (error) {
    console.error("[ci-notifications] conflict push failed", { repoFullName, number: event.number, error });
  }
}

export interface DeployFailedNotificationEvent {
  installationId: number | null;
  repoFullName: string;
  checkRunId: number;
  checkName: string;
  conclusion: string | null;
  appSlug: string | null;
  headSha: string;
  detailsUrl: string | null;
}

const DEPLOY_FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

/**
 * Fourth notification kind: a Vercel deploy check went bad. Semantics mirror
 * the former repo-level GitHub Actions workflow that relayed deploy failures
 * to a single Bark URL (same app filter, same conclusion set, same copy) —
 * but now the recipients come from user settings instead of a repo-level
 * secret. Deduped per user on the check-run id, so GitHub's at-least-once
 * redelivery stays quiet.
 */
export async function notifyDeployFailed(event: DeployFailedNotificationEvent): Promise<void> {
  if (event.installationId === null) return;
  if (event.appSlug !== "vercel") return;
  if (!event.conclusion || !DEPLOY_FAILED_CONCLUSIONS.has(event.conclusion)) return;

  const recipients = await listNotifiableUsers(event.installationId, "deploy_failed");
  await pushToRecipients(event.repoFullName, "deploy_failed", String(event.checkRunId), recipients, "deploy-failed", {
    title: `Vercel 部署失败 (${event.conclusion})`,
    body: `${event.repoFullName} · ${event.checkName} · ${event.headSha.slice(0, 7)}`,
    url: event.detailsUrl ?? `https://github.com/${event.repoFullName}/commit/${event.headSha}`,
    level: "timeSensitive",
  });
}
