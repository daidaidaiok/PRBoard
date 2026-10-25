import type { Octokit } from "@octokit/core";

/**
 * Upper bound for every GitHub API request made through an Octokit built
 * with this hook. Without it a hung connection (GitHub incident, slow
 * cross-border link on the self-hosted deployment) parks the request until
 * the client gives up, and callers can't fall back to degraded data because
 * they never get an answer to degrade from. Each request gets its own fresh
 * signal, so the clock starts when the request starts, not when the process
 * started.
 *
 * Must stay below the browser fetch budget (DEFAULT_FETCH_TIMEOUT_MS, 20s):
 * /api/prs answers with the stale snapshot fallback only after this bound
 * fires, so if it exceeded the client budget the user would always see a
 * timeout instead of degraded data. Leave headroom for the DB roundtrips
 * around it (session + snapshot read).
 *
 * Injected only when the request doesn't carry its own signal — callers that
 * manage cancellation explicitly keep ownership.
 */
export const GITHUB_TIMEOUT_MS = 15_000;

export function requestTimeoutHook(timeoutMs: number = GITHUB_TIMEOUT_MS) {
  return (octokit: Octokit) => {
    octokit.hook.wrap("request", async (request, options) => {
      options.request ??= {};
      options.request.signal ??= AbortSignal.timeout(timeoutMs);
      return request(options);
    });
    return {};
  };
}
