import { describe, expect, it } from "vitest";
import { computeCheckProgress, computePrProgress, formatDurationSeconds } from "./progress";
import { makeCheckItem } from "./test-helpers";

const NOW = Date.parse("2026-01-01T00:01:00Z"); // 60s after the baseline startedAt below
const STARTED_AT = "2026-01-01T00:00:00Z";

/** Shorthand estimate with sane defaults — spread 0 / n 4 keeps the aggregate tests focused on time math.
 * `etaSeconds` defaults to `seconds` (no right skew), so only the p70-specific tests need to pass it. */
function est(seconds: number, n = 4, spreadSeconds = 0, etaSeconds = seconds) {
  return { seconds, etaSeconds, n, spreadSeconds };
}

function runningCheck(overrides: Parameters<typeof makeCheckItem>[0] = {}) {
  return makeCheckItem({
    status: "in_progress",
    startedAt: STARTED_AT,
    durationEstimate: { seconds: 120, etaSeconds: 120, n: 6, spreadSeconds: 10 },
    ...overrides,
  });
}

describe("computeCheckProgress", () => {
  it("computes elapsed/estimated/percent for an in-progress check with history", () => {
    const progress = computeCheckProgress(runningCheck(), NOW);

    expect(progress).toEqual({ elapsedSeconds: 60, estimatedSeconds: 120, spreadSeconds: 10, sampleCount: 6, percent: 50 });
  });

  it("caps percent short of 100 even if elapsed exceeds the estimate", () => {
    const progress = computeCheckProgress(runningCheck({ durationEstimate: { seconds: 10, etaSeconds: 10, n: 6, spreadSeconds: 10 } }), NOW);

    expect(progress?.percent).toBe(97);
  });

  it("returns null for a status check (no reliable startedAt)", () => {
    expect(computeCheckProgress(runningCheck({ kind: "status" }), NOW)).toBeNull();
  });

  it("returns null when not in_progress", () => {
    expect(computeCheckProgress(runningCheck({ status: "completed" }), NOW)).toBeNull();
  });

  it("returns null when there's no history to estimate from", () => {
    expect(computeCheckProgress(runningCheck({ durationEstimate: null }), NOW)).toBeNull();
  });

  it("returns null when the estimate is zero (a fast check that rounded down to 0s)", () => {
    expect(computeCheckProgress(runningCheck({ durationEstimate: { seconds: 0, etaSeconds: 0, n: 6, spreadSeconds: 0 } }), NOW)).toBeNull();
  });

  it("returns null when startedAt is missing", () => {
    expect(computeCheckProgress(runningCheck({ startedAt: null }), NOW)).toBeNull();
  });
});

