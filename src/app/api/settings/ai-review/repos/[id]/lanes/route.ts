import { NextRequest, NextResponse } from "next/server";
import { createLane } from "@/db/ai-review-lanes";
import { isUuid, laneBodySchema, readJson, requireReviewAdmin, serializeLane } from "@/lib/ai-review-admin";

export const runtime = "nodejs";

/** 给一个仓库登记一路 review 通道（默认未接入，只是记录；接入由 CI 侧读配置后把 wired 置 true）。 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = laneBodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid lane" }, { status: 400 });

  const created = await createLane(admin.userId, id, parsed.data);
  if (created === null) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (created === "conflict") return NextResponse.json({ error: "lane already exists" }, { status: 409 });
  if (created === "invalid_provider") return NextResponse.json({ error: "invalid provider" }, { status: 400 });
  return NextResponse.json(serializeLane(created), { status: 201 });
}
