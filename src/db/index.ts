import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

declare global {
  var __prboardDbClient: ReturnType<typeof postgres> | undefined;
}

function getClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. See docs/SETUP.md.");
  }
  // Reuse the connection across hot reloads / Fluid Compute instance reuse.
  if (!global.__prboardDbClient) {
    // prepare: false — transaction poolers (Supabase :6543) can't hold prepared statements.
    global.__prboardDbClient = postgres(url, { max: 5, prepare: false });
  }
  return global.__prboardDbClient;
}

/** The raw postgres-js client, for things drizzle doesn't wrap (LISTEN/NOTIFY). */
export function getPgClient() {
  return getClient();
}

export const db = drizzle(getClient(), { schema });
