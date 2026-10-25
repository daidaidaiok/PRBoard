import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { buildCapacityDomains, isHostStale, type CapacityHost, type CapacityMetric } from "@/lib/host-capacity";
import { hashIngestToken, matchesIngestToken, newIngestToken } from "@/lib/host-ingest-auth";
import { db } from "./index";
import { hostMetricSamples, monitorHostIngestTokens, monitorHosts } from "./schema";

const DAILY_WINDOW_MS = 24 * 60 * 60 * 1_000;
// Aggregation bucket width for listMonitorCapacityDomains. Must stay in sync
// with the `interval '15 minutes'` literal inside buildBucketQuery — SQL cannot
// read this constant, so a mismatch would silently change the effective bucket
// width that buildCapacityDomains assumes (window widening + coverage).
const METRIC_BUCKET_MS = 15 * 60_000;
const RETENTION_MS = 30 * DAILY_WINDOW_MS;
const MIN_METRIC_INTERVAL_MS = 30 * 1_000;

export type MonitorHostPlatform = CapacityHost["platform"];
export type MonitorHostCapacityRole = CapacityHost["capacityRole"];

export interface CreateMonitorHostInput {
  displayName: string;
  platform: MonitorHostPlatform;
  capacityDomain: string;
  capacityRole: MonitorHostCapacityRole;
  runnerName: string | null;
  runnerCpuReserveMilliCores: number;
  runnerMemoryReserveMib: number;
}

export interface HostMetricInput {
  capturedAt: Date;
  cpuUsageBasisPoints: number;
  logicalCpuCores: number;
  memoryTotalMib: number;
  memoryUsedMib: number;
  diskTotalMib: number;
  diskUsedMib: number;
  swapTotalMib: number;
  swapUsedMib: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  runnerListenerCount: number;
  runnerWorkerCount: number;
  load1: number | null;
}

export interface AuthenticatedMonitorHost {
  hostId: string;
  userId: number;
  tokenId: string;
}

function toCapacityHost(row: typeof monitorHosts.$inferSelect): CapacityHost {
  return {
    id: row.id,
    displayName: row.displayName,
    platform: row.platform,
    capacityDomain: row.capacityDomain,
    capacityRole: row.capacityRole,
    runnerName: row.runnerName,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    runnerCpuReserveMilliCores: row.runnerCpuReserveMilliCores,
    runnerMemoryReserveMib: row.runnerMemoryReserveMib,
  };
}

/** Metric fields both raw sample rows and aggregated bucket rows carry. */
type CapacityMetricRow = Pick<
  typeof hostMetricSamples.$inferSelect,
  | "capturedAt"
  | "cpuUsageBasisPoints"
  | "logicalCpuCores"
  | "memoryTotalMib"
  | "memoryUsedMib"
  | "diskTotalMib"
  | "diskUsedMib"
  | "swapTotalMib"
  | "swapUsedMib"
  | "networkRxBytesPerSecond"
  | "networkTxBytesPerSecond"
  | "runnerListenerCount"
  | "runnerWorkerCount"
  | "load1Milli"
> & { hostId: string };

export function toCapacityMetric(row: CapacityMetricRow): CapacityMetric {
  return {
    hostId: row.hostId,
    capturedAt: row.capturedAt,
    cpuUsageBasisPoints: row.cpuUsageBasisPoints,
    logicalCpuCores: row.logicalCpuCores,
    memoryTotalMib: row.memoryTotalMib,
    memoryUsedMib: row.memoryUsedMib,
    diskTotalMib: row.diskTotalMib,
    diskUsedMib: row.diskUsedMib,
    swapTotalMib: row.swapTotalMib,
    swapUsedMib: row.swapUsedMib,
    networkRxBytesPerSecond: row.networkRxBytesPerSecond,
    networkTxBytesPerSecond: row.networkTxBytesPerSecond,
    runnerListenerCount: row.runnerListenerCount,
    runnerWorkerCount: row.runnerWorkerCount,
    load1: row.load1Milli === null ? null : row.load1Milli / 1_000,
  };
}

