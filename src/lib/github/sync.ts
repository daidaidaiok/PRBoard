import { getGitHubApp, getInstallationOctokit } from "./app";
import { upsertInstallation, deleteInstallation, upsertRepos, listInstallationsForUser } from "@/db/installations";

/**
 * Pulls the current installation + repo list straight from GitHub and
 * mirrors it into the db. Used both as a one-off backfill (there's no
 * `installation.created` webhook replay for an app that was installed
 * before the webhook handler existed) and as a manual "resync" the user can
 * trigger if a webhook was ever missed.
 */
export async function syncAllInstallations() {
  const app = getGitHubApp();
  const results: Array<{ installationId: number; accountLogin: string; repoCount: number }> = [];

  for await (const { installation } of app.eachInstallation.iterator()) {
    const account = installation.account as { login?: string; slug?: string } | null;
    const accountLogin = account?.login ?? account?.slug ?? "unknown";

    await upsertInstallation({
      installationId: installation.id,
      accountGithubId: installation.account?.id ?? 0,
      accountLogin,
      accountType: installation.target_type,
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    });

    const octokit = await getInstallationOctokit(installation.id);
    const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });

    await upsertRepos(
      installation.id,
      repos.map((r) => ({
        repoId: Number(r.id),
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        isPrivate: r.private,
      })),
    );

    results.push({ installationId: installation.id, accountLogin, repoCount: repos.length });
  }

  return results;
}

/** Sync only installations linked to the authenticated user. */
export async function syncInstallationsForUser(userId: number) {
  const allowed = new Set((await listInstallationsForUser(userId)).map((row) => row.installationId));
  const app = getGitHubApp();
  const results: Array<{ installationId: number; accountLogin: string; repoCount: number }> = [];
  for await (const { installation } of app.eachInstallation.iterator()) {
    if (!allowed.has(installation.id)) continue;
    const account = installation.account as { id?: number; login?: string; slug?: string } | null;
    const accountLogin = account?.login ?? account?.slug ?? "unknown";
    await upsertInstallation({
      installationId: installation.id,
      accountGithubId: account?.id ?? 0,
      accountLogin,
      accountType: installation.target_type,
      suspendedAt: installation.suspended_at ? new Date(installation.suspended_at) : null,
    });
    const octokit = await getInstallationOctokit(installation.id);
    const repos = await octokit.paginate(octokit.rest.apps.listReposAccessibleToInstallation, { per_page: 100 });
    await upsertRepos(installation.id, repos.map((r) => ({
      repoId: Number(r.id), owner: r.owner.login, name: r.name, fullName: r.full_name, isPrivate: r.private,
    })));
    results.push({ installationId: installation.id, accountLogin, repoCount: repos.length });
  }
  return results;
}

export async function removeInstallation(installationId: number) {
  await deleteInstallation(installationId);
}
