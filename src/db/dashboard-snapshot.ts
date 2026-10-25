import { eq } from "drizzle-orm";
import { db } from "./index";
import { dashboardSnapshots } from "./schema";
import type { PullRequestSummary } from "@/lib/github/prs";

export interface DashboardSnapshot {
  prs: PullRequestSummary[];
  capturedAt: string;
}

/**
 * Bump whenever `PullRequestSummary` changes shape in a way old payloads
 * can't satisfy — a version mismatch invalidates stored snapshots instead
 * of serving the dashboard a partially-shaped row.
 */
const SNAPSHOT_VERSION = 1;

/**
 * Minimal shape check on the way out. The payload is written only by
 * `saveDashboardSnapshot`, so this guards against schema drift and hand-edited
 * rows, not hostile input — a malformed payload degrades to "no snapshot"
 * rather than blowing up the fallback path it exists to protect.
 */
export function parseSnapshotPayload(payload: unknown): PullRequestSummary[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { version, prs } = payload as { version?: unknown; prs?: unknown };
  if (version !== SNAPSHOT_VERSION || !Array.isArray(prs)) return null;
  for (const pr of prs) {
    if (typeof pr !== "object" || pr === null) return null;
    const candidate = pr as { id?: unknown; number?: unknown; checks?: unknown };
    if (typeof candidate.id !== "string" || typeof candidate.number !== "number" || !Array.isArray(candidate.checks)) {
      return null;
    }
    // The dashboard dereferences fields on every check (`c.kind`, …); a null
    // element would crash the fallback render this table exists to protect.
    for (const check of candidate.checks) {
      if (typeof check !== "object" || check === null) return null;
    }
  }
  return prs as PullRequestSummary[];
}

export async function getDashboardSnapshot(userId: number): Promise<DashboardSnapshot | null> {
  const rows = await db
    .select({ payload: dashboardSnapshots.payload, capturedAt: dashboardSnapshots.capturedAt })
    .from(dashboardSnapshots)
    .where(eq(dashboardSnapshots.userId, userId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  const prs = parseSnapshotPayload(row.payload);
  if (!prs) return null;
  return { prs, capturedAt: row.capturedAt.toISOString() };
}

export async function saveDashboardSnapshot(userId: number, prs: PullRequestSummary[]): Promise<void> {
  // Known, accepted window: an empty or truncated "successful" GitHub answer
  // (search index lag, a partial outage) replaces the last good snapshot.
  // Not merging old-with-new is deliberate — a ghost PR from a stale snapshot
  // must never light up the merge button.
  const payload = { version: SNAPSHOT_VERSION, prs };
  await db
    .insert(dashboardSnapshots)
    .values({ userId, payload, capturedAt: new Date() })
    .onConflictDoUpdate({
      target: dashboardSnapshots.userId,
      set: { payload, capturedAt: new Date() },
    });
}
