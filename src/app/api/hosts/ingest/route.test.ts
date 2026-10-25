import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authenticateMonitorHost, recordHostMetric, notifyUpdate } = vi.hoisted(() => ({
  authenticateMonitorHost: vi.fn(),
  recordHostMetric: vi.fn(),
  notifyUpdate: vi.fn(),
}));

vi.mock("@/db/host-monitor", () => ({ authenticateMonitorHost, recordHostMetric }));
vi.mock("@/db/realtime", () => ({ notifyUpdate }));

import { POST } from "./route";

const hostId = "11111111-1111-4111-8111-111111111111";
const token = "a".repeat(43);

function metric(overrides: Record<string, unknown> = {}) {
  return {
    capturedAt: new Date().toISOString(),
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

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/hosts/ingest", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-PRboard-Host-Id": hostId,
      Authorization: `Bearer ${token}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hosts/ingest", () => {
  beforeEach(() => {
    authenticateMonitorHost.mockResolvedValue({ hostId, userId: 42, tokenId: "token-1" });
    recordHostMetric.mockResolvedValue("accepted");
    // Real notifyUpdate returns a promise; the route attaches .catch to it.
    notifyUpdate.mockResolvedValue(undefined);
  });

  it("rejects a missing or invalid host bearer token before recording a metric", async () => {
    const response = await POST(request(metric(), { Authorization: "Bearer invalid" }));

    expect(response.status).toBe(401);
    expect(authenticateMonitorHost).not.toHaveBeenCalled();
    expect(recordHostMetric).not.toHaveBeenCalled();
  });

  it("rejects an unknown host token", async () => {
    authenticateMonitorHost.mockResolvedValue(null);

    const response = await POST(request(metric()));

    expect(response.status).toBe(401);
    expect(recordHostMetric).not.toHaveBeenCalled();
  });

  it("rejects out-of-range measurements and stale timestamps", async () => {
    const invalidMetric = await POST(request(metric({ cpuUsageBasisPoints: 10_001 })));
    const staleMetric = await POST(request(metric({ capturedAt: new Date(Date.now() - 16 * 60_000).toISOString() })));

    expect(invalidMetric.status).toBe(400);
    expect(staleMetric.status).toBe(400);
    expect(recordHostMetric).not.toHaveBeenCalled();
  });

  it("accepts a strictly validated metric for its authenticated host only", async () => {
    const response = await POST(request(metric()));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, result: "accepted" });
    expect(recordHostMetric).toHaveBeenCalledWith(hostId, expect.objectContaining({
      cpuUsageBasisPoints: 3_000,
      capturedAt: expect.any(Date),
      runnerWorkerCount: 1,
    }));
  });

  it("accepts an active Worker when OS process visibility does not expose its Listener", async () => {
    const response = await POST(request(metric({ runnerListenerCount: 0, runnerWorkerCount: 1 })));

    expect(response.status).toBe(202);
    expect(recordHostMetric).toHaveBeenCalledWith(hostId, expect.objectContaining({
      runnerListenerCount: 0,
      runnerWorkerCount: 1,
    }));
  });

  it("acknowledges idempotent retries but exposes rate limiting", async () => {
    recordHostMetric.mockResolvedValueOnce("duplicate").mockResolvedValueOnce("rate-limited");

    const duplicate = await POST(request(metric()));
    const rateLimited = await POST(request(metric()));

    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toEqual({ ok: true, result: "duplicate" });
    expect(rateLimited.status).toBe(429);
  });

  it("notifies SSE subscribers exactly once when a metric is accepted", async () => {
    const response = await POST(request(metric()));

    expect(response.status).toBe(202);
    expect(notifyUpdate).toHaveBeenCalledTimes(1);
    expect(notifyUpdate).toHaveBeenCalledWith({ repoFullName: "", reason: "host-metrics", userId: 42 });
  });

  it("does not notify SSE subscribers for duplicate or rate-limited metrics", async () => {
    recordHostMetric.mockResolvedValueOnce("duplicate").mockResolvedValueOnce("rate-limited");

    const duplicate = await POST(request(metric()));
    const rateLimited = await POST(request(metric()));

    expect(duplicate.status).toBe(200);
    expect(rateLimited.status).toBe(429);
    expect(notifyUpdate).not.toHaveBeenCalled();
  });

  it("still returns 202 when the SSE notification fails", async () => {
    notifyUpdate.mockRejectedValueOnce(new Error("notify channel unavailable"));

    const response = await POST(request(metric()));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, result: "accepted" });
  });
});