export async function createMonitorHost(userId: number, input: CreateMonitorHostInput) {
  const hostId = randomUUID();
  const token = newIngestToken();
  const now = new Date();
  return db.transaction(async (tx) => {
    const [host] = await tx
      .insert(monitorHosts)
      .values({
        id: hostId,
        userId,
        displayName: input.displayName,
        platform: input.platform,
        capacityDomain: input.capacityDomain,
        capacityRole: input.capacityRole,
        runnerName: input.runnerName,
        runnerCpuReserveMilliCores: input.runnerCpuReserveMilliCores,
        runnerMemoryReserveMib: input.runnerMemoryReserveMib,
        createdAt: now,
      })
      .returning();
    await tx.insert(monitorHostIngestTokens).values({
      id: randomUUID(),
      hostId,
      tokenHash: hashIngestToken(token),
      createdAt: now,
    });
    return { host: toCapacityHost(host), token };
  });
}

export async function deleteMonitorHost(userId: number, hostId: string): Promise<boolean> {
  const deleted = await db
    .delete(monitorHosts)
    .where(and(eq(monitorHosts.id, hostId), eq(monitorHosts.userId, userId)))
    .returning({ id: monitorHosts.id });
  return deleted.length === 1;
}

export async function authenticateMonitorHost(hostId: string, token: string): Promise<AuthenticatedMonitorHost | null> {
  const rows = await db
    .select({
      tokenId: monitorHostIngestTokens.id,
      tokenHash: monitorHostIngestTokens.tokenHash,
      hostId: monitorHosts.id,
      userId: monitorHosts.userId,
    })
    .from(monitorHostIngestTokens)
    .innerJoin(monitorHosts, eq(monitorHostIngestTokens.hostId, monitorHosts.id))
    .where(and(eq(monitorHostIngestTokens.hostId, hostId), isNull(monitorHostIngestTokens.revokedAt)));

  let match: typeof rows[number] | null = null;
  for (const row of rows) {
    if (matchesIngestToken(token, row.tokenHash)) match = row;
  }
  if (!match) return null;
  await db.update(monitorHostIngestTokens).set({ lastUsedAt: new Date() }).where(eq(monitorHostIngestTokens.id, match.tokenId));
  return { hostId: match.hostId, userId: match.userId, tokenId: match.tokenId };
}

export async function recordHostMetric(hostId: string, metric: HostMetricInput, now = new Date()): Promise<"accepted" | "duplicate" | "rate-limited"> {
  return db.transaction(async (tx) => {
    const [latest] = await tx
      .select({ capturedAt: hostMetricSamples.capturedAt })
      .from(hostMetricSamples)
      .where(eq(hostMetricSamples.hostId, hostId))
      .orderBy(desc(hostMetricSamples.capturedAt))
      .limit(1);
    if (
      latest &&
      latest.capturedAt.getTime() !== metric.capturedAt.getTime() &&
      metric.capturedAt.getTime() - latest.capturedAt.getTime() < MIN_METRIC_INTERVAL_MS
    ) {
      return "rate-limited";
    }

    const inserted = await tx
      .insert(hostMetricSamples)
      .values({
        hostId,
        capturedAt: metric.capturedAt,
        cpuUsageBasisPoints: metric.cpuUsageBasisPoints,
        logicalCpuCores: metric.logicalCpuCores,
        memoryTotalMib: metric.memoryTotalMib,
        memoryUsedMib: metric.memoryUsedMib,
        diskTotalMib: metric.diskTotalMib,
        diskUsedMib: metric.diskUsedMib,
        swapTotalMib: metric.swapTotalMib,
        swapUsedMib: metric.swapUsedMib,
        networkRxBytesPerSecond: metric.networkRxBytesPerSecond,
        networkTxBytesPerSecond: metric.networkTxBytesPerSecond,
        runnerListenerCount: metric.runnerListenerCount,
        runnerWorkerCount: metric.runnerWorkerCount,
        load1Milli: metric.load1 === null ? null : Math.round(metric.load1 * 1_000),
        receivedAt: now,
      })
      .onConflictDoNothing({ target: [hostMetricSamples.hostId, hostMetricSamples.capturedAt] })
      .returning({ id: hostMetricSamples.id });
    await tx.update(monitorHosts).set({ lastSeenAt: now }).where(eq(monitorHosts.id, hostId));
    if (inserted.length === 0) return "duplicate";

    await tx
      .delete(hostMetricSamples)
      .where(and(eq(hostMetricSamples.hostId, hostId), lt(hostMetricSamples.capturedAt, new Date(now.getTime() - RETENTION_MS))));
    return "accepted";
  });
}