describe("computePrProgress", () => {
  it("returns null when no check has any history", () => {
    expect(computePrProgress([makeCheckItem({ durationEstimate: null })], NOW)).toBeNull();
  });

  it("reaches a genuine 100% once every check with history has completed", () => {
    const progress = computePrProgress([makeCheckItem({ status: "completed", durationEstimate: est(100) })], NOW);

    expect(progress).toEqual({
      percent: 100,
      elapsedTotalSeconds: 100,
      estimatedTotalSeconds: 100,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 0,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 0,
    });
  });

  it("gives full credit to a completed check's own share when its actual duration is unknown (no completedAt)", () => {
    const progress = computePrProgress(
      [makeCheckItem({ id: "a", status: "completed", durationEstimate: est(100) }), runningCheck({ id: "b", durationEstimate: est(100) })],
      NOW,
    );

    // a has no completedAt, so its actual duration can't be measured — it falls back to its
    // full estimated share; b (in_progress) contributes 60/100 elapsed -> (100+60)/200 = 80%
    expect(progress).toEqual({
      percent: 80,
      elapsedTotalSeconds: 160,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 40,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 4,
    });
  });

  it("counts a completed check's actual duration when completedAt is known", () => {
    const progress = computePrProgress(
      [
        makeCheckItem({
          id: "a",
          status: "completed",
          durationEstimate: est(100),
          startedAt: "2026-01-01T00:00:00Z",
          completedAt: "2026-01-01T00:00:30Z", // actually ran 30s against a 100s estimate
        }),
        runningCheck({ id: "b", durationEstimate: est(100) }),
      ],
      NOW,
    );

    // a contributes its real 30s; b contributes 60s -> (30+60)/200 = 45%
    expect(progress).toEqual({
      percent: 45,
      elapsedTotalSeconds: 90,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 40,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 4,
    });
  });

  it("still caps at 97% when completed checks' actual durations blow past the estimate total", () => {
    const progress = computePrProgress(
      [
        makeCheckItem({
          id: "a",
          status: "completed",
          durationEstimate: est(100),
          startedAt: "2025-12-31T23:55:00Z",
          completedAt: "2025-12-31T23:58:10Z", // actually ran 190s against a 100s estimate
        }),
        runningCheck({ id: "b", durationEstimate: est(100) }),
      ],
      NOW,
    );

    // (190+60)/200 = 125% raw, capped while b is still running
    expect(progress).toEqual({
      percent: 97,
      elapsedTotalSeconds: 250,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 40,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 4,
    });
  });

  it("falls back to the estimate when a completed check's timestamps are unusable", () => {
    const progress = computePrProgress(
      [
        makeCheckItem({
          id: "a",
          status: "completed",
          durationEstimate: est(100),
          startedAt: STARTED_AT,
          completedAt: "not-a-date",
        }),
        makeCheckItem({
          id: "b",
          status: "completed",
          durationEstimate: est(100),
          startedAt: STARTED_AT,
          completedAt: "2025-12-31T23:59:00Z", // before startedAt — nonsense
        }),
      ],
      NOW,
    );

    expect(progress).toEqual({
      percent: 100,
      elapsedTotalSeconds: 200,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 0,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 0,
    });
  });

  it("counts a not-yet-started check's estimate in the denominator with zero elapsed, capped short of 100 while it's still pending", () => {
    const progress = computePrProgress(
      [makeCheckItem({ id: "a", status: "completed", durationEstimate: est(100) }), makeCheckItem({ id: "b", status: "queued", durationEstimate: est(100) })],
      NOW,
    );

    // a contributes 100/100 elapsed, b contributes 0/100 elapsed -> 100/200 = 50%
    expect(progress).toEqual({
      percent: 50,
      elapsedTotalSeconds: 100,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 100, // queued check: full estimate still outstanding
      remainingSpreadSeconds: 0,
      remainingSampleCount: 4,
    });
  });

  it("caps an individual in-progress check's contribution at its own estimate", () => {
    const progress = computePrProgress(
      [runningCheck({ durationEstimate: est(10) })],
      NOW, // 60s elapsed against a 10s estimate
    );

    expect(progress).toEqual({
      percent: 97,
      elapsedTotalSeconds: 10,
      estimatedTotalSeconds: 10,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 0, // overran even its p70 mark — reads as "any moment now"
      remainingSpreadSeconds: 0,
      remainingSampleCount: 0,
    });
  });

  it("counts down from the p70 estimate, not the median", () => {
    // 60s elapsed against a 100s median / 140s p70: the bar advances on the median
    // (60%), but the countdown quotes 140−60 = 80s so a right-skewed check doesn't
    // read as "any moment" the moment it crosses its median
    const progress = computePrProgress([runningCheck({ durationEstimate: est(100, 4, 10, 140) })], NOW);

    expect(progress).toEqual({
      percent: 60,
      elapsedTotalSeconds: 60,
      estimatedTotalSeconds: 100,
      spreadTotalSeconds: 10,
      sampleCount: 4,
      remainingSeconds: 80,
      remainingSpreadSeconds: 10,
      remainingSampleCount: 4,
    });
  });

  it("carries p70 into a queued check's full outstanding estimate", () => {
    const progress = computePrProgress(
      [makeCheckItem({ id: "a", status: "queued", durationEstimate: est(100, 4, 10, 180) })],
      NOW,
    );

    // nothing elapsed yet; the queued check bounds the finish at its p70, not its median
    expect(progress).toEqual({
      percent: 0,
      elapsedTotalSeconds: 0,
      estimatedTotalSeconds: 100,
      spreadTotalSeconds: 10,
      sampleCount: 4,
      remainingSeconds: 180,
      remainingSpreadSeconds: 10,
      remainingSampleCount: 4,
    });
  });

  it("skips status checks and checks with no history entirely", () => {
    const progress = computePrProgress(
      [
        makeCheckItem({ id: "a", status: "completed", durationEstimate: est(100) }),
        makeCheckItem({ id: "b", kind: "status", durationEstimate: null, status: "completed" }),
        makeCheckItem({ id: "c", durationEstimate: null }),
      ],
      NOW,
    );

    expect(progress).toEqual({
      percent: 100,
      elapsedTotalSeconds: 100,
      estimatedTotalSeconds: 100,
      spreadTotalSeconds: 0,
      sampleCount: 4,
      remainingSeconds: 0,
      remainingSpreadSeconds: 0,
      remainingSampleCount: 0,
    });
  });

  it("combines per-check spreads as independent variances and reports the smallest sample count", () => {
    const progress = computePrProgress(
      [
        makeCheckItem({ id: "a", status: "completed", durationEstimate: est(100, 10, 30) }),
        runningCheck({ id: "b", durationEstimate: est(100, 2, 40) }),
      ],
      NOW,
    );

    // 80% like the plain case; sqrt(30² + 40²) = 50; the n=2 check is the weak link
    expect(progress).toEqual({
      percent: 80,
      elapsedTotalSeconds: 160,
      estimatedTotalSeconds: 200,
      spreadTotalSeconds: 50,
      sampleCount: 2,
      remainingSeconds: 40, // b has 40s left and is the slowest outstanding check
      remainingSpreadSeconds: 40,
      remainingSampleCount: 2,
    });
  });

  it("estimates remaining wall time from the slowest outstanding check, not the sum", () => {
    const progress = computePrProgress(
      [
        runningCheck({ id: "a", durationEstimate: est(100) }), // 50s elapsed, 50s left
        makeCheckItem({ id: "b", status: "queued", durationEstimate: est(300, 2, 60) }),
      ],
      Date.parse("2026-01-01T00:00:50Z"), // 50s after STARTED_AT
    );

    // parallel execution: the queued 300s check bounds the finish, even though
    // the work-unit sum is 400s and the running check finishes sooner
    expect(progress).toEqual({
      percent: 12.5,
      elapsedTotalSeconds: 50,
      estimatedTotalSeconds: 400,
      spreadTotalSeconds: 60,
      sampleCount: 2,
      remainingSeconds: 300,
      remainingSpreadSeconds: 60,
      remainingSampleCount: 2,
    });
  });
});

describe("formatDurationSeconds", () => {
  it("formats under a minute as seconds", () => {
    expect(formatDurationSeconds(45)).toBe("45s");
  });

  it("formats a minute and change", () => {
    expect(formatDurationSeconds(90)).toBe("1m30s");
  });

  it("pads seconds under 10", () => {
    expect(formatDurationSeconds(65)).toBe("1m05s");
  });

  it("floors negative input at zero", () => {
    expect(formatDurationSeconds(-5)).toBe("0s");
  });
});
