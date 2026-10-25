import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { syncInstallationsForUser } from "@/lib/github/sync";
import { hasSameOrigin } from "@/lib/request-security";

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasSameOrigin(req)) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });

  const results = await syncInstallationsForUser(session.user.userId);
  return NextResponse.json({ results });
}
