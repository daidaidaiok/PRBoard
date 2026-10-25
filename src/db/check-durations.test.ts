import { describe, expect, it, vi } from "vitest";

// check-durations.ts imports ./index (the drizzle client), which throws
// without a live DATABASE_URL — irrelevant to the pure functions this file
// tests, so it's mocked away rather than actually connecting.
vi.mock("./index", () => ({ db: {} }));

import { checkRunDurationSeconds, estimateFromSamples, type DurationSample } from "./check-durations";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function sample(durationSeconds: number, ageDays = 0): DurationSample {
  return { durationSeconds, completedAt: new Date(NOW - ageDays * DAY_MS) };
}

describe("checkRunDurationSeconds", () => {
  it("computes the elapsed seconds between start and completion", () => {
    const seconds = checkRunDurationSeconds({
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:02:05Z",
    });

    expect(seconds).toBe(125);
  });

  it.each(["failure", "cancelled", "timed_out", "action_required", "neutral", "skipped", "startup_failure"])(
    "ignores a %s conclusion — only a clean success is representative of the normal runtime",
    (conclusion) => {
      const seconds = checkRunDurationSeconds({
        conclusion,
        started_at: "2026-01-01T00:00:00Z",
        completed_at: "2026-01-01T00:02:05Z",
      });

      expect(seconds).toBeNull();
    },
  );

  it("returns null when conclusion is missing (still running)", () => {
    const seconds = checkRunDurationSeconds({ conclusion: null, started_at: "2026-01-01T00:00:00Z", completed_at: null });

    expect(seconds).toBeNull();
  });

  it("returns null when completed_at is missing", () => {
    const seconds = checkRunDurationSeconds({
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: null,
    });

    expect(seconds).toBeNull();
  });

  it("returns null for a non-positive duration (clock skew or malformed timestamps)", () => {
    const seconds = checkRunDurationSeconds({
      conclusion: "success",
      started_at: "2026-01-01T00:02:05Z",
      completed_at: "2026-01-01T00:00:00Z",
    });

    expect(seconds).toBeNull();
  });
});

describe("estimateFromSamples", () => {
  it("returns null with no samples", () => {
    expect(estimateFromSamples([], NOW)).toBeNull();
  });

  it("returns the sample itself with zero spread for a single sample", () => {
    expect(estimateFromSamples([sample(125)], NOW)).toEqual({ seconds: 125, etaSeconds: 125, n: 1, spreadSeconds: 0 });
  });

  it("ignores non-positive durations when counting samples", () => {
    expect(estimateFromSamples([sample(0), sample(-5), sample(100)], NOW)).toEqual({
      seconds: 100,
      etaSeconds: 100,
      n: 1,
      spreadSeconds: 0,
    });
  });

  it("resists a slow-run outlier that would wreck a mean", () => {
    // mean of these is 168s; the median stays where the check actually lives —
    // and with the outlier at only 1/5 of the pool, so does the p70 eta
    const estimate = estimateFromSamples([sample(60), sample(60), sample(60), sample(600), sample(60)], NOW);

    expect(estimate).toEqual({ seconds: 60, etaSeconds: 60, n: 5, spreadSeconds: 0 });
  });

  it("lets a fresh run outweigh stale history (exponential age weighting)", () => {
    // the 600s run is 21 days old = three half-lives, so it carries 1/8 the weight
    // of yesterday's 60s run — the estimate tracks the recent past, not the mean (330s)
    const estimate = estimateFromSamples([sample(600, 21), sample(60, 1)], NOW);

    expect(estimate).toEqual({ seconds: 60, etaSeconds: 60, n: 2, spreadSeconds: 0 });
  });

  it("counts a sample a half-life old as half a fresh one", () => {
    // equal weighting would put the median at the 100s sample; the 7-day-old
    // run's 0.5 weight lets the fresh 200s sample own the median instead
    const estimate = estimateFromSamples([sample(100, 7), sample(200, 0)], NOW);

    expect(estimate).toEqual({ seconds: 200, etaSeconds: 200, n: 2, spreadSeconds: 50 });
  });

  it("reports the interquartile spread so a noisy history reads as ±wide", () => {
    const estimate = estimateFromSamples([sample(60), sample(90), sample(120), sample(150)], NOW);

    // p25=60, median=90, p75=120 -> ±30 around 90
    expect(estimate).toEqual({ seconds: 90, etaSeconds: 120, n: 4, spreadSeconds: 30 });
  });

  it("quotes a p70 above the median once slow runs are common enough to be normal", () => {
    // 6 runs at 60s, 4 cache-cold runs at 600s: the median (and the bar) stay at 60,
    // but 40% of real runs blow past it, so the p70 countdown lands in the slow mode
    const estimate = estimateFromSamples(
      [sample(60), sample(60), sample(60), sample(60), sample(60), sample(60), sample(600), sample(600), sample(600), sample(600)],
      NOW,
    );

    expect(estimate).toEqual({ seconds: 60, etaSeconds: 600, n: 10, spreadSeconds: 270 });
  });

  it("moves the eta into the slow mode of a bimodal history while the median stays in the fast one", () => {
    // half cache-hit runs (60s), half cache-miss runs (400s): the median lands in
    // the fast mode, but 50% of runs really take 400s — p70 quotes the slow mode
    const estimate = estimateFromSamples([sample(60), sample(60), sample(60), sample(60), sample(60), sample(400), sample(400), sample(400), sample(400), sample(400)], NOW);

    expect(estimate).toEqual({ seconds: 60, etaSeconds: 400, n: 10, spreadSeconds: 170 });
  });
});
