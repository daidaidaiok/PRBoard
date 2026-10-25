import postgres from "postgres";
import { getPgClient } from "./index";

export const UPDATES_CHANNEL = "prboard_updates";

export interface UpdatePayload {
  repoFullName: string;
  reason: string;
  /** Non-repo events like host telemetry use this to scope delivery to one recipient. */
  userId?: number;
}

/**
 * NOTIFY is fire-and-forget and doesn't need a dedicated connection, so this
 * reuses the normal pooled client. Called from the webhook handler whenever
 * something a dashboard viewer would care about changes.
 */
export async function notifyUpdate(payload: UpdatePayload) {
  const sql = getPgClient();
  await sql.notify(UPDATES_CHANNEL, JSON.stringify(payload));
}

declare global {
  var __prboardListenClient: ReturnType<typeof postgres> | undefined;
}

/**
 * LISTEN requires a session-bound connection, which a pooled/PgBouncer
 * connection string can't provide — so this uses the unpooled URL Neon
 * exposes, on its own dedicated client instance.
 */
function getListenClient() {
  const url = process.env.DATABASE_URL_UNPOOLED;
  if (!url) {
    throw new Error("DATABASE_URL_UNPOOLED is not set. See docs/SETUP.md.");
  }
  if (!global.__prboardListenClient) {
    global.__prboardListenClient = postgres(url, { max: 1 });
  }
  return global.__prboardListenClient;
}

/**
 * Subscribes to update notifications for the lifetime of one SSE
 * connection. Returns an unsubscribe function the route handler must call
 * when the client disconnects, or the LISTEN registration leaks.
 */
export async function subscribeToUpdates(onMessage: (payload: UpdatePayload) => void) {
  const sql = getListenClient();
  const { unlisten } = await sql.listen(UPDATES_CHANNEL, (raw) => {
    try {
      onMessage(JSON.parse(raw) as UpdatePayload);
    } catch {
      // Ignore malformed payloads rather than crashing the SSE stream.
    }
  });
  return unlisten;
}
