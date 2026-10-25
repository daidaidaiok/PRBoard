import { NextRequest, NextResponse } from "next/server";
import { deleteLane, getLane, updateLane } from "@/db/ai-review-lanes";
import { isUuid, lanePatchSchema, readJson, requireReviewAdmin, serializeLane } from "@/lib/ai-review-admin";
import { validateLaneFields } from "@/lib/ai-review-lanes";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = lanePatchSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid patch" }, { status: 400 });
  const patch = parsed.data;

  const current = await getLane(admin.userId, id);
  if (!current) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 模型/思考按"这一路自己的家族"校验：Claude 路的模型是 --model 参数，不许逗号；GLM 只认 off/on/max；
  // Haiku / 免费池没有思考控制。创建后 kind / thinkingMode 不可改，所以规则不会被绕开。
  if (patch.model !== undefined || patch.thinking !== undefined) {
    const check = validateLaneFields({
      kind: current.kind,
      thinkingMode: current.thinkingMode,
      model: patch.model ?? current.model,
      thinking: patch.thinking === undefined ? current.thinking : patch.thinking,
    });
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });
  }

  const updated = await updateLane(admin.userId, id, patch);
  if (updated === "invalid_provider") return NextResponse.json({ error: "invalid provider" }, { status: 400 });
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(serializeLane(updated));
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!(await deleteLane(admin.userId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
