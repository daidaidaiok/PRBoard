import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { DEFAULT_REVIEW_MODEL, deleteReviewRepo, updateReviewRepo } from "@/db/ai-review";
import { isUuid, readJson, requireReviewAdmin } from "@/lib/ai-review-admin";
import { validateReviewFields } from "@/lib/ai-review-config";

export const runtime = "nodejs";

const patchSchema = z
  .object({
    enabled: z.boolean(),
    providerId: z.string().uuid().nullable(),
    model: z.string(),
    thinkingLevel: z.string().nullable(),
    extraArgs: z.array(z.string()),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "empty patch");

type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const patch = parsed.data;

  // 白名单校验：model / thinkingLevel / extraArgs 最终会拼进 claude-code-action 的参数。
  const validation = validateReviewFields({
    model: patch.model ?? DEFAULT_REVIEW_MODEL,
    thinkingLevel: patch.thinkingLevel ?? null,
    extraArgs: patch.extraArgs ?? [],
  });
  if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

  const updated = await updateReviewRepo(admin.userId, id, patch);
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest, { params }: Context) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  if (!(await deleteReviewRepo(admin.userId, id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
