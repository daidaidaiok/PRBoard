import { NextRequest, NextResponse } from "next/server";
import { loadReviewConfigInput, touchReviewConfigPull } from "@/db/ai-review";
import { loadLaneConfig } from "@/db/ai-review-lanes";
import { resolveLaneConfig, resolveReviewConfig } from "@/lib/ai-review-config";
import { LANE_KEY_PATTERN } from "@/lib/ai-review-lanes";
import { authenticateReviewRequest } from "@/lib/ai-review-request-auth";

export const runtime = "nodejs";

/**
 * 各仓库 CI 的 `ai-review-config` action 在每次 review 开头调用。
 * 禁用（paused/disabled/no_provider/budget_exhausted）是 200 + enabled:false，
 * 与"PRboard 故障"（5xx / 超时，CI 回退到内置默认配置）严格区分。
 * 响应只含 secret 的名字，从不含密钥。
 */
export async function GET(request: NextRequest) {
  const repo = request.nextUrl.searchParams.get("repo");
  if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });

  const lane = request.nextUrl.searchParams.get("lane");
  if (lane !== null && !LANE_KEY_PATTERN.test(lane)) return NextResponse.json({ error: "invalid lane" }, { status: 400 });

  const authenticated = await authenticateReviewRequest(request, repo);
  if (!authenticated.ok) return authenticated.response;

  void touchReviewConfigPull(authenticated.auth.repoId).catch(() => {
    // 仅用于设置页展示"最近拉配置"，写失败不影响配置下发。
  });
  if (lane !== null) {
    try {
      const loaded = await loadLaneConfig(authenticated.auth.repoId, authenticated.auth.userId, lane);
      // 不认识的通道 → 404：action 把任何非 200 都当作"拿不到配置"而回退到该 workflow 内置的默认。
      if (!loaded) return NextResponse.json({ error: "lane not found" }, { status: 404 });
      return NextResponse.json(resolveLaneConfig({ paused: loaded.paused, lane: loaded.lane, resolution: loaded.resolution }), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error("AI review lane config load failed", error instanceof Error ? error.message : "unknown error");
      return NextResponse.json({ error: "ai review unavailable" }, { status: 502 });
    }
  }

  try {
    const input = await loadReviewConfigInput(authenticated.auth.repoId, authenticated.auth.userId);
    return NextResponse.json(resolveReviewConfig(input), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("AI review config load failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "ai review unavailable" }, { status: 502 });
  }
}
