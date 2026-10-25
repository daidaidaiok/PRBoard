import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listOpenPullRequests, type PullRequestSummary } from "@/lib/github/prs";
import { GITHUB_TIMEOUT_MS } from "@/lib/github/request-timeout";
import { DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetch-with-timeout";
import { countInstallationsForUser } from "@/db/installations";
import { syncInstallationsForUser } from "@/lib/github/sync";
import { getDashboardSnapshot, saveDashboardSnapshot } from "@/db/dashboard-snapshot";

const RETRY_DELAY_MS = 500;

/**
 * Retry a fast GitHub failure once. A single transient blip (connection
 * reset, token-mint hiccup, quick 5xx) used to fall straight through to the
 * snapshot — and a first-ever load has no snapshot, so the user got a hard
 * error for what a second attempt would have ridden out.
 *
 * Only fast failures retry: a second attempt must still fit the browser's
 * fetch budget (GITHUB_TIMEOUT_MS per request + this delay), otherwise
 * /api/prs outlives DEFAULT_FETCH_TIMEOUT_MS and the client aborts before
 * even the snapshot fallback can ship. A slow failure (the 15s GitHub
 * timeout firing) has already spent that budget, so it throws immediately.
 */
async function fetchPullRequestsWithRetry(userId: number): Promise<PullRequestSummary[]> {
  const startedAt = Date.now();
  try {
    return await listOpenPullRequests(userId);
  } catch (error) {
    const elapsed = Date.now() - startedAt;
    if (elapsed + RETRY_DELAY_MS + GITHUB_TIMEOUT_MS > DEFAULT_FETCH_TIMEOUT_MS) throw error;
    console.warn("[api/prs] GitHub fetch failed fast, retrying once", error);
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    return listOpenPullRequests(userId);
  }
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  // First load after an install (before any webhook has landed) would
  // otherwise show nothing — backfill once if the db has no installations yet.
  // A failed backfill must not 500 the request: the user gets an empty board
  // this round, and the next load (count still 0) retries the backfill.
  // The count itself is fault-tolerant too — on a flaky DB we'd rather fall
  // through to the snapshot path below than die before reaching it.
  let installationCount = 0;
  try {
    installationCount = await countInstallationsForUser(session.user.userId);
  } catch (error) {
    console.error("[api/prs] failed to count installations", error);
  }
  if (installationCount === 0) {
    try {
      await syncInstallationsForUser(session.user.userId);
    } catch (error) {
      console.error("[api/prs] installation backfill failed", error);
    }
  }

  let prs: PullRequestSummary[];
  try {
    prs = await fetchPullRequestsWithRetry(session.user.userId);
  } catch (error) {
    console.error("[api/prs] GitHub fetch failed, trying snapshot fallback", error);
    // GitHub unreachable (slow link, GitHub incident, rate limit…) — serve
    // the last good list instead of an error page and let the client flag
    // it as not-live. If even the snapshot read fails, there is genuinely
    // nothing to show.
    const snapshot = await getDashboardSnapshot(session.user.userId).catch((dbError) => {
      console.error("[api/prs] snapshot fallback read failed", dbError);
      return null;
    });
    if (!snapshot) {
      return NextResponse.json({ error: "GitHub 暂时不可用，且没有可用的本地快照" }, { status: 502 });
    }
    return NextResponse.json({ prs: snapshot.prs, stale: true, capturedAt: snapshot.capturedAt });
  }

  // Best-effort, same philosophy as attachEstimatedDurations: a snapshot
  // write failure must not fail an otherwise successful response.
  try {
    await saveDashboardSnapshot(session.user.userId, prs);
  } catch (error) {
    console.error("[api/prs] snapshot save failed", error);
  }

  return NextResponse.json({ prs, stale: false });
}
