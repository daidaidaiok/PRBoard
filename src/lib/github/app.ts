import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import { restEndpointMethods } from "@octokit/plugin-rest-endpoint-methods";
import { paginateRest } from "@octokit/plugin-paginate-rest";
import { getGitHubAppEnv } from "./env";
import { requestTimeoutHook } from "./request-timeout";

// @octokit/app's default Octokit is the bare @octokit/core client with no
// REST helpers or pagination. Compose one that has both, since every real
// call site (list PRs, list repos, merge, rerun) needs `.rest.*`/`.paginate`.
// The timeout hook bounds every request so a hung connection degrades into
// a catchable error instead of parking the route until the platform limit.
const AppOctokit = Octokit.plugin(requestTimeoutHook(), restEndpointMethods, paginateRest);

let appInstance: App<{ Octokit: typeof AppOctokit }> | null = null;

/**
 * App-level client, authenticated as the GitHub App itself (JWT).
 * Use this only for app-scoped calls (listing installations, app metadata).
 * Never use this to act on a user's or installation's behalf.
 */
export function getGitHubApp() {
  if (appInstance) return appInstance;
  const env = getGitHubAppEnv();
  appInstance = new App({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    oauth: {
      clientId: env.GITHUB_APP_CLIENT_ID,
      clientSecret: env.GITHUB_APP_CLIENT_SECRET,
    },
    webhooks: {
      secret: env.GITHUB_APP_WEBHOOK_SECRET,
    },
    Octokit: AppOctokit,
  });
  return appInstance;
}

/**
 * Installation-scoped Octokit, short-lived (~1h) token minted per call.
 * This is the token used for every repo-level read/write (list PRs, rerun
 * checks, merge). It is never persisted — only the installationId is stored.
 */
export async function getInstallationOctokit(installationId: number) {
  const app = getGitHubApp();
  return app.getInstallationOctokit(installationId);
}
