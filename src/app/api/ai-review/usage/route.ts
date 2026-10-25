import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { recordReviewUsage, upsertQuotaWindows } from "@/db/ai-review";
import { checkBudgetAlert } from "@/db/ai-review-budget-alert";
import { authenticateReviewBearer, repoMismatchResponse } from "@/lib/ai-review-request-auth";

export const runtime = "nodejs";

const MAX_BODY_CHARS = 4_096;

const usageSchema = z.object({
  repo: z.string().min(3).max(200),
  model: z.string().min(1).max(100),
  inputTokens: z.number().int().min(0).max(1_000_000_000),
  outputTokens: z.number().int().min(0).max(1_000_000_000),
  costMicroUsd: z.number().int().min(0).max(1_000_000_000_000).nullish(),
  prNumber: z.number().int().min(1).max(10_000_000).nullish(),
  runId: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  runAttempt: z.number().int().min(1).max(1_000),
  /** Claude 订阅各限流窗口的读数（来自 rate_limit_event）；utilization 为 0..1 的已用比例。 */
  rateLimits: z
    .array(
      z
        .object({
          type: z.string().regex(/^[a-z_]{1,40}$/),
          utilization: z.number().min(0).max(1).nullable(),
          resetsAt: z.string().datetime({ offset: true }).nullable(),
          status: z.enum(["allowed", "allowed_warning", "rejected"]).nullable(),
        })
        .strict(),
    )
    .max(8)
    .optional(),
}).strict();

/** CI 结束后的 `ai-review-usage` action 回报用量；(repo, runId, runAttempt) 幂等。 */
export async function POST(request: NextRequest) {
  // 先验 token 再读 body：匿名请求不能让服务端缓冲任意大的请求体。
  const authenticated = await authenticateReviewBearer(request);
  if (!authenticated.ok) return authenticated.response;

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_CHARS) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return NextResponse.json({ error: "payload too large" }, { status: 413 });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid usage payload" }, { status: 400 });
  }
  const parsed = usageSchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "invalid usage payload" }, { status: 400 });

  const mismatch = repoMismatchResponse(authenticated.auth, parsed.data.repo);
  if (mismatch) return mismatch;

  try {
    const usage = parsed.data;
    const result = await recordReviewUsage(authenticated.auth.repoId, {
      providerId: authenticated.auth.providerId,
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicroUsd: usage.costMicroUsd ?? null,
      prNumber: usage.prNumber ?? null,
      runId: usage.runId,
      runAttempt: usage.runAttempt,
    });
    if (result === "recorded" && authenticated.auth.providerId && usage.rateLimits?.length) {
      // 窗口读数是附带信息：写失败不能让这次用量回报报错。
      await upsertQuotaWindows(
        authenticated.auth.providerId,
        usage.rateLimits.map((w) => ({ type: w.type, utilization: w.utilization, resetsAt: w.resetsAt ? new Date(w.resetsAt) : null, status: w.status })),
      ).catch((error) => console.error("AI review quota windows save failed", error instanceof Error ? error.message : "unknown error"));
    }
    if (result === "recorded" && authenticated.auth.providerId) {
      void checkBudgetAlert(authenticated.auth.userId, authenticated.auth.providerId).catch(() => {
        // 预警推送是 best-effort；回报本身已入库，不能因为 Bark 故障让 CI 侧报错。
      });
    }
    return NextResponse.json({ ok: true, result }, { status: result === "recorded" ? 202 : 200 });
  } catch (error) {
    console.error("AI review usage record failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "ai review unavailable" }, { status: 502 });
  }
}
