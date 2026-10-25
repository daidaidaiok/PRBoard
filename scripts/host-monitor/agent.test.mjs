import { describe, expect, it } from "vitest";
import { buildMetricPayload, readConfig } from "./agent.mjs";

describe("host monitor agent", () => {
  it("requires a complete enrollment configuration without echoing a secret", () => {
    expect(() => readConfig({ PRBOARD_URL: "https://prboard.example", PRBOARD_HOST_ID: "host-id" })).toThrow("PRBOARD_HOST_TOKEN");

    expect(readConfig({
      PRBOARD_URL: "https://prboard.example/",
      PRBOARD_HOST_ID: "host-id",
      PRBOARD_HOST_TOKEN: "a".repeat(43),
      PRBOARD_INTERVAL_SECONDS: "60",
    })).toMatchObject({
      ingestUrl: "https://prboard.example/api/hosts/ingest",
      hostId: "host-id",
      intervalMs: 60_000,
    });

    expect(() => readConfig({
      PRBOARD_URL: "https://prboard.example",
      PRBOARD_HOST_ID: "host-id",
      PRBOARD_HOST_TOKEN: "a".repeat(43),
      PRBOARD_INTERVAL_SECONDS: "120",
    })).toThrow("30 to 60");
  });

  it("serializes only fixed aggregate metrics and Runner process counts", () => {
    const payload = buildMetricPayload({
      capturedAt: new Date("2026-09-07T12:00:00.000Z"),
      cpuUsagePercent: 31.25,
      logicalCpuCores: 8,
      memoryTotalBytes: 32_768 * 1024 * 1024,
      memoryUsedBytes: 12_000 * 1024 * 1024,
      diskTotalBytes: 512_000 * 1024 * 1024,
      diskUsedBytes: 150_000 * 1024 * 1024,
      swapTotalBytes: 8_192 * 1024 * 1024,
      swapUsedBytes: 0,
      networkRxBytesPerSecond: 1_000.8,
      networkTxBytesPerSecond: 500.4,
      runnerListenerCount: 1,
      runnerWorkerCount: 1,
      load1: 2.5,
    });

    expect(payload).toEqual({
      capturedAt: "2026-09-07T12:00:00.000Z",
      cpuUsageBasisPoints: 3_125,
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
      load1: 2.5,
    });
  });
});
