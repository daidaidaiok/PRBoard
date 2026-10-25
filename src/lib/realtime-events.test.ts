import { describe, expect, it } from "vitest";
import { parseRealtimeEvent, shouldRefreshOnAnyEvent, shouldRefreshOnHostEvent } from "./realtime-events";

describe("parseRealtimeEvent", () => {
  it("returns the JSON object for a valid update payload", () => {
    expect(parseRealtimeEvent('{"repoFullName":"a/b","reason":"pr-updated"}')).toEqual({
      repoFullName: "a/b",
      reason: "pr-updated",
    });
  });

  it("returns the object when reason is absent (reason is optional)", () => {
    expect(parseRealtimeEvent('{"repoFullName":"a/b"}')).toEqual({ repoFullName: "a/b" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseRealtimeEvent("not-json")).toBeNull();
    expect(parseRealtimeEvent("{broken")).toBeNull();
    expect(parseRealtimeEvent("")).toBeNull();
  });

  it("returns null for parsed values that are not plain objects", () => {
    expect(parseRealtimeEvent("null")).toBeNull();
    expect(parseRealtimeEvent("[1,2]")).toBeNull();
    expect(parseRealtimeEvent('"hello"')).toBeNull();
    expect(parseRealtimeEvent("42")).toBeNull();
    expect(parseRealtimeEvent("true")).toBeNull();
  });
});

describe("shouldRefreshOnHostEvent", () => {
  const MIN_INTERVAL_MS = 90_000;

  it("ignores events whose reason is not host-metrics", () => {
    expect(shouldRefreshOnHostEvent({ reason: "pr-updated" }, 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnHostEvent({ repoFullName: "a/b" }, 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnHostEvent(null, 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
  });

  it("drops host-metrics events inside the throttle window", () => {
    expect(shouldRefreshOnHostEvent({ reason: "host-metrics" }, 1000, 1000 + MIN_INTERVAL_MS - 1, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnHostEvent({ reason: "host-metrics" }, 1000, 2000, MIN_INTERVAL_MS)).toBe(false);
  });

  it("allows host-metrics events once the throttle window has elapsed", () => {
    expect(shouldRefreshOnHostEvent({ reason: "host-metrics" }, 1000, 1000 + MIN_INTERVAL_MS, MIN_INTERVAL_MS)).toBe(true);
    expect(shouldRefreshOnHostEvent({ reason: "host-metrics" }, 1000, 1000 + MIN_INTERVAL_MS + 1, MIN_INTERVAL_MS)).toBe(true);
  });

  it("always allows a refresh when nothing has been fetched yet (lastRefreshAt = 0)", () => {
    expect(shouldRefreshOnHostEvent({ reason: "host-metrics" }, 0, 1, MIN_INTERVAL_MS)).toBe(true);
  });
});

describe("shouldRefreshOnAnyEvent", () => {
  const MIN_INTERVAL_MS = 60_000;

  it("allows any reason (repo webhooks and host telemetry both move runner state)", () => {
    expect(shouldRefreshOnAnyEvent({ reason: "check_run" }, 1000, 1000 + MIN_INTERVAL_MS, MIN_INTERVAL_MS)).toBe(true);
    expect(shouldRefreshOnAnyEvent({ reason: "host-metrics" }, 1000, 1000 + MIN_INTERVAL_MS, MIN_INTERVAL_MS)).toBe(true);
    expect(shouldRefreshOnAnyEvent({ repoFullName: "a/b" }, 1000, 1000 + MIN_INTERVAL_MS, MIN_INTERVAL_MS)).toBe(true);
  });

  it("drops events inside the throttle window", () => {
    expect(shouldRefreshOnAnyEvent({ reason: "check_run" }, 1000, 1000 + MIN_INTERVAL_MS - 1, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnAnyEvent({ reason: "check_run" }, 1000, 2000, MIN_INTERVAL_MS)).toBe(false);
  });

  it("always allows a refresh when nothing has been fetched yet (lastRefreshAt = 0)", () => {
    expect(shouldRefreshOnAnyEvent({ reason: "check_run" }, 0, 1, MIN_INTERVAL_MS)).toBe(true);
  });

  it("rejects payloads that are not plain objects", () => {
    expect(shouldRefreshOnAnyEvent(null, 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnAnyEvent("event", 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
    expect(shouldRefreshOnAnyEvent(42, 0, 1_000_000, MIN_INTERVAL_MS)).toBe(false);
  });
});
