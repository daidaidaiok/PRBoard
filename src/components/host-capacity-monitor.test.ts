import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/host-capacity-monitor.tsx"), "utf8");

describe("host capacity monitor", () => {
  it("loads host capacity independently and exposes enrollment and capacity-domain UI", () => {
    expect(source).toContain('fetch("/api/hosts"');
    expect(source).toContain("新增主机");
    expect(source).toContain("容量域");
    expect(source).toContain("canary Runner");
  });

  it("stretches the fallback poll to 300s and refreshes via throttled SSE host events", () => {
    expect(source).toContain("POLL_INTERVAL_MS = 300_000");
    expect(source).toContain("SSE_MIN_REFRESH_MS = 90_000");
    expect(source).toContain('EventSource("/api/events")');
    expect(source).toContain("parseRealtimeEvent");
    expect(source).toContain("shouldRefreshOnHostEvent");
  });
});
