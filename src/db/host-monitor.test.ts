import { drizzle } from "drizzle-orm/postgres-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// host-monitor.ts imports ./index (the drizzle client), which throws without a
// live DATABASE_URL — same treatment as dashboard-snapshot.test.ts, except the
// mock is a real drizzle query builder over a fake client: toSQL() compiles
// without connecting, and individual queries can be spied per call.
vi.mock("./index", () => ({ db: drizzle.mock(), getPgClient: vi.fn() }));

import { db } from "./index";
import {
  buildBucketQuery,
  getActiveHostSnapshots,
  listMonitorCapacityDomains,
  toCapacityMetric,
} from "./host-monitor";
import { monitorHosts } from "./schema";

const NOW = new Date("2026-10-01T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;
const BUCKET_MS = 15 * 60_000;
const HOST_ID = "8f14e45f-ea5b-4a1d-9b1c-000000000001";

/** Chainable thenable query builder stub: every link returns itself, await resolves to rows. */
function chainTo(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "groupBy", "limit", "offset"]) {
    builder[method] = () => builder;
  }
  builder.then = (onFulfilled: (value: unknown[]) => unknown, onRejected: (reason?: unknown) => unknown) =>
    Promise.resolve(rows).then(onFulfilled, onRejected);
  builder.catch = (onRejected: (reason?: unknown) => unknown) => Promise.resolve(rows).catch(onRejected);
  builder.finally = (onFinally: () => void) => Promise.resolve(rows).finally(onFinally);
  return builder;
}

function hostRowFixture() {
  return {
    id: HOST_ID,
    userId: 7,
    displayName: "Windows 主机",
    platform: "windows",
    capacityDomain: "windows-wsl",
    capacityRole: "primary",
    runnerName: null,
    runnerCpuReserveMilliCores: 2000,
    runnerMemoryReserveMib: 4096,
    lastSeenAt: new Date(NOW.getTime() - 60_000),
    createdAt: new Date(NOW.getTime() - 48 * DAY_MS),
  } satisfies typeof monitorHosts.$inferSelect;
}

/**
 * Postgres text format for timestamptz — exactly what the driver hands back
 * for the raw `date_bin()` expression (drizzle only maps table columns to
 * Date, not raw sql fragments; see the 2026-10-02 "host capacity unavailable"
 * regression this format guards against).
 */
