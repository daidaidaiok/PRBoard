/**
 * Shared helpers for consuming the /api/events SSE stream: parse one raw
 * `update` event body and decide whether it should trigger a refresh.
 */

/** Minimal shape of the JSON payload the SSE stream fans out per update. */
export interface RealtimeEventPayload {
  reason?: string;
}

/**
 * Parses one SSE `update` event body, returning null for anything that is
 * not a JSON object (malformed JSON, arrays, primitives) since such payloads
 * cannot carry a usable `reason`.
 */
export function parseRealtimeEvent(data: string): RealtimeEventPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as RealtimeEventPayload;
}

/** Shared throttle tail: lastRefreshAt = 0 is the "never refreshed" sentinel — always allow. */
function withinThrottle(lastRefreshAt: number, now: number, minIntervalMs: number): boolean {
  if (lastRefreshAt === 0) return true;
  return now - lastRefreshAt >= minIntervalMs;
}

/**
 * Decides whether an event may trigger a host-metrics refetch: non-host
 * events are ignored and host events inside the throttle window are dropped
 * so per-ingest notifications cannot hammer /api/hosts.
 */
export function shouldRefreshOnHostEvent(
  payload: unknown,
  lastRefreshAt: number,
  now: number,
  minIntervalMs: number,
): boolean {
  const reason = typeof payload === "object" && payload !== null && "reason" in payload
    ? (payload as { reason?: unknown }).reason
    : undefined;
  if (reason !== "host-metrics") return false;
  return withinThrottle(lastRefreshAt, now, minIntervalMs);
}

/**
 * Throttle-only variant: any well-formed event may trigger a refresh, because
 * repo webhook events (check_run / workflow_run) are exactly when a runner's
 * busy state flips, and host telemetry moves the capacity numbers. Used by the
 * Runner monitor, which has no reason-type filter to apply.
 */
export function shouldRefreshOnAnyEvent(
  payload: unknown,
  lastRefreshAt: number,
  now: number,
  minIntervalMs: number,
): boolean {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  return withinThrottle(lastRefreshAt, now, minIntervalMs);
}
