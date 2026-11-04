import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Structural tripwire, not a behavioral test: e-ink panels flash on every
// repaint, so live-push (SSE) and scheduled polling must stay hard-gated in
// source. It passes against current source by design — its only job is to
// fail loudly if someone removes the gating.
const readSource = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");

// Slice the smallest effect block around a marker: from the useEffect that
// encloses it to the closing dependency array, so each guard is tied to its
// own effect instead of matching anywhere in the file.
const effectAround = (text: string, marker: string) => {
  const at = text.indexOf(marker);
  const start = text.lastIndexOf("useEffect", at);
  const end = text.indexOf("]);", at);
  // `end` points at "]);" — include it so the dependency array stays in the slice.
  return text.slice(start, end + 3);
};

const EVENT_SOURCE = 'new EventSource("/api/events")';

describe("dashboard eink gating", () => {
  const source = readSource("src/components/dashboard.tsx");
  const sseEffect = effectAround(source, EVENT_SOURCE);
  const pollEffect = effectAround(source, "setTimeout(tick, delay)");

  it("exits the SSE effect before opening the realtime stream in eink mode", () => {
    expect(sseEffect).toContain("if (isEink) return;");
    expect(sseEffect.indexOf("if (isEink) return;")).toBeLessThan(sseEffect.indexOf(EVENT_SOURCE));
  });

  it("schedules neither fallback polls nor offline retries in eink mode", () => {
    expect(pollEffect).toContain("if (!isEink) timer = setTimeout(tick, delay);");
    expect(pollEffect).toContain("if (!isEink) timer = setTimeout(tick, OFFLINE_RETRY_MS);");
  });

  it("lists isEink in both gated effects' dependency arrays so flipping the mode rebuilds them", () => {
    expect(sseEffect).toContain("[fetchPrs, isEink]);");
    expect(pollEffect).toContain("[fetchPrs, isEink]);");
  });
});

describe("runner-monitor eink gating", () => {
  const source = readSource("src/components/runner-monitor.tsx");
  const sseEffect = effectAround(source, EVENT_SOURCE);
  const pollEffect = effectAround(source, "setInterval(() => {");

  it("exits the SSE effect before opening the realtime stream in eink mode", () => {
    expect(sseEffect).toContain("if (isEink) return;");
    expect(sseEffect.indexOf("if (isEink) return;")).toBeLessThan(sseEffect.indexOf(EVENT_SOURCE));
  });

  it("keeps the fallback interval eink-gated and the SSE effect dependent on isEink", () => {
    expect(pollEffect).toContain("if (!isEink) {");
    expect(sseEffect).toContain("[refreshAll, isEink]);");
  });
});

describe("host-capacity-monitor eink gating", () => {
  const source = readSource("src/components/host-capacity-monitor.tsx");
  const sseEffect = effectAround(source, EVENT_SOURCE);
  const pollEffect = effectAround(source, "setInterval(() => {");

  it("exits the SSE effect before opening the realtime stream in eink mode", () => {
    expect(sseEffect).toContain("if (isEink) return;");
    expect(sseEffect.indexOf("if (isEink) return;")).toBeLessThan(sseEffect.indexOf(EVENT_SOURCE));
  });

  it("exits the poll effect before scheduling the interval and depends on isEink in both", () => {
    expect(pollEffect).toContain("if (isEink) return;");
    expect(pollEffect.indexOf("if (isEink) return;")).toBeLessThan(pollEffect.indexOf("setInterval("));
    expect(sseEffect).toContain("[loadHosts, isEink]);");
  });
});
