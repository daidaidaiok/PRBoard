import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";
import { logAudit } from "@/db/audit";
import { getUserByGithubId } from "@/db/users";
import {
  ActionDeniedError,
  cancelWorkflowRun,
  deleteWorkflowRun,
  forceCancelWorkflowRun,
} from "@/lib/github/actions";
import { getWorkflowRunStatus } from "@/lib/github/runners";
import { hasSameOrigin, repoFullNamePattern } from "@/lib/request-security";

const bodySchema = z.object({
  repoFullName: z.string().regex(repoFullNamePattern),
  workflowRunId: z.number().int().positive(),
  action: z.enum(["cancel", "force-cancel", "delete"]),
});

const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "requested", "pending"]);

function auditAction(action: z.infer<typeof bodySchema>["action"]) {
  return action === "cancel" ? "cancel_workflow" : action === "force-cancel" ? "force_cancel_workflow" : "delete_workflow_run";
}

async function logPreflight(params: {
  githubUserId: number;
  action: z.infer<typeof bodySchema>["action"];
  repoFullName: string;
  workflowRunId: number;
  result: "failure" | "denied";
  message: string;
}) {
  const user = await getUserByGithubId(params.githubUserId);
  await logAudit({
    userId: user?.id ?? null,
    action: auditAction(params.action),
    result: params.result,
    repoFullName: params.repoFullName,
    targetId: String(params.workflowRunId),
    detail: { message: params.message, phase: "preflight" },
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasSameOrigin(req)) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  const { repoFullName, workflowRunId, action } = parsed.data;
  const auditParams = { githubUserId: session.user.githubId, action, repoFullName, workflowRunId };
  try {
    let status: string;
    try {
      status = await getWorkflowRunStatus(session.user.userId, repoFullName, workflowRunId);
    } catch (err) {
      await logPreflight({ ...auditParams, result: "failure", message: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    if (action === "delete") {
      if (status !== "completed") {
        await logPreflight({ ...auditParams, result: "denied", message: "只能删除已结束的 workflow run" });
        return NextResponse.json({ error: "只能删除已结束的 workflow run" }, { status: 409 });
      }
      await deleteWorkflowRun({ githubUserId: session.user.githubId, repoFullName, workflowRunId });
    } else {
      if (!ACTIVE_STATUSES.has(status.toLowerCase())) {
        await logPreflight({ ...auditParams, result: "denied", message: "只能取消活动中的 workflow run" });
        return NextResponse.json({ error: "只能取消活动中的 workflow run" }, { status: 409 });
      }
      const params = { githubUserId: session.user.githubId, repoFullName, workflowRunId };
      if (action === "cancel") await cancelWorkflowRun(params);
      else await forceCancelWorkflowRun(params);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof ActionDeniedError) return NextResponse.json({ error: err.message }, { status: 403 });
    console.error("Runner action failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "runner 操作失败" }, { status: 502 });
  }
}
