import { describe, expect, it } from "vitest";
import { fetchWithTimeout, isTimeoutError } from "./fetch-with-timeout";

/** A fetch stand-in that ignores its response duty until the signal fires. */
function hangingFetch(): typeof fetch {
  return ((_: unknown, init?: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
}

describe("fetchWithTimeout", () => {
  it("rejects with TimeoutError when the request outlives the bound", async () => {
    global.fetch = hangingFetch();
    await expect(fetchWithTimeout("https://example.com", { timeoutMs: 30 })).rejects.toSatisfy(isTimeoutError);
  });

  it("returns the response when the request settles in time", async () => {
    global.fetch = (() => Promise.resolve(new Response("{}"))) as typeof fetch;
    const response = await fetchWithTimeout("https://example.com", { timeoutMs: 1000 });
    expect(response.status).toBe(200);
  });

  it("keeps a caller abort distinguishable from a timeout", async () => {
    global.fetch = hangingFetch();
    const controller = new AbortController();
    const pending = fetchWithTimeout("https://example.com", { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toSatisfy((e: unknown) => e instanceof DOMException && e.name === "AbortError");
  });

  it("isTimeoutError is false for ordinary failures", () => {
    expect(isTimeoutError(new Error("boom"))).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
  });
});
