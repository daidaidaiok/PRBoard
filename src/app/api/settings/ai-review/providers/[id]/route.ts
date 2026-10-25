import { NextRequest, NextResponse } from "next/server";
import { deleteProvider, upsertProvider } from "@/db/ai-review";
import { isUuid, providerBodySchema, readJson, requireReviewAdmin, serializeProvider, toStoredProvider } from "@/lib/ai-review-admin";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** 整体替换（需带完整字段）：预算改动要连带重置预警去重状态，局部更新容易漏。 */
export async function PUT(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = providerBodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid provider" }, { status: 400 });

  const updated = await upsertProvider(admin.userId, toStoredProvider(parsed.data), id);
  if (updated === "conflict") return NextResponse.json({ error: "provider name already exists" }, { status: 409 });
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(serializeProvider(updated));
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!(await deleteProvider(admin.userId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
