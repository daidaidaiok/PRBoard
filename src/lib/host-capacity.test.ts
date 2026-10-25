import { describe, expect, it } from "vitest";
import {
  buildCapacityDomains,
  type CapacityHost,
  type CapacityMetric,
} from "./host-capacity";

const NOW = new Date("2026-09-07T12:00:00.000Z");

function host(overrides: Partial<CapacityHost> = {}): CapacityHost {
  return {
    id: "windows-host",
    displayName: "Windows 主机",
    platform: "windows",
    capacityDomain: "windows-wsl",
    capacityRole: "primary",
    runnerName: null,
    createdAt: new Date("2026-09-06T11:00:00.000Z"),
    lastSeenAt: new Date("2026-09-07T11:59:00.000Z"),
    runnerCpuReserveMilliCores: 2000,
    runnerMemoryReserveMib: 4096,
    ...overrides,
  };
}

function metric(hostId: string, minutesAgo: number, overrides: Partial<CapacityMetric> = {}): CapacityMetric {
  return {
    hostId,
    capturedAt: new Date(NOW.getTime() - minutesAgo * 60_000),
    cpuUsageBasisPoints: 3_000,
    logicalCpuCores: 8,
    memoryTotalMib: 32_768,
    memoryUsedMib: 12_000,
    diskTotalMib: 512_000,
    diskUsedMib: 150_000,
    swapTotalMib: 8_192,
    swapUsedMib: 0,
    networkRxBytesPerSecond: 1_000,
    networkTxBytesPerSecond: 500,
    runnerListenerCount: 1,
    runnerWorkerCount: 1,
    load1: null,
    ...overrides,
  };
}

function dailyMetrics(hostId: string, overrides: Partial<CapacityMetric> = {}) {
  return Array.from({ length: 24 * 60 }, (_, index) => metric(hostId, index, overrides));
}

describe("buildCapacityDomains", () => {
  it("keeps Windows and WSL health separate but only uses the primary host for shared physical capacity", () => {
    const windows = host();
    const wsl = host({
      id: "wsl-runner",
      displayName: "Ubuntu WSL",
      platform: "linux",
      capacityRole: "shared",
    });

    const [domain] = buildCapacityDomains(
      [windows, wsl],
      [
        ...dailyMetrics(windows.id),
        ...dailyMetrics(wsl.id, {
          cpuUsageBasisPoints: 9_500,
          memoryTotalMib: 8_192,
          memoryUsedMib: 7_800,
        }),
      ],
      NOW,
    );

    expect(domain.hosts.map((item) => item.host.id)).toEqual(["windows-host", "wsl-runner"]);
    expect(domain.capacitySourceHostId).toBe("windows-host");
    expect(domain.cpuP95BasisPoints).toBe(3_000);
    expect(domain.memoryP95BasisPoints).toBeLessThan(4_000);
  });

  it("treats a Worker in either member of a shared Windows/WSL domain as domain demand without double-counting capacity", () => {
    const windows = host();
    const wsl = host({ id: "wsl-runner", displayName: "Ubuntu WSL", platform: "linux", capacityRole: "shared" });

    const [domain] = buildCapacityDomains(
      [windows, wsl],
      [
        ...dailyMetrics(windows.id, { runnerWorkerCount: 0 }),
        ...dailyMetrics(wsl.id, { runnerWorkerCount: 1 }),
      ],
      NOW,
    );

    expect(domain.runnerBusyBasisPoints).toBe(10_000);
    expect(domain.recommendation.kind).toBe("add-canary");
  });

  it("asks to keep observing until it has a full day of adequately covered samples", () => {
    const [domain] = buildCapacityDomains([host({ createdAt: new Date("2026-09-07T10:00:00.000Z") })], [metric("windows-host", 1)], NOW);

    expect(domain.recommendation.kind).toBe("collecting");
    expect(domain.recommendation.additionalRunners).toBe(0);
  });

  it("compresses minute-level samples into ordered hourly points for the 24-hour dashboard", () => {
    const [domain] = buildCapacityDomains([host()], dailyMetrics("windows-host"), NOW);

    expect(domain.hosts[0].hourly).toHaveLength(24);
    expect(domain.hosts[0].hourly[0]).toMatchObject({
      cpuUsageBasisPoints: 3_000,
      memoryUsageBasisPoints: expect.any(Number),
      runnerBusy: true,
    });
    expect(domain.hosts[0].hourly.map((point) => point.capturedAt.getTime())).toEqual(
      [...domain.hosts[0].hourly]
        .sort((left, right) => left.capturedAt.getTime() - right.capturedAt.getTime())
        .map((point) => point.capturedAt.getTime()),
    );
  });

  it("blocks expansion when a capacity source has disk or swap pressure", () => {
    const [domain] = buildCapacityDomains(
      [host()],
      dailyMetrics("windows-host", { diskUsedMib: 450_000, swapUsedMib: 2_000, runnerWorkerCount: 1 }),
      NOW,
    );

    expect(domain.recommendation.kind).toBe("hold");
    expect(domain.recommendation.additionalRunners).toBe(0);
  });

  it("does not recommend growth only because resources are idle when Runner workers are rarely busy", () => {
    const samples = dailyMetrics("windows-host", { runnerWorkerCount: 0 });
    samples[0] = metric("windows-host", 0, { runnerWorkerCount: 1 });

    const [domain] = buildCapacityDomains([host()], samples, NOW);

    expect(domain.recommendation.kind).toBe("headroom-without-demand");
    expect(domain.recommendation.additionalRunners).toBe(0);
  });

  it("recommends exactly one canary Runner when a full day is busy and has conservative CPU and memory headroom", () => {
    const [domain] = buildCapacityDomains([host()], dailyMetrics("windows-host"), NOW);

    expect(domain.recommendation.kind).toBe("add-canary");
    expect(domain.recommendation.additionalRunners).toBe(1);
    expect(domain.recommendation.reason).toContain("canary");
  });
});