/**
 * Aggregates 24h of raw samples into per-host 15-minute buckets entirely on
 * the SQL side, so Node only receives ~96 rows per host instead of every raw
 * sample. The interval literal must stay in sync with METRIC_BUCKET_MS; the
 * origin timestamp aligns buckets to whole quarter-hours. Capacity-monitoring
 * semantics: max() for resource/runner gauges (stay conservative), avg() for
 * sustained throughput and load. Every scalar gets an explicit ::int4/::float8
 * cast — the postgres driver returns bigint/numeric aggregates as strings.
 *
 * bucketStart is typed string on purpose: drizzle only maps *table columns*
 * to Date, raw sql fragments come back as Postgres text ("2026-10-02 15:45:00+00").
 * The conversion to Date happens at the listMonitorCapacityDomains boundary.
 */
export function buildBucketQuery(hostIds: string[], windowStart: Date) {
  const bucketStart = sql`date_bin(interval '15 minutes', ${hostMetricSamples.capturedAt}, timestamp '2001-01-01 00:00:00+00')`;
  return db
    .select({
      hostId: hostMetricSamples.hostId,
      bucketStart: sql<string>`${bucketStart}`,
      sampleCount: sql<number>`count(*)::int4`,
      cpuUsageBasisPoints: sql<number>`max(${hostMetricSamples.cpuUsageBasisPoints})::int4`,
      logicalCpuCores: sql<number>`max(${hostMetricSamples.logicalCpuCores})::int4`,
      memoryTotalMib: sql<number>`max(${hostMetricSamples.memoryTotalMib})::int4`,
      memoryUsedMib: sql<number>`max(${hostMetricSamples.memoryUsedMib})::int4`,
      diskTotalMib: sql<number>`max(${hostMetricSamples.diskTotalMib})::int4`,
      diskUsedMib: sql<number>`max(${hostMetricSamples.diskUsedMib})::int4`,
      swapTotalMib: sql<number>`max(${hostMetricSamples.swapTotalMib})::int4`,
      swapUsedMib: sql<number>`max(${hostMetricSamples.swapUsedMib})::int4`,
      networkRxBytesPerSecond: sql<number>`avg(${hostMetricSamples.networkRxBytesPerSecond})::float8`,
      networkTxBytesPerSecond: sql<number>`avg(${hostMetricSamples.networkTxBytesPerSecond})::float8`,
      runnerListenerCount: sql<number>`max(${hostMetricSamples.runnerListenerCount})::int4`,
      runnerWorkerCount: sql<number>`max(${hostMetricSamples.runnerWorkerCount})::int4`,
      // A bucket where every sample has a null load1 aggregates to null.
      load1Milli: sql<number | null>`avg(${hostMetricSamples.load1Milli})::float8`,
    })
    .from(hostMetricSamples)
    .where(and(inArray(hostMetricSamples.hostId, hostIds), gte(hostMetricSamples.capturedAt, windowStart)))
    .groupBy(hostMetricSamples.hostId, bucketStart);
}

