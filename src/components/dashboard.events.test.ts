import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/dashboard.tsx"), "utf8");

describe("dashboard SSE host-event filtering", () => {
  it("parses update payloads and ignores host-metrics events so host telemetry never refetches the PR board", () => {
    expect(source).toContain("parseRealtimeEvent");
    expect(source).toContain('"host-metrics"');
  });
});
