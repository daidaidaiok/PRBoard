import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { authenticateMonitorHost, recordHostMetric } from "@/db/host-monitor";
import { notifyUpdate } from "@/db/realtime";

export const runtime = "nodejs";

const MAX_BODY_CHARS = 4_096;
const MAX_PAST_CLOCK_SKEW_MS = 15 * 60 * 1_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const metricSchema = z.object({
  capturedAt: z.string().datetime({ offset: true }),
  cpuUsageBasisPoints: z.number().int().min(0).max(10_000),
  logicalCpuCores: z.number().int().min(1).max(4_096),
  memoryTotalMib: z.number().int().min(1).max(4_194_304),
  memoryUsedMib: z.number().int().min(0).max(4_194_304),
  diskTotalMib: z.number().int().min(1).max(4_194_304),
  diskUsedMib: z.number().int().min(0).max(4_194_304),
  swapTotalMib: z.number().int().min(0).max(4_194_304),
  swapUsedMib: z.number().int().min(0).max(4_194_304),
  networkRxBytesPerSecond: z.number().int().min(0).max(1_000_000_000_000),
  networkTxBytesPerSecond: z.number().int().min(0).max(1_000_000_000_000),
  runnerListenerCount: z.number().int().min(0).max(256),
  runnerWorkerCount: z.number().int().min(0).max(256),
  load1: z.number().min(0).max(1_000_000).nullable(),
}).strict().superRefine((metric, context) => {
  for (const [used, total, label] of [
    [metric.memoryUsedMib, metric.memoryTotalMib, "memory"],
    [metric.diskUsedMib, metric.diskTotalMib, "disk"],
    [metric.swapUsedMib, metric.swapTotalMib, "swap"],
  ] as const) {
    if (used > total) context.addIssue({ code: "custom", path: [`${label}UsedMib`], message: `${label} use exceeds total` });
  }
});

function bearerToken(request: NextRequest): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

export async function POST(request: NextRequest) {
  const hostId = z.string().uuid().safeParse(request.headers.get("x-prboard-host-id"));
  const token = bearerToken(request);
  if (!hostId.success || !token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let authenticated: Awaited<ReturnType<typeof authenticateMonitorHost>>;
  try {
    authenticated = await authenticateMonitorHost(hostId.data, token);
  } catch (error) {
    console.error("Host token verification failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "metric ingest unavailable" }, { status: 502 });
  }
  if (!authenticated) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARS) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const body = await request.text();
  if (body.length > MAX_BODY_CHARS) return NextResponse.json({ error: "payload too large" }, { status: 413 });
  const parsed = metricSchema.safeParse((() => {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  })());
  if (!parsed.success) return NextResponse.json({ error: "invalid metric payload" }, { status: 400 });

  const capturedAt = new Date(parsed.data.capturedAt);
  const now = new Date();
  if (capturedAt.getTime() < now.getTime() - MAX_PAST_CLOCK_SKEW_MS || capturedAt.getTime() > now.getTime() + MAX_FUTURE_CLOCK_SKEW_MS) {
    return NextResponse.json({ error: "capturedAt outside allowed clock skew" }, { status: 400 });
  }

  try {
    const result = await recordHostMetric(authenticated.hostId, { ...parsed.data, capturedAt });
    if (result === "rate-limited") return NextResponse.json({ error: "metric rate limited" }, { status: 429 });
    if (result === "accepted") {
      void notifyUpdate({ repoFullName: "", reason: "host-metrics", userId: authenticated.userId }).catch(() => {
        // SSE refresh is best-effort; never fail the ingest on notify errors.
      });
    }
    return NextResponse.json({ ok: true, result }, { status: result === "accepted" ? 202 : 200 });
  } catch (error) {
    console.error("Host metric ingest failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "metric ingest unavailable" }, { status: 502 });
  }
}
