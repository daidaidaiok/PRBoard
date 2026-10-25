import type { CheckItem } from "./prs";

// Capped short of 100 — a check/PR that isn't fully completed yet, by
// definition, isn't done, so showing a full bar before the "completed"
// webhook actually lands would read as done when it isn't. Only lifted to
// a true 100 once everything counted really has completed (see
// `computePrProgress`).
const IN_PROGRESS_CAP_PERCENT = 97;

/** `check.startedAt` parsed against `nowMs`; 0 if missing/unparseable rather than throwing — callers treat "no reliable start time" as "hasn't visibly started yet". */
function elapsedSecondsSince(startedAt: string | null, nowMs: number): number {
  if (!startedAt) return 0;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, (nowMs - startedAtMs) / 1000);
}

/**
 * How long a completed check actually ran, from its own start/finish
 * timestamps. Null when either timestamp is missing or nonsense (finished
 * before it started) — the caller then falls back to the check's estimate.
 */
function actualRunSeconds(check: CheckItem): number | null {
  if (!check.startedAt || !check.completedAt) return null;
  const startedAtMs = Date.parse(check.startedAt);
  const completedAtMs = Date.parse(check.completedAt);
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs) || completedAtMs <= startedAtMs) return null;
  return (completedAtMs - startedAtMs) / 1000;
}

export interface CheckProgress {
  elapsedSeconds: number;
  estimatedSeconds: number;
  /** Half the historical sample spread — the honest "±" shown next to the estimate. */
  spreadSeconds: number;
  /** How many historical samples the estimate is built from. */
  sampleCount: number;
  percent: number;
}

/** Null when there's nothing to show a bar for: not running, or no history yet. */
export function computeCheckProgress(check: CheckItem, nowMs: number): CheckProgress | null {
  if (check.kind !== "check_run" || check.status !== "in_progress") return null;
  const estimate = check.durationEstimate;
  if (estimate === null || estimate.seconds <= 0) return null;
  if (!check.startedAt) return null;

  const estimatedSeconds = estimate.seconds;
  const elapsedSeconds = elapsedSecondsSince(check.startedAt, nowMs);
  const percent = Math.min(IN_PROGRESS_CAP_PERCENT, (elapsedSeconds / estimatedSeconds) * 100);
  return { elapsedSeconds, estimatedSeconds, spreadSeconds: estimate.spreadSeconds, sampleCount: estimate.n, percent };
}

export interface PrProgress {
  percent: number;
  elapsedTotalSeconds: number;
  estimatedTotalSeconds: number;
  /**
   * The PR-level "±": per-check sample spreads combine as independent
   * variances (root sum of squares), not a plain sum — a plain sum would
   * overstate the uncertainty of the total.
   */
  spreadTotalSeconds: number;
  /**
   * The smallest per-check sample count among the checks summed here — the
   * total is only as trustworthy as its weakest estimate.
   */
  sampleCount: number;
  /**
   * Wall-clock estimate of how much longer until this PR's checks finish.
   * Checks run in parallel, so the slowest outstanding one bounds the
   * finish: the max remaining time over in-progress checks (p70 estimate −
   * elapsed, floored at 0) and not-yet-started checks (full p70 estimate).
   * Summing job times — what the readout used to show — overstated the
   * wait by the parallelism factor. Updated live as slow checks finish
   * and queued ones start, so staggered starts correct themselves.
   * The spread/sample fields describe the binding (slowest) check, whose
   * uncertainty is the one that matters. 0 once every counted check has
   * completed.
   */
  remainingSeconds: number;
  remainingSpreadSeconds: number;
  remainingSampleCount: number;
}

/**
 * Aggregates every check_run's share of the PR's total estimated CI time.
 * A completed check contributes its actual run time when its start/finish
 * timestamps are known (falling back to its estimated share when they
 * aren't), so the elapsed readout tracks real time — a check that ran long
 * doesn't get silently compressed to its historical average. A check that
 * hasn't started yet still counts toward the denominator (0 elapsed) so the
 * bar doesn't jump once it begins. Null when no check in the PR has any
 * history to estimate from yet — nothing meaningful to show.
 *
 * The 97% cap only applies while something counted isn't `completed` yet;
 * once every check with an estimate has actually finished, the bar reads a
 * genuine 100 rather than being stuck just short of it forever.
 */
export function computePrProgress(checks: CheckItem[], nowMs: number): PrProgress | null {
  let estimatedTotal = 0;
  let elapsedTotal = 0;
  let spreadSquaredTotal = 0;
  let sampleCount = Number.POSITIVE_INFINITY;
  let remainingSeconds = 0;
  let remainingSpreadSeconds = 0;
  let remainingSampleCount = 0;
  let hasEstimate = false;
  let allCompleted = true;

  for (const check of checks) {
    if (check.kind !== "check_run" || check.durationEstimate === null) continue;
    hasEstimate = true;
    const estimate = check.durationEstimate;
    estimatedTotal += estimate.seconds;
    spreadSquaredTotal += estimate.spreadSeconds * estimate.spreadSeconds;
    sampleCount = Math.min(sampleCount, estimate.n);

    if (check.status === "completed") {
      elapsedTotal += actualRunSeconds(check) ?? estimate.seconds;
      continue;
    }
    allCompleted = false;
    const elapsed = check.status === "in_progress" ? elapsedSecondsSince(check.startedAt, nowMs) : 0;
    if (check.status === "in_progress") elapsedTotal += Math.min(elapsed, estimate.seconds);
    // queued/pending/requested/waiting/expected: 0 elapsed, still counted in the denominator.
    // The countdown quotes this check's p70 (`etaSeconds`), not its median: CI durations
    // skew right, so a median countdown times out on ~half of runs and the bar then sits
    // at its 97% cap waiting. An in-progress check that has run past its median no longer
    // reads as "any moment" — it keeps counting down until it passes the p70 mark.
    const outstanding = Math.max(0, estimate.etaSeconds - elapsed);
    if (outstanding > remainingSeconds) {
      remainingSeconds = outstanding;
      remainingSpreadSeconds = estimate.spreadSeconds;
      remainingSampleCount = estimate.n;
    }
  }

  if (!hasEstimate || estimatedTotal <= 0) return null;
  const rawPercent = (elapsedTotal / estimatedTotal) * 100;
  const percent = allCompleted ? Math.min(100, rawPercent) : Math.min(IN_PROGRESS_CAP_PERCENT, rawPercent);
  return {
    percent,
    elapsedTotalSeconds: Math.round(elapsedTotal),
    estimatedTotalSeconds: Math.round(estimatedTotal),
    spreadTotalSeconds: Math.round(Math.sqrt(spreadSquaredTotal)),
    sampleCount,
    remainingSeconds,
    remainingSpreadSeconds,
    remainingSampleCount,
  };
}

export function formatDurationSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return `${minutes}m${remainingSeconds.toString().padStart(2, "0")}s`;
}
