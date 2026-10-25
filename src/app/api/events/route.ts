import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { subscribeToUpdates } from "@/db/realtime";
import { listWatchedRepos } from "@/db/installations";

// SSE holds the connection open indefinitely — opt out of any caching/static
// optimization so each request actually runs the handler.
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;
const MAX_SSE_CONNECTIONS = 100;

declare global {
  var __prboardSseConnections: number | undefined;
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) return new Response("unauthorized", { status: 401 });
  const visibleRepos = new Set((await listWatchedRepos(session.user.userId)).map((repo) => repo.fullName));

  const active = global.__prboardSseConnections ?? 0;
  if (active >= MAX_SSE_CONNECTIONS) return new Response("too many connections", { status: 429 });
  global.__prboardSseConnections = active + 1;

  const encoder = new TextEncoder();
  let unlisten: (() => Promise<void>) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let released = false;
  const releaseConnection = () => {
    if (released) return;
    released = true;
    global.__prboardSseConnections = Math.max(0, (global.__prboardSseConnections ?? 1) - 1);
  };

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: string) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
        } catch {
          // Controller already closed (client disconnected mid-write) — ignore.
        }
      };

      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        void unlisten?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
        releaseConnection();
      };

      req.signal.addEventListener("abort", cleanup);

      try {
        unlisten = await subscribeToUpdates((payload) => {
          if (payload.repoFullName && !visibleRepos.has(payload.repoFullName)) return;
          // A defined userId scopes the event to one recipient (host telemetry);
          // undefined means a broadcast webhook event, which keeps the repo filter above.
          if (payload.userId !== undefined && payload.userId !== session.user.userId) return;
          send("update", JSON.stringify(payload));
        });
      } catch (err) {
        send("error", JSON.stringify({ message: err instanceof Error ? err.message : "subscribe failed" }));
        cleanup();
        return;
      }

      if (req.signal.aborted) {
        cleanup();
        return;
      }

      send("connected", "ok");
      heartbeat = setInterval(() => {
        // Comment line per the SSE spec — keeps proxies/browsers from timing
        // out an idle connection between real updates.
        try {
          controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        } catch {
          cleanup();
        }
      }, HEARTBEAT_MS);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      void unlisten?.();
      releaseConnection();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