describe("buildCapacityDomains with downsampling options", () => {
  const BUCKET_MS = 900_000;

  it("keeps a bucket straddling the window start when bucketMs widens the window", () => {
    // The SQL-side 15-minute bucket whose samples fall inside the 24h window
    // has a bucketStart up to one bucket width before the window start.
    const straddling = metric("windows-host", 24 * 60 + 5);
    const beyondOneBucket = metric("windows-host", 24 * 60 + 20);

    const [domain] = buildCapacityDomains([host()], [straddling], NOW, {
      bucketMs: BUCKET_MS,
      expectedDailySamples: 96,
    });
    const [narrow] = buildCapacityDomains([host()], [beyondOneBucket], NOW, {
      bucketMs: BUCKET_MS,
      expectedDailySamples: 96,
    });

    expect(domain.hosts[0].sampleCount).toBe(1);
    expect(narrow.hosts[0].sampleCount).toBe(0);
  });

  it("computes coverage against expectedDailySamples so a full day of buckets reads as 100%", () => {
    const buckets = Array.from({ length: 96 }, (_, index) => metric("windows-host", index * 15));
    const [domain] = buildCapacityDomains([host()], buckets, NOW, {
      bucketMs: BUCKET_MS,
      expectedDailySamples: 96,
    });

    expect(domain.dataCoverageBasisPoints).toBe(10_000);
  });

  it("keeps the minute-level window and 1440 coverage when no options are passed", () => {
    const outside = metric("windows-host", 24 * 60 + 5);
    const [domain] = buildCapacityDomains([host()], [outside], NOW);
    expect(domain.hosts[0].sampleCount).toBe(0);

    const rows = Array.from({ length: 96 }, (_, index) => metric("windows-host", index * 15));
    const [legacy] = buildCapacityDomains([host()], rows, NOW);
    expect(legacy.dataCoverageBasisPoints).toBe(667); // 96 / 1440
  });
});
