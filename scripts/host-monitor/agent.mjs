import { pathToFileURL } from "node:url";
import si from "systeminformation";

const MIB = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function asFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asNonNegativeInteger(value) {
  return Math.max(0, Math.floor(asFiniteNumber(value)));
}

function bytesToMib(value) {
  return asNonNegativeInteger(asFiniteNumber(value) / MIB);
}

export function readConfig(env = process.env) {
  const baseUrl = new URL(required(env, "PRBOARD_URL"));
  if (baseUrl.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(baseUrl.hostname)) {
    throw new Error("PRBOARD_URL must use HTTPS outside local development");
  }
  const token = required(env, "PRBOARD_HOST_TOKEN");
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("PRBOARD_HOST_TOKEN must be a 32-byte base64url token");
  const intervalSeconds = Number(env.PRBOARD_INTERVAL_SECONDS ?? "60");
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 30 || intervalSeconds > 60) {
    throw new Error("PRBOARD_INTERVAL_SECONDS must be an integer from 30 to 60");
  }
  return {
    ingestUrl: new URL("/api/hosts/ingest", baseUrl).toString(),
    hostId: required(env, "PRBOARD_HOST_ID"),
    token,
    intervalMs: intervalSeconds * 1_000,
    diskMount: env.PRBOARD_DISK_MOUNT?.trim() || null,
  };
}

export function buildMetricPayload(snapshot) {
  return {
    capturedAt: snapshot.capturedAt.toISOString(),
    cpuUsageBasisPoints: Math.max(0, Math.min(10_000, Math.round(asFiniteNumber(snapshot.cpuUsagePercent) * 100))),
    logicalCpuCores: Math.max(1, asNonNegativeInteger(snapshot.logicalCpuCores)),
    memoryTotalMib: Math.max(1, bytesToMib(snapshot.memoryTotalBytes)),
    memoryUsedMib: bytesToMib(snapshot.memoryUsedBytes),
    diskTotalMib: Math.max(1, bytesToMib(snapshot.diskTotalBytes)),
    diskUsedMib: bytesToMib(snapshot.diskUsedBytes),
    swapTotalMib: bytesToMib(snapshot.swapTotalBytes),
    swapUsedMib: bytesToMib(snapshot.swapUsedBytes),
    networkRxBytesPerSecond: asNonNegativeInteger(snapshot.networkRxBytesPerSecond),
    networkTxBytesPerSecond: asNonNegativeInteger(snapshot.networkTxBytesPerSecond),
    runnerListenerCount: asNonNegativeInteger(snapshot.runnerListenerCount),
    runnerWorkerCount: asNonNegativeInteger(snapshot.runnerWorkerCount),
    load1: snapshot.load1 === null ? null : Math.max(0, asFiniteNumber(snapshot.load1)),
  };
}

function selectFilesystem(filesystems, desiredMount) {
  const usable = filesystems.filter((filesystem) => asFiniteNumber(filesystem.size) > 0);
  if (usable.length === 0) return { size: 1, used: 0 };
  const normalizedMount = desiredMount?.toLowerCase();
  if (normalizedMount) {
    const requested = usable.find((filesystem) => String(filesystem.mount ?? "").toLowerCase() === normalizedMount);
    if (requested) return requested;
  }
  const root = usable.find((filesystem) => ["/", "c:", "c:\\"].includes(String(filesystem.mount ?? "").toLowerCase()));
  return root ?? [...usable].sort((left, right) => asFiniteNumber(right.size) - asFiniteNumber(left.size))[0];
}

function runnerProcessCounts(processes) {
  let runnerListenerCount = 0;
  let runnerWorkerCount = 0;
  for (const processInfo of processes) {
    const text = `${processInfo.name ?? ""} ${processInfo.command ?? ""}`;
    if (/runner[._ -]?listener(?:\.exe)?/i.test(text)) runnerListenerCount += 1;
    if (/runner[._ -]?worker(?:\.exe)?/i.test(text)) runnerWorkerCount += 1;
  }
  return { runnerListenerCount, runnerWorkerCount };
}

export async function createCollector({ siClient = si, platform = process.platform, diskMount = null } = {}) {
  const cpu = await siClient.cpu();
  const logicalCpuCores = Math.max(1, asNonNegativeInteger(cpu.cores));
  return async () => {
    const [load, memory, filesystems, networkStats, processInfo] = await Promise.all([
      siClient.currentLoad(),
      siClient.mem(),
      siClient.fsSize(),
      siClient.networkStats(),
      siClient.processes(),
    ]);
    const filesystem = selectFilesystem(filesystems, diskMount);
    const networkRxBytesPerSecond = networkStats.reduce((total, item) => total + asFiniteNumber(item.rx_sec), 0);
    const networkTxBytesPerSecond = networkStats.reduce((total, item) => total + asFiniteNumber(item.tx_sec), 0);
    return buildMetricPayload({
      capturedAt: new Date(),
      cpuUsagePercent: load.currentLoad,
      logicalCpuCores,
      memoryTotalBytes: memory.total,
      memoryUsedBytes: memory.active ?? memory.used,
      diskTotalBytes: filesystem.size,
      diskUsedBytes: filesystem.used,
      swapTotalBytes: memory.swaptotal,
      swapUsedBytes: memory.swapused,
      networkRxBytesPerSecond,
      networkTxBytesPerSecond,
      ...runnerProcessCounts(processInfo.list),
      load1: platform === "win32" ? null : asFiniteNumber(load.avgLoad),
    });
  };
}

export async function reportMetric(config, metric) {
  const response = await fetch(config.ingestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PRboard-Host-Id": config.hostId,
      Authorization: `Bearer ${config.token}`,
    },
    body: JSON.stringify(metric),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`ingest endpoint returned HTTP ${response.status}`);
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function run(config = readConfig()) {
  const collect = await createCollector({ diskMount: config.diskMount });
  for (;;) {
    const startedAt = Date.now();
    try {
      await reportMetric(config, await collect());
      console.info("Host metrics reported");
    } catch (error) {
      console.error("Host metric report failed:", error instanceof Error ? error.message : "unknown error");
    }
    await wait(Math.max(1_000, config.intervalMs - (Date.now() - startedAt)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error("Host monitor startup failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
