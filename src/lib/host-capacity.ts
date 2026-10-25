export interface CapacityHost {
  id: string;
  displayName: string;
  platform: "macos" | "windows" | "linux";
  capacityDomain: string;
  capacityRole: "primary" | "shared";
  runnerName: string | null;
  createdAt: Date;
  lastSeenAt: Date | null;
  runnerCpuReserveMilliCores: number;
  runnerMemoryReserveMib: number;
}

export interface CapacityMetric {
  hostId: string;
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

export interface HourlyCapacityMetric {
  capturedAt: Date;
  cpuUsageBasisPoints: number;
  memoryUsageBasisPoints: number;
  diskUsageBasisPoints: number;
  networkRxBytesPerSecond: number;
  networkTxBytesPerSecond: number;
  runnerBusy: boolean;
}

export interface CapacityDomain {
  capacityDomain: string;
  hosts: Array<{
    host: CapacityHost;
    latestMetric: CapacityMetric | null;
    sampleCount: number;
    stale: boolean;
    hourly: HourlyCapacityMetric[];
  }>;
  capacitySourceHostId: string | null;
  cpuP95BasisPoints: number;
  memoryP95BasisPoints: number;
  diskMaxBasisPoints: number;
  swapP95BasisPoints: number;
  runnerBusyBasisPoints: number;
  dataCoverageBasisPoints: number;
  recommendation: {
    kind: "collecting" | "hold" | "headroom-without-demand" | "add-canary";
    additionalRunners: number;
    reason: string;
  };
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const EXPECTED_DAILY_SAMPLES = 24 * 60;
const MIN_DATA_COVERAGE_BASIS_POINTS = 8_000;
/** A host whose heartbeat is older than this renders as 遥测过期 everywhere. */
export const STALE_AFTER_MS = 3 * 60 * 1_000;

/** Single source of truth for 遥测过期 — every staleness check composes this. */
export function isHostStale(lastSeenAt: Date | null, now: Date): boolean {
  return !lastSeenAt || now.getTime() - lastSeenAt.getTime() > STALE_AFTER_MS;
}

// Display formatters shared by both monitor components (same basis-points/MiB
// vocabulary as the capacity constants above; one implementation).
export function percentage(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export function mib(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)} GiB`;
  return `${value} MiB`;
}
const CPU_HEADROOM_LIMIT_BASIS_POINTS = 7_000;
const MEMORY_HEADROOM_LIMIT_BASIS_POINTS = 7_500;
const DISK_HEADROOM_LIMIT_BASIS_POINTS = 8_000;
const SWAP_PRESSURE_LIMIT_BASIS_POINTS = 1_000;
const WORKER_DEMAND_LIMIT_BASIS_POINTS = 6_000;

function basisPoints(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.max(0, Math.min(10_000, Math.round((numerator / denominator) * 10_000)));
}

export function percentile(values: number[], percent: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(percent * sorted.length) - 1));
  return sorted[index];
}

function mostRecent(metrics: CapacityMetric[]): CapacityMetric | null {
  return metrics.reduce<CapacityMetric | null>((latest, metric) => {
    if (!latest || metric.capturedAt > latest.capturedAt) return metric;
    return latest;
  }, null);
}

function runnerBusyBasisPoints(metrics: CapacityMetric[]): number {
  const busyByMinute = new Map<number, boolean>();
  for (const metric of metrics) {
    const minute = Math.floor(metric.capturedAt.getTime() / 60_000);
    busyByMinute.set(minute, (busyByMinute.get(minute) ?? false) || metric.runnerWorkerCount > 0);
  }
  return basisPoints([...busyByMinute.values()].filter(Boolean).length, busyByMinute.size);
}

function hourlyMetrics(metrics: CapacityMetric[]): HourlyCapacityMetric[] {
  const buckets = new Map<number, {
    sampleCount: number;
    cpuUsageBasisPoints: number;
    memoryUsageBasisPoints: number;
    diskUsageBasisPoints: number;
    networkRxBytesPerSecond: number;
    networkTxBytesPerSecond: number;
    runnerBusy: boolean;
  }>();
  for (const metric of metrics) {
    const hourStart = Math.floor(metric.capturedAt.getTime() / HOUR_MS) * HOUR_MS;
    const bucket = buckets.get(hourStart) ?? {
      sampleCount: 0,
      cpuUsageBasisPoints: 0,
      memoryUsageBasisPoints: 0,
      diskUsageBasisPoints: 0,
      networkRxBytesPerSecond: 0,
      networkTxBytesPerSecond: 0,
      runnerBusy: false,
    };
    bucket.sampleCount += 1;
    bucket.cpuUsageBasisPoints += metric.cpuUsageBasisPoints;
    bucket.memoryUsageBasisPoints += basisPoints(metric.memoryUsedMib, metric.memoryTotalMib);
    bucket.diskUsageBasisPoints += basisPoints(metric.diskUsedMib, metric.diskTotalMib);
    bucket.networkRxBytesPerSecond += metric.networkRxBytesPerSecond;
    bucket.networkTxBytesPerSecond += metric.networkTxBytesPerSecond;
    bucket.runnerBusy ||= metric.runnerWorkerCount > 0;
    buckets.set(hourStart, bucket);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left - right)
    .slice(-24)
    .map(([hourStart, bucket]) => ({
      capturedAt: new Date(hourStart),
      cpuUsageBasisPoints: Math.round(bucket.cpuUsageBasisPoints / bucket.sampleCount),
      memoryUsageBasisPoints: Math.round(bucket.memoryUsageBasisPoints / bucket.sampleCount),
      diskUsageBasisPoints: Math.round(bucket.diskUsageBasisPoints / bucket.sampleCount),
      networkRxBytesPerSecond: Math.round(bucket.networkRxBytesPerSecond / bucket.sampleCount),
      networkTxBytesPerSecond: Math.round(bucket.networkTxBytesPerSecond / bucket.sampleCount),
      runnerBusy: bucket.runnerBusy,
    }));
}

function recommendation(params: {
  primary: CapacityHost | undefined;
  primaryMetrics: CapacityMetric[];
  now: Date;
  cpuP95BasisPoints: number;
  memoryP95BasisPoints: number;
  diskMaxBasisPoints: number;
  swapP95BasisPoints: number;
  coverageBasisPoints: number;
  runnerBusyBasisPoints: number;
}): CapacityDomain["recommendation"] {
  const {
    primary,
    primaryMetrics,
    now,
    cpuP95BasisPoints,
    memoryP95BasisPoints,
    diskMaxBasisPoints,
    swapP95BasisPoints,
    coverageBasisPoints,
    runnerBusyBasisPoints,
  } = params;
  if (!primary) {
    return { kind: "collecting", additionalRunners: 0, reason: "容量域尚未指定物理主机" };
  }

  const latestPrimaryMetric = mostRecent(primaryMetrics);
  const hasFullDay = now.getTime() - primary.createdAt.getTime() >= DAY_MS;
  const stale = isHostStale(primary.lastSeenAt, now);
  if (!hasFullDay || coverageBasisPoints < MIN_DATA_COVERAGE_BASIS_POINTS || stale || !latestPrimaryMetric) {
    return {
      kind: "collecting",
      additionalRunners: 0,
      reason: "需连续采集满 24 小时且覆盖率至少 80% 后再评估容量",
    };
  }

  if (
    cpuP95BasisPoints > CPU_HEADROOM_LIMIT_BASIS_POINTS ||
    memoryP95BasisPoints > MEMORY_HEADROOM_LIMIT_BASIS_POINTS ||
    diskMaxBasisPoints >= DISK_HEADROOM_LIMIT_BASIS_POINTS ||
    swapP95BasisPoints > SWAP_PRESSURE_LIMIT_BASIS_POINTS
  ) {
    return {
      kind: "hold",
      additionalRunners: 0,
      reason: "CPU、内存、磁盘或 Swap 已接近保守容量阈值，保持当前 Runner 数量",
    };
  }

  if (runnerBusyBasisPoints < WORKER_DEMAND_LIMIT_BASIS_POINTS) {
    return {
      kind: "headroom-without-demand",
      additionalRunners: 0,
      reason: "主机有资源余量，但 Runner Worker 忙碌率不足，暂无扩容需求",
    };
  }

  const cpuHeadroomMilliCores = Math.max(
    0,
    ((CPU_HEADROOM_LIMIT_BASIS_POINTS - cpuP95BasisPoints) / 10_000) * latestPrimaryMetric.logicalCpuCores * 1_000,
  );
  const memoryHeadroomMib = Math.max(
    0,
    ((MEMORY_HEADROOM_LIMIT_BASIS_POINTS - memoryP95BasisPoints) / 10_000) * latestPrimaryMetric.memoryTotalMib,
  );
  const possibleByCpu = Math.floor(cpuHeadroomMilliCores / primary.runnerCpuReserveMilliCores);
  const possibleByMemory = Math.floor(memoryHeadroomMib / primary.runnerMemoryReserveMib);
  if (Math.min(possibleByCpu, possibleByMemory) < 1) {
    return {
      kind: "hold",
      additionalRunners: 0,
      reason: "余量不足以满足一个 Runner 的保守 CPU 与内存预留",
    };
  }

  return {
    kind: "add-canary",
    additionalRunners: 1,
    reason: "主机余量充足且 Worker 长期忙碌；建议先增加 1 个带隔离标签的 canary Runner",
  };
}

export function buildCapacityDomains(
  hosts: CapacityHost[],
  metrics: CapacityMetric[],
  now = new Date(),
  options: { bucketMs?: number; expectedDailySamples?: number } = {},
): CapacityDomain[] {
  // SQL-side aggregation produces bucket rows whose capturedAt is the bucket
  // start, so the earliest bucket holding in-window samples can begin up to
  // one bucket width before the 24h window start — widen the lower bound by
  // bucketMs to keep it (the `> now` upper bound stays strict).
  const windowStart = now.getTime() - DAY_MS - (options.bucketMs ?? 0);
  const metricsByHost = new Map<string, CapacityMetric[]>();
  for (const metric of metrics) {
    if (metric.capturedAt.getTime() < windowStart || metric.capturedAt > now) continue;
    const hostMetrics = metricsByHost.get(metric.hostId);
    if (hostMetrics) hostMetrics.push(metric);
    else metricsByHost.set(metric.hostId, [metric]);
  }

  const hostsByDomain = new Map<string, CapacityHost[]>();
  for (const host of hosts) {
    const domainHosts = hostsByDomain.get(host.capacityDomain);
    if (domainHosts) domainHosts.push(host);
    else hostsByDomain.set(host.capacityDomain, [host]);
  }

  return [...hostsByDomain.entries()].map(([capacityDomain, domainHosts]) => {
    const primary = domainHosts.find((host) => host.capacityRole === "primary");
    const primaryMetrics = primary ? metricsByHost.get(primary.id) ?? [] : [];
    const allMetrics = domainHosts.flatMap((host) => metricsByHost.get(host.id) ?? []);
    const cpuP95BasisPoints = percentile(primaryMetrics.map((metric) => metric.cpuUsageBasisPoints), 0.95);
    const memoryP95BasisPoints = percentile(
      primaryMetrics.map((metric) => basisPoints(metric.memoryUsedMib, metric.memoryTotalMib)),
      0.95,
    );
    const diskMaxBasisPoints = Math.max(0, ...primaryMetrics.map((metric) => basisPoints(metric.diskUsedMib, metric.diskTotalMib)));
    const swapP95BasisPoints = percentile(
      primaryMetrics.map((metric) => basisPoints(metric.swapUsedMib, metric.swapTotalMib)),
      0.95,
    );
    const dataCoverageBasisPoints = basisPoints(primaryMetrics.length, options.expectedDailySamples ?? EXPECTED_DAILY_SAMPLES);
    const domainRunnerBusyBasisPoints = runnerBusyBasisPoints(allMetrics);

    return {
      capacityDomain,
      hosts: domainHosts.map((host) => {
        const hostMetrics = metricsByHost.get(host.id) ?? [];
        const latestMetric = mostRecent(hostMetrics);
        return {
          host,
          latestMetric,
          sampleCount: hostMetrics.length,
          stale: isHostStale(host.lastSeenAt, now),
          hourly: hourlyMetrics(hostMetrics),
        };
      }),
      capacitySourceHostId: primary?.id ?? null,
      cpuP95BasisPoints,
      memoryP95BasisPoints,
      diskMaxBasisPoints,
      swapP95BasisPoints,
      runnerBusyBasisPoints: domainRunnerBusyBasisPoints,
      dataCoverageBasisPoints,
      recommendation: recommendation({
        primary,
        primaryMetrics,
        now,
        cpuP95BasisPoints,
        memoryP95BasisPoints,
        diskMaxBasisPoints,
        swapP95BasisPoints,
        coverageBasisPoints: dataCoverageBasisPoints,
        runnerBusyBasisPoints: domainRunnerBusyBasisPoints,
      }),
    };
  });
}
