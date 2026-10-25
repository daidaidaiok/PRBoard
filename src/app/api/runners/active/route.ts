import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listActiveJobs } from "@/lib/github/active-jobs";

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ jobs: await listActiveJobs(session.user.userId), checkedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Loading active jobs failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "active jobs unavailable" }, { status: 502 });
  }
}
