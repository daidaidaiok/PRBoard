import { and, eq, gte, inArray } from "drizzle-orm";
import { db } from "./index";
import { checkDurationSamples } from "./schema";

const ESTIMATE_WINDOW_DAYS = 30;

/**
 * A sample one week old counts half as much as a fresh one. CI times drift —
 * dependencies grow, code grows, runners get contended — so the estimate must
 * follow the recent past; but a slow decay (rather than "last run only")
 * keeps a single unusually fast/slow run from whipsawing the estimate.
 */
const SAMPLE_HALF_LIFE_DAYS = 7;

/** What the UI shows as "~5m ±30s (n=12)": the estimate itself, how honest the ± is, and how much history backs it. */
export interface DurationEstimate {
  /** Recency-weighted median duration, in whole seconds. */
  seconds: number;
  /**
   * Recency-weighted 70th-percentile duration, in whole seconds — what "剩 ~X"
   * counts down from. CI durations skew right (cache misses, runner contention),
   * so a median readout times out on ~half of all runs; quoting p70 flips that
   * so finishing early is the common case. The progress bar keeps using the
   * median — the two readouts deliberately answer different questions.
   */
  etaSeconds: number;
  /** How many historical samples the estimate is built from — small n means wide real-world uncertainty. */
  n: number;
  /** Half the weighted interquartile range, in seconds; 0 when every sample agrees. */
  spreadSeconds: number;
}

export interface DurationSample {
  durationSeconds: number;
  completedAt: Date;
}

/**
 * Only a clean `success` reflects how long this check normally takes. A
 * `failure` commonly means it aborted early (first failing test, first
 * lint error) — sampling it would skew the estimate toward the runtime of
 * a check that gave up, not one that ran to completion. `cancelled`/
 * `timed_out` are excluded for the same reason: interrupted or hit an
 * artificial ceiling, not representative either way.
 */
export function checkRunDurationSeconds(checkRun: {
  conclusion: string | null;
  started_at: string;
  completed_at: string | null;
}): number | null {
  if (checkRun.conclusion !== "success") return null;
  if (!checkRun.completed_at) return null;

  const startedAt = Date.parse(checkRun.started_at);
  const completedAt = Date.parse(checkRun.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt) || completedAt <= startedAt) return null;

  return Math.round((completedAt - startedAt) / 1000);
}

export async function recordCheckDuration(params: {
  repoFullName: string;
  checkName: string;
  durationSeconds: number;
}): Promise<void> {
  await db.insert(checkDurationSamples).values(params);
}

/**
 * First duration whose cumulative weight reaches `fraction` of the total —
 * the weighted analogue of a quantile over an ascending-sorted list.
 */
function weightedQuantile(durations: number[], weights: number[], fraction: number): number {
  let totalWeight = 0;
  for (const w of weights) totalWeight += w;
  const target = fraction * totalWeight;

  let cumulative = 0;
  for (let i = 0; i < durations.length; i++) {
    cumulative += weights[i]!;
    if (cumulative >= target) return durations[i]!;
  }
  return durations[durations.length - 1]!;
}

/**
 * Recency-weighted median and IQR spread over one check's sample pool.
 *
 * Median rather than mean: one cache-miss or runner-stall outlier drags a
 * mean for the whole window, while a median barely moves. The exponential
 * age weighting (see `SAMPLE_HALF_LIFE_DAYS`) layers drift-tracking on top.
 * Spread is reported rather than hidden — the caller surfaces it so a thin
 * or noisy history reads as "±large (n=2)", not as false precision.
 * `etaSeconds` layers a p70 readout on the same pool — see its doc comment
 * for why the countdown deliberately quotes a higher quantile than the bar.
 *
 * Null when there are no usable samples (nothing to estimate from yet).
 */
export function estimateFromSamples(samples: DurationSample[], nowMs: number): DurationEstimate | null {
  const usable = samples.filter((s) => s.durationSeconds > 0);
  if (usable.length === 0) return null;

  const weighted = usable
    .map((s) => {
      const ageDays = Math.max(0, (nowMs - s.completedAt.getTime()) / (24 * 60 * 60 * 1000));
      return { duration: s.durationSeconds, weight: Math.exp((-ageDays / SAMPLE_HALF_LIFE_DAYS) * Math.LN2) };
    })
    .sort((a, b) => a.duration - b.duration);

  const durations = weighted.map((w) => w.duration);
  const weights = weighted.map((w) => w.weight);
  const p25 = weightedQuantile(durations, weights, 0.25);
  const median = weightedQuantile(durations, weights, 0.5);
  const p70 = weightedQuantile(durations, weights, 0.7);
  const p75 = weightedQuantile(durations, weights, 0.75);

  return {
    seconds: Math.round(median),
    etaSeconds: Math.round(p70),
    n: usable.length,
    spreadSeconds: Math.round((p75 - p25) / 2),
  };
}

/**
 * Per check name over the last `ESTIMATE_WINDOW_DAYS`, scoped to one repo:
 * a recency-weighted median of successful runs. A name with no samples in
 * that window is simply absent from the returned map (there's nothing to
 * estimate from yet).
 */
export async function getEstimatedDurations(
  repoFullName: string,
  checkNames: string[],
): Promise<Map<string, DurationEstimate>> {
  if (checkNames.length === 0) return new Map();

  const since = new Date(Date.now() - ESTIMATE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      checkName: checkDurationSamples.checkName,
      durationSeconds: checkDurationSamples.durationSeconds,
      completedAt: checkDurationSamples.completedAt,
    })
    .from(checkDurationSamples)
    .where(
      and(
        eq(checkDurationSamples.repoFullName, repoFullName),
        inArray(checkDurationSamples.checkName, checkNames),
        gte(checkDurationSamples.completedAt, since),
      ),
    );

  const samplesByName = new Map<string, DurationSample[]>();
  for (const row of rows) {
    const list = samplesByName.get(row.checkName) ?? [];
    list.push({ durationSeconds: row.durationSeconds, completedAt: row.completedAt });
    samplesByName.set(row.checkName, list);
  }

  const nowMs = Date.now();
  const estimates = new Map<string, DurationEstimate>();
  for (const [checkName, samples] of samplesByName) {
    const estimate = estimateFromSamples(samples, nowMs);
    if (estimate) estimates.set(checkName, estimate);
  }
  return estimates;
}
