import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";
import { rerunFailedJobs, ActionDeniedError } from "@/lib/github/actions";
import { hasSameOrigin, repoFullNamePattern } from "@/lib/request-security";

const bodySchema = z.object({
  repoFullName: z.string().regex(repoFullNamePattern),
  workflowRunId: z.number().int().positive(),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasSameOrigin(req)) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  try {
    const result = await rerunFailedJobs({
      githubUserId: session.user.githubId,
      ...parsed.data,
      trigger: "manual",
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    if (err instanceof ActionDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    console.error("Workflow rerun failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "rerun failed" }, { status: 502 });
  }
}
