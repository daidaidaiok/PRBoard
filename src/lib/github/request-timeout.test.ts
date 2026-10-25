import { Octokit } from "@octokit/core";
import { describe, expect, it } from "vitest";
import { requestTimeoutHook, GITHUB_TIMEOUT_MS } from "./request-timeout";
import { DEFAULT_FETCH_TIMEOUT_MS } from "../fetch-with-timeout";

/** A fetch stand-in that never settles on its own, only via abort. */
const hangingFetch: typeof fetch = ((_url: unknown, init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
  })) as unknown as typeof fetch;

// Octokit wraps fetch failures in RequestError; the signal's DOMException
// rides along as `cause`.
function rejectionName(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const cause = (error as { cause?: { name?: string } }).cause;
  return cause?.name ?? error.name;
}

function octokitWithHook(timeoutMs: number) {
  const TimeoutOctokit = Octokit.plugin(requestTimeoutHook(timeoutMs));
  return new TimeoutOctokit({ request: { fetch: hangingFetch } });
}

describe("requestTimeoutHook", () => {
  it("aborts a request that outlives the bound", async () => {
    const octokit = octokitWithHook(50);
    await expect(octokit.request("GET /")).rejects.toSatisfy((e) => rejectionName(e) === "TimeoutError");
  });

  it("leaves caller-provided signals in charge", async () => {
    const octokit = octokitWithHook(50);
    const controller = new AbortController();
    const pending = octokit.request("GET /", { request: { signal: controller.signal } });
    const lateAbort = setTimeout(() => controller.abort(), 200);
    await expect(pending).rejects.toSatisfy((e) => rejectionName(e) === "AbortError");
    clearTimeout(lateAbort);
  });

  // The deployment's DB and GitHub legs can both be slow (cross-border link).
  // If a GitHub request outlives the browser's fetch budget, /api/prs never
  // answers and the client dies with "请求超时" before the snapshot fallback
  // gets to speak — so the server-side bound must lose that race first.
  it("default bound stays under the browser fetch budget", () => {
    expect(GITHUB_TIMEOUT_MS).toBeLessThan(DEFAULT_FETCH_TIMEOUT_MS);
  });
});
