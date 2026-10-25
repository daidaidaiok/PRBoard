import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/components/dashboard.tsx"), "utf8");

describe("dashboard poll backoff", () => {
  it("retries the first failure within seconds instead of entering the long backoff curve immediately", () => {
    // 首败后的下一次拉取必须走快速重试档（秒级）。此前 streak=1 直接落到
    // 90s × 2¹ = 180s，一次瞬时抖动会让错误横幅挂三分钟才自愈。
    expect(source).toContain("QUICK_RETRY_MS * 2 ** (streak - 1)");
  });

  it("keeps exponential growth and the max cap for subsequent failures", () => {
    const delayLine = source.split("\n").find((line) => line.includes("QUICK_RETRY_MS * 2 ** (streak - 1)"));
    expect(delayLine).toContain("MAX_POLL_INTERVAL_MS");
  });
});
