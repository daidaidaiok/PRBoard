import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";
import { listWorkflowRunJobs } from "@/lib/github/runners";
import { repoFullNamePattern } from "@/lib/request-security";

const querySchema = z.object({ repoFullName: z.string().regex(repoFullNamePattern), workflowRunId: z.coerce.number().int().positive() });

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "invalid request query" }, { status: 400 });
  try {
    const jobs = await listWorkflowRunJobs(session.user.userId, parsed.data.repoFullName, parsed.data.workflowRunId);
    return NextResponse.json({ jobs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("not a repo this app is watching")) {
      return NextResponse.json({ error: "repository is not watched" }, { status: 403 });
    }
    console.error("Loading workflow jobs failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "加载 jobs 失败" }, { status: 502 });
  }
}