export async function listMonitorCapacityDomains(userId: number, now = new Date()) {
  const hosts = await db
    .select()
    .from(monitorHosts)
    .where(eq(monitorHosts.userId, userId))
    .orderBy(asc(monitorHosts.capacityDomain), asc(monitorHosts.displayName));
  if (hosts.length === 0) return [];

  const hostIds = hosts.map((host) => host.id);
  const windowStart = new Date(now.getTime() - DAILY_WINDOW_MS);
  // Bucket aggregates feed the 24h curve and percentiles; one distinct raw row
  // per host keeps latestMetric real-time (a bucket start can lag up to 15min).
  const [bucketRows, latestRows] = await Promise.all([
    buildBucketQuery(hostIds, windowStart),
    db
      .selectDistinctOn([hostMetricSamples.hostId])
      .from(hostMetricSamples)
      .where(and(inArray(hostMetricSamples.hostId, hostIds), gte(hostMetricSamples.capturedAt, windowStart)))
      .orderBy(asc(hostMetricSamples.hostId), desc(hostMetricSamples.capturedAt)),
  ]);

  // Raw date_bin() values arrive as Postgres text (see buildBucketQuery) —
  // convert here so buildCapacityDomains only ever sees real Dates.
  const metrics = [
    ...latestRows.map(toCapacityMetric),
    ...bucketRows.map((row) => toCapacityMetric({ ...row, capturedAt: new Date(row.bucketStart) })),
  ];
  return buildCapacityDomains(hosts.map(toCapacityHost), metrics, now, {
    bucketMs: METRIC_BUCKET_MS,
    expectedDailySamples: DAILY_WINDOW_MS / METRIC_BUCKET_MS,
  });
}

/** One host + its newest sample, keyed lookup target for active-job joins. */
export interface ActiveHostSnapshot {
  host: CapacityHost;
  latestMetric: CapacityMetric | null;
  stale: boolean;
}

/**
 * Latest per-host snapshot for the GitHub runner names currently carrying
 * active workflow jobs. Runner names are free-form labels entered when the
 * host was enrolled, so the join is exact-match; names without an enrolled
 * host simply miss (the caller renders them without host context). Null
 * names are dropped up front and duplicates deduplicated before querying.
 *
 * runnerName is not unique per user — if two hosts share one (e.g. two WSL
 * instances labeled `build-runner`), the most-recently-seen host wins so the
 * snapshot describes whichever machine is actually alive.
 */
export async function getActiveHostSnapshots(userId: number, runnerNames: (string | null)[], now = new Date()): Promise<Map<string, ActiveHostSnapshot>> {
  const names = [...new Set(runnerNames.filter((name): name is string => Boolean(name)))];
  if (names.length === 0) return new Map();

  const hosts = await db
    .select()
    .from(monitorHosts)
    .where(and(eq(monitorHosts.userId, userId), inArray(monitorHosts.runnerName, names)));
  if (hosts.length === 0) return new Map();

  const hostIds = hosts.map((host) => host.id);
  const latestRows = await db
    .selectDistinctOn([hostMetricSamples.hostId])
    .from(hostMetricSamples)
    .where(and(inArray(hostMetricSamples.hostId, hostIds), gte(hostMetricSamples.capturedAt, new Date(now.getTime() - DAILY_WINDOW_MS))))
    .orderBy(asc(hostMetricSamples.hostId), desc(hostMetricSamples.capturedAt));

  const latestByHostId = new Map(latestRows.map((row) => [row.hostId, toCapacityMetric(row)]));
  const snapshotByRunner = new Map<string, ActiveHostSnapshot>();
  for (const host of hosts) {
    if (typeof host.runnerName !== "string" || host.runnerName.length === 0) continue;
    const existing = snapshotByRunner.get(host.runnerName);
    const newer = !existing || (host.lastSeenAt !== null && (existing.host.lastSeenAt === null || host.lastSeenAt > existing.host.lastSeenAt));
    if (!newer) continue;
    snapshotByRunner.set(host.runnerName, {
      host: toCapacityHost(host),
      latestMetric: latestByHostId.get(host.id) ?? null,
      stale: isHostStale(host.lastSeenAt, now),
    });
  }
  return snapshotByRunner;
}
