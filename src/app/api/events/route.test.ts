import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listWatchedRepos, requireSession, subscribeToUpdates } = vi.hoisted(() => ({
  listWatchedRepos: vi.fn(),
  requireSession: vi.fn(),
  subscribeToUpdates: vi.fn(),
}));

vi.mock("@/db/realtime", () => ({ subscribeToUpdates }));
vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/installations", () => ({ listWatchedRepos }));

import { GET } from "./route";

const USER_ID = 42;

type StreamPayload = { repoFullName: string; reason: string; userId?: number };

let onMessage!: (payload: StreamPayload) => void;
const unlisten = vi.fn(async () => {});
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let received = "";
const decoder = new TextDecoder();

async function readUntil(matches: (text: string) => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!matches(received)) {
    if (!reader || Date.now() > deadline) return false;
    const { value, done } = await reader.read();
    if (done) return false;
    received += decoder.decode(value, { stream: true });
  }
  return true;
}

async function openStream(watchedFullNames: string[]) {
  requireSession.mockResolvedValue({ user: { userId: USER_ID } });
  listWatchedRepos.mockResolvedValue(watchedFullNames.map((fullName) => ({ fullName })));

  const response = await GET(new NextRequest("http://localhost/api/events"));
  if (response.status !== 200) throw new Error(`expected an SSE stream, got status ${response.status}`);
  reader = response.body!.getReader();
  // "connected" is enqueued only after the subscription callback is
  // registered, so once it lands, onMessage is safe to invoke.
  const connected = await readUntil((text) => text.includes("event: connected"));
  if (!connected) throw new Error(`SSE stream never sent "connected": ${received}`);
}

describe("GET /api/events", () => {
  beforeEach(() => {
    globalThis.__prboardSseConnections = 0;
    received = "";
    subscribeToUpdates.mockImplementation(async (callback: (payload: StreamPayload) => void) => {
      onMessage = callback;
      return unlisten;
    });
  });

  afterEach(async () => {
    await reader?.cancel().catch(() => {});
    reader = null;
  });

  it("delivers host-metrics events addressed to the session user", async () => {
    await openStream([]);

    onMessage({ repoFullName: "", reason: "host-metrics", userId: USER_ID });

    const delivered = await readUntil((text) => text.includes(`"userId":${USER_ID}`));
    expect(delivered).toBe(true);
    expect(received).toContain("event: update");
  });

  it("drops host-metrics events addressed to a different user", async () => {
    await openStream([]);

    onMessage({ repoFullName: "", reason: "host-metrics", userId: 43 });
    // The self-addressed event that follows proves the callback ran; a
    // misdelivered foreign event would have been enqueued before it.
    onMessage({ repoFullName: "", reason: "host-metrics", userId: USER_ID });

    const delivered = await readUntil((text) => text.includes(`"userId":${USER_ID}`));
    expect(delivered).toBe(true);
    expect(received).not.toContain('"userId":43');
  });

  it("still delivers webhook events for watched repos", async () => {
    await openStream(["o/r"]);

    onMessage({ repoFullName: "o/r", reason: "push" });

    const delivered = await readUntil((text) => text.includes('"repoFullName":"o/r"'));
    expect(delivered).toBe(true);
    expect(received).toContain("event: update");
  });

  it("still drops webhook events for unwatched repos", async () => {
    await openStream(["o/r"]);

    onMessage({ repoFullName: "o/secret", reason: "push" });
    onMessage({ repoFullName: "o/r", reason: "push" });

    const delivered = await readUntil((text) => text.includes('"repoFullName":"o/r"'));
    expect(delivered).toBe(true);
    expect(received).not.toContain("o/secret");
  });
});
