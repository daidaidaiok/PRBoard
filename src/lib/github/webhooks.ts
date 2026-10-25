import { Webhooks } from "@octokit/webhooks";
import { after } from "next/server";
import { getGitHubAppEnv } from "./env";
import { upsertInstallation, upsertRepos, removeReposByRepoId } from "@/db/installations";
import { notifyUpdate } from "@/db/realtime";
import { checkRunDurationSeconds, recordCheckDuration } from "@/db/check-durations";
import { removeInstallation } from "./sync";
import { handleWorkflowRunCompleted } from "./workflow-retry";
import { notifyDeployFailed, notifyIfConflicting, notifyWorkflowRunOutcome } from "./ci-notifications";

let webhooksInstance: Webhooks | null = null;

/**
 * Central place event handlers are registered. Signature verification
 * happens inside `verifyAndReceive` (called from the route handler) before
 * any of these run, so handlers can trust `payload`.
 *
 * PR and check-run state is deliberately NOT cached here — the dashboard
 * queries GitHub directly on load. These handlers only keep
 * `installations` / `installation_repos` (which repos exist to query) in
 * sync, and act as the "something changed" signal for the dashboard to
 * refetch.
 */
export function getWebhooks(): Webhooks {
  if (webhooksInstance) return webhooksInstance;
  const env = getGitHubAppEnv();
  webhooksInstance = new Webhooks({ secret: env.GITHUB_APP_WEBHOOK_SECRET });

  webhooksInstance.on(["installation.created", "installation.unsuspend"], async ({ payload }) => {
    const account = payload.installation.account;
    const accountLogin = account && "login" in account ? account.login : (account?.slug ?? "unknown");
    await upsertInstallation({
      installationId: payload.installation.id,
      accountGithubId: payload.installation.account?.id ?? 0,
      accountLogin,
      accountType: payload.installation.target_type,
      suspendedAt: null,
    });
    if (payload.action === "created" && "repositories" in payload && payload.repositories) {
      await upsertRepos(
        payload.installation.id,
        payload.repositories.map((r) => ({
          repoId: r.id,
          owner: accountLogin,
          name: r.name,
          fullName: r.full_name,
          isPrivate: Boolean(r.private),
        })),
      );
    }
  });

  webhooksInstance.on("installation.deleted", async ({ payload }) => {
    await removeInstallation(payload.installation.id);
  });

  webhooksInstance.on("installation_repositories", async ({ payload }) => {
    const account = payload.installation.account;
    const accountLogin = account && "login" in account ? account.login : (account?.slug ?? "unknown");
    if (payload.repositories_added.length > 0) {
      await upsertRepos(
        payload.installation.id,
        payload.repositories_added.map((r) => ({
          repoId: r.id,
          owner: accountLogin,
          name: r.name,
          fullName: r.full_name,
          isPrivate: Boolean(r.private),
        })),
      );
    }
    if (payload.repositories_removed.length > 0) {
      const ids = payload.repositories_removed
        .map((r) => r.id)
        .filter((id): id is number => id !== undefined);
      await removeReposByRepoId(ids);
    }
    await notifyUpdate({ repoFullName: accountLogin, reason: "installation_repositories" });
  });

  webhooksInstance.on("workflow_run.completed", async ({ payload }) => {
    await handleWorkflowRunCompleted({
      repoFullName: payload.repository.full_name,
      workflowRunId: payload.workflow_run.id,
      runAttempt: payload.workflow_run.run_attempt,
      conclusion: payload.workflow_run.conclusion,
      hasPullRequest: payload.workflow_run.pull_requests.length > 0,
    });

    // Bark push: "全绿" / "重试后仍失败". Scheduled via `after()` rather than
    // awaited — GitHub expects a fast webhook ack, and this can involve a
    // GraphQL + Bark round trip. `after()` (unlike a bare fire-and-forget)
    // keeps the function instance alive until it finishes. A push failure
    // here must never affect the retry claim above — see notifyWorkflowRunOutcome.
    after(() =>
      notifyWorkflowRunOutcome({
        installationId: payload.installation?.id ?? null,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        workflowRunId: payload.workflow_run.id,
        workflowName: payload.workflow_run.name ?? payload.workflow_run.path,
        runAttempt: payload.workflow_run.run_attempt,
        conclusion: payload.workflow_run.conclusion,
        headSha: payload.workflow_run.head_sha,
        htmlUrl: payload.workflow_run.html_url,
        pullRequestNumbers: payload.workflow_run.pull_requests.flatMap((pr) => (pr === null ? [] : [pr.number])),
      }),
    );
  });

  // Bark push: "存在冲突". Only the actions that can newly introduce a
  // conflict — opening/reopening a PR or pushing new commits to it.
  // Scheduled via `after()`, same reasoning as the workflow_run handler above.
  //
  // Narrowed with explicit `!==` checks rather than an array `.includes()`:
  // only the former lets TS narrow `payload` down from the full 20+-variant
  // pull_request union to the three variants that actually carry `installation`.
  webhooksInstance.on("pull_request", async ({ payload }) => {
    if (payload.action !== "opened" && payload.action !== "synchronize" && payload.action !== "reopened") return;
    after(() =>
      notifyIfConflicting({
        installationId: payload.installation?.id ?? null,
        owner: payload.repository.owner.login,
        repo: payload.repository.name,
        number: payload.pull_request.number,
      }),
    );
  });

  // Samples completed check-run durations for the progress-bar estimate
  // (src/db/check-durations.ts). Scheduled via `after()`, past the webhook
  // response — this is a nice-to-have write, never worth delaying the ack.
  //
  // Also the delivery point for the fourth Bark push kind: "Vercel 部署失败"
  // (deploy_failed), below.
  //
  // Only PR-associated runs are sampled (same `pull_requests` signal
  // `workflow_run.completed` already uses above) — a check named e.g. "test"
  // also running on pushes to main, on a cron, or in a release workflow
  // would otherwise share this check name's sample pool and pull the
  // estimate away from "how long does this take on a PR".
  webhooksInstance.on("check_run.completed", async ({ payload }) => {
    // Bark push: "Vercel 部署失败". Deliberately before the PR-association
    // return below — Vercel emits deploy checks that aren't attached to a PR,
    // and those are exactly the deploys worth waking someone up for.
    if (payload.check_run.app?.slug === "vercel") {
      after(() =>
        notifyDeployFailed({
          installationId: payload.installation?.id ?? null,
          repoFullName: payload.repository.full_name,
          checkRunId: payload.check_run.id,
          checkName: payload.check_run.name,
          conclusion: payload.check_run.conclusion,
          appSlug: payload.check_run.app?.slug ?? null,
          headSha: payload.check_run.head_sha,
          detailsUrl: payload.check_run.details_url ?? null,
        }).catch((error) => console.error("[webhooks] failed to send deploy-failed bark push", error)),
      );
    }

    if (payload.check_run.pull_requests.length === 0) return;

    const durationSeconds = checkRunDurationSeconds(payload.check_run);
    if (durationSeconds === null) return;

    after(() =>
      recordCheckDuration({
        repoFullName: payload.repository.full_name,
        checkName: payload.check_run.name,
        durationSeconds,
      }).catch((error) => console.error("[webhooks] failed to record check duration", error)),
    );
  });

  webhooksInstance.on(["check_run", "check_suite", "workflow_run", "pull_request"], async ({ name, payload }) => {
    const repoFullName = payload.repository?.full_name ?? "unknown";
    console.log(`[webhook] ${name} repo=${repoFullName}`);
    // No cache to update — the dashboard queries GitHub directly. This just
    // wakes up any open SSE connection to refetch (see src/db/realtime.ts).
    await notifyUpdate({ repoFullName, reason: name });
  });

  webhooksInstance.onError((error) => {
    console.error("[webhook] handler error", error);
  });

  return webhooksInstance;
}
