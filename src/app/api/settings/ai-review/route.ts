import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { listReviewOverview, setGlobalPause } from "@/db/ai-review";
import { listLanes } from "@/db/ai-review-lanes";
import { readJson, requireReviewAdmin, serializeLane, serializeProvider, toDisplayAmount } from "@/lib/ai-review-admin";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireReviewAdmin();
  if (!admin.ok) return admin.response;

  const [overview, lanes] = await Promise.all([listReviewOverview(admin.userId), listLanes(admin.userId)]);
  return NextResponse.json({
    paused: overview.paused,
    providers: overview.providers.map((provider) => ({
      ...serializeProvider(provider),
      usedThisPeriod: toDisplayAmount(provider.budgetUnit, provider.usedThisPeriod),
      status: provider.status,
      usage: {
        tokens: provider.totals.inputTokens + provider.totals.outputTokens,
        // 订阅不按钱计费，只给次数与 token；金额只对按量计费的 API key 有意义。
        costUsd: provider.kind === "claude-oauth" ? null : provider.totals.costMicroUsd / 1_000_000,
        count: provider.totals.count,
      },
      quota: provider.quota
        ? {
            windows: provider.quota.windows.map((w) => ({
              type: w.type,
              usedPercent: w.utilization === null ? null : Math.round(w.utilization * 1000) / 10,
              resetsAt: w.resetsAt ? w.resetsAt.toISOString() : null,
            })),
            stopPercent: provider.quota.stopRatio === null ? null : Math.round(provider.quota.stopRatio * 100),
            status: provider.quota.status,
            observedAt: provider.quota.observedAt ? provider.quota.observedAt.toISOString() : null,
          }
        : null,
    })),
    repos: overview.repos.map((repo) => ({
      ...repo,
      lanes: lanes.filter((lane) => lane.repoId === repo.id).map(serializeLane),
    })),
  });
}

const pauseSchema = z.object({ paused: z.boolean() }).strict();

export async function PUT(request: NextRequest) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = pauseSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  await setGlobalPause(admin.userId, parsed.data.paused);
  return NextResponse.json({ paused: parsed.data.paused });
}
