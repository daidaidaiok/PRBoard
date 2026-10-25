import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/runner-monitor.tsx"), "utf8");

describe("runner monitor host capacity integration", () => {
  it("keeps host capacity visible even when the GitHub Runner state is a separate request", () => {
    expect(source).toContain('from "@/components/host-capacity-monitor"');
    expect(source).toContain("<HostCapacityMonitor />");
  });

  it("polls at the 300s fallback cadence instead of the old 30s", () => {
    expect(source).toContain("POLL_INTERVAL_MS = 300_000");
  });
});

describe("runner monitor automatic refresh", () => {
  it("subscribes to the shared SSE stream with its own throttle window", () => {
    expect(source).toContain('new EventSource("/api/events")');
    expect(source).toContain("RUNNER_SSE_MIN_REFRESH_MS = 60_000");
    expect(source).toContain("shouldRefreshOnAnyEvent");
  });

  it("refreshes when the tab becomes visible again after going stale", () => {
    expect(source).toContain('"visibilitychange"');
    expect(source).toContain("VISIBILITY_STALE_MS = 30_000");
  });

  it("keeps the fixed poll as the fallback trigger", () => {
    expect(source).toContain("setInterval");
  });
});

describe("runner monitor active jobs section", () => {
  it("fetches the active-jobs aggregate alongside the runner list", () => {
    expect(source).toContain('fetchWithTimeout("/api/runners/active"');
    expect(source).toContain("groupActiveJobsByHost");
  });

  it("renders the 进行中/排队中 section with host capacity and performance", () => {
    expect(source).toContain("进行中 / 排队中");
    expect(source).toContain("等待空闲 Runner");
    // Host performance chips must render from the host snapshot, not just the name.
    expect(source).toContain("host.cpuUsageBasisPoints");
  });
});
