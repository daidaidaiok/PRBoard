import type { PullRequestSummary } from "@/lib/github/prs";

/**
 * Browser-side last-good dashboard list, so a slow/offline load paints the
 * previous board immediately instead of a spinner — the server snapshot
 * (src/db/dashboard-snapshot.ts) is the same idea one hop earlier in the
 * chain. Kept intentionally dependency-free and defensive: localStorage can
 * throw (quota, privacy mode, disabled), and a malformed entry must degrade
 * to "no cache", never break the dashboard.
 *
 * The payload is keyed to the GitHub login that fetched it — a cache written
 * under one account must never pre-paint for another on a shared browser.
 */

const CACHE_KEY = "prboard:prs-cache";
const CACHE_VERSION = 1;

interface CachedPayload {
  version: number;
  login: string;
  savedAt: string;
  prs: PullRequestSummary[];
}

/** Strips bookkeeping fields so callers can't confuse them with live state. */
export interface CachedDashboard {
  prs: PullRequestSummary[];
}

/**
 * Returns null off-client or when localStorage is unreachable — both must
 * degrade to "no cache" rather than throw into the caller's render path.
 */
function getBrowserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

function parsePayload(raw: string): CachedPayload | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const candidate = payload as Partial<CachedPayload>;
  if (
    candidate.version !== CACHE_VERSION ||
    typeof candidate.login !== "string" ||
    typeof candidate.savedAt !== "string" ||
    !Array.isArray(candidate.prs)
  ) {
    return null;
  }
  for (const pr of candidate.prs) {
    if (typeof pr !== "object" || pr === null) return null;
    const prRecord = pr as { id?: unknown; number?: unknown; checks?: unknown };
    if (typeof prRecord.id !== "string" || typeof prRecord.number !== "number" || !Array.isArray(prRecord.checks)) {
      return null;
    }
    for (const check of prRecord.checks) {
      if (typeof check !== "object" || check === null) return null;
    }
  }
  return payload as CachedPayload;
}

/** Returns the cached list for this login, or null when absent/malformed/owned by another account. */
export function loadCachedDashboard(login: string, storage?: Pick<Storage, "getItem">): CachedDashboard | null {
  const store = storage ?? getBrowserStorage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(CACHE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  const payload = parsePayload(raw);
  return payload && payload.login === login ? { prs: payload.prs } : null;
}

export function saveCachedDashboard(prs: PullRequestSummary[], login: string, storage?: Pick<Storage, "setItem">): void {
  const store = storage ?? getBrowserStorage();
  if (!store) return;
  const payload: CachedPayload = { version: CACHE_VERSION, login, savedAt: new Date().toISOString(), prs };
  try {
    store.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Quota/privacy-mode failures are fine — the cache is an optimization.
  }
}