function bucketStartString(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}+00`;
}

/** One aggregated 15-minute bucket row, as it comes back from the SQL GROUP BY. */
function bucketRowFixture(index: number) {
  return {
    hostId: HOST_ID,
    bucketStart: bucketStartString(NOW.getTime() - DAY_MS + index * BUCKET_MS),
    sampleCount: 4,
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
    load1Milli: 0,
  };
}

/** The newest raw host_metric_samples row, as select distinct on returns it. */
function latestRowFixture() {
  return {
    id: 99,
    hostId: HOST_ID,
    capturedAt: new Date(NOW.getTime() - 60_000),
    cpuUsageBasisPoints: 3_100,
    logicalCpuCores: 8,
    memoryTotalMib: 32_768,
    memoryUsedMib: 12_500,
    diskTotalMib: 512_000,
    diskUsedMib: 150_000,
    swapTotalMib: 8_192,
    swapUsedMib: 0,
    networkRxBytesPerSecond: 2_000,
    networkTxBytesPerSecond: 800,
    runnerListenerCount: 1,
    runnerWorkerCount: 1,
    load1Milli: 2_500,
    receivedAt: new Date(NOW.getTime() - 60_000),
  };
}

describe("buildBucketQuery", () => {
  it("aggregates into 15-minute date_bin buckets with explicit casts, grouped by host and bucket", () => {
    const windowStart = new Date(NOW.getTime() - DAY_MS);
    const { sql, params } = buildBucketQuery([HOST_ID], windowStart).toSQL();

    // The bucket width is a hardcoded literal (no user input can reach it),
    // while the window bound goes through a bound parameter.
    expect(sql).toContain("date_bin(interval '15 minutes'");
    expect(sql).toContain("timestamp '2001-01-01 00:00:00+00'");
    expect((sql.match(/date_bin\(interval '15 minutes'/g) ?? []).length).toBe(2); // select + group by
    expect(sql).toContain("::int4");
    expect(sql).toContain("::float8");
    expect(sql).toContain("count(*)::int4");
    expect(sql).toContain('"host_metric_samples"."host_id"');
    // Only the host ids and the window bound are bound parameters — the bucket
    // width stays a SQL literal, so no user input can reach it. toSQL() params
    // are driver-serialized (Dates arrive as ISO strings, as over the wire).
    expect(params).toHaveLength(2);
    expect(params).toContainEqual(HOST_ID);
    expect(params).toContainEqual(windowStart.toISOString());
  });
});

describe("toCapacityMetric on an aggregated bucket row", () => {
  it("maps an aggregated bucket row onto the CapacityMetric shape", () => {
    const bucketStart = new Date("2026-10-01T10:00:00.000Z");
    // Same rename the production call site does: bucket rows carry bucketStart.
    const row = {
      hostId: HOST_ID,
      bucketStart,
      sampleCount: 4,
      cpuUsageBasisPoints: 3_200,
      logicalCpuCores: 8,
      memoryTotalMib: 32_768,
      memoryUsedMib: 12_000,
      diskTotalMib: 512_000,
      diskUsedMib: 150_000,
      swapTotalMib: 8_192,
      swapUsedMib: 1_024,
      networkRxBytesPerSecond: 1_234.5,
      networkTxBytesPerSecond: 567.25,
      runnerListenerCount: 1,
      runnerWorkerCount: 2,
      load1Milli: 2_500,
    };
    const metric = toCapacityMetric({ ...row, capturedAt: row.bucketStart });

    expect(metric.hostId).toBe(HOST_ID);
    expect(metric.capturedAt).toEqual(bucketStart);
    expect(metric.cpuUsageBasisPoints).toBe(3_200);
    expect(metric.logicalCpuCores).toBe(8);
    expect(metric.memoryUsedMib).toBe(12_000);
    expect(metric.diskUsedMib).toBe(150_000);
    expect(metric.swapUsedMib).toBe(1_024);
    expect(metric.networkRxBytesPerSecond).toBe(1_234.5);
    expect(metric.networkTxBytesPerSecond).toBe(567.25);
    expect(metric.runnerListenerCount).toBe(1);
    expect(metric.runnerWorkerCount).toBe(2);
    expect(metric.load1).toBe(2.5);
  });

  it("maps a bucket with no load samples to a null load1", () => {
    const bucketStart = new Date("2026-10-01T10:00:00.000Z");
    const row = {
      hostId: HOST_ID,
      bucketStart,
      sampleCount: 4,
      cpuUsageBasisPoints: 3_200,
      logicalCpuCores: 8,
      memoryTotalMib: 32_768,
      memoryUsedMib: 12_000,
      diskTotalMib: 512_000,
      diskUsedMib: 150_000,
      swapTotalMib: 8_192,
      swapUsedMib: 1_024,
      networkRxBytesPerSecond: 1_234.5,
      networkTxBytesPerSecond: 567.25,
      runnerListenerCount: 1,
      runnerWorkerCount: 2,
      load1Milli: null,
    };
    const metric = toCapacityMetric({ ...row, capturedAt: row.bucketStart });

    expect(metric.load1).toBeNull();
  });
});

describe("listMonitorCapacityDomains", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns no domains and stops after the hosts query when the user has no hosts", async () => {
    const selectSpy = vi.spyOn(db, "select") as unknown as Mock;
    const distinctSpy = vi.spyOn(db, "selectDistinctOn") as unknown as Mock;
    selectSpy.mockImplementationOnce(() => chainTo([]));

    const domains = await listMonitorCapacityDomains(7, NOW);

    expect(domains).toEqual([]);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(distinctSpy).not.toHaveBeenCalled();
  });

  it("merges SQL bucket aggregates with the latest raw row and scores coverage against 96 buckets", async () => {
    // 95 bucket rows + 1 latest raw row = 96 metrics, exactly one expected
    // bucket per 15 minutes across the 24h window.
    const buckets = Array.from({ length: 95 }, (_, index) => bucketRowFixture(index));
    const latest = latestRowFixture();

    const selectSpy = vi.spyOn(db, "select") as unknown as Mock;
    const distinctSpy = vi.spyOn(db, "selectDistinctOn") as unknown as Mock;
    selectSpy.mockImplementationOnce(() => chainTo([hostRowFixture()]));
    selectSpy.mockImplementationOnce(() => chainTo(buckets));
    distinctSpy.mockImplementationOnce(() => chainTo([latest]));

    const [domain] = await listMonitorCapacityDomains(7, NOW);

    expect(domain.capacityDomain).toBe("windows-wsl");
    const [entry] = domain.hosts;
    expect(entry.sampleCount).toBe(96);
    // Bucket rows arrive with string bucketStart (see bucketStartString) — the
    // merge must convert them, or buildCapacityDomains crashes on .getTime.
    expect(entry.hourly).toHaveLength(24);
    expect(entry.hourly[0].capturedAt).toBeInstanceOf(Date);
    expect(entry.latestMetric?.capturedAt).toBeInstanceOf(Date);
    // latestMetric comes from the select-distinct-on raw row (11:59), not from
    // the newest bucket (11:30) — its load1 of 2.5 only exists on the raw row.
    expect(entry.latestMetric?.capturedAt.getTime()).toBe(latest.capturedAt.getTime());
    expect(entry.latestMetric?.load1).toBe(2.5);
    expect(domain.dataCoverageBasisPoints).toBe(10_000);
  });
});

describe("getActiveHostSnapshots", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function hostWithRunner(overrides: Partial<typeof monitorHosts.$inferSelect> = {}) {
    return {
      ...hostRowFixture(),
      displayName: "Windows 工作站",
      runnerName: "windows-runner",
      ...overrides,
    } satisfies typeof monitorHosts.$inferSelect;
  }

  it("returns an empty map without querying when no runner names are given", async () => {
    const selectSpy = vi.spyOn(db, "select") as unknown as Mock;

    expect((await getActiveHostSnapshots(7, [], NOW)).size).toBe(0);
    expect((await getActiveHostSnapshots(7, [null as unknown as string], NOW)).size).toBe(0);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("joins hosts by runner name with their latest metric and staleness", async () => {
    const host = hostWithRunner({ lastSeenAt: new Date(NOW.getTime() - 60_000) });
    const staleHost = hostWithRunner({ id: "8f14e45f-ea5b-4a1d-9b1c-000000000002", runnerName: "wsl-runner", lastSeenAt: new Date(NOW.getTime() - 10 * 60_000) });
    const latestRow = { ...latestRowFixture(), hostId: host.id };

    const selectSpy = vi.spyOn(db, "select") as unknown as Mock;
    const distinctSpy = vi.spyOn(db, "selectDistinctOn") as unknown as Mock;
    selectSpy.mockImplementationOnce(() => chainTo([host, staleHost]));
    distinctSpy.mockImplementationOnce(() => chainTo([latestRow]));

    const snapshots = await getActiveHostSnapshots(7, ["windows-runner", "wsl-runner"], NOW);

    expect(snapshots.size).toBe(2);
    const fresh = snapshots.get("windows-runner");
    expect(fresh?.host.displayName).toBe("Windows 工作站");
    expect(fresh?.stale).toBe(false);
    expect(fresh?.latestMetric?.load1).toBe(2.5);
    expect(snapshots.get("wsl-runner")?.stale).toBe(true);
    expect(snapshots.get("wsl-runner")?.latestMetric).toBeNull();
  });
});
