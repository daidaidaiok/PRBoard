import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { listSelfHostedRunners } from "@/lib/github/runners";

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ runners: await listSelfHostedRunners(session.user.userId), checkedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "runner status unavailable" }, { status: 502 });
  }
}
