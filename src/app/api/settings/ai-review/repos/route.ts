import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createReviewRepo } from "@/db/ai-review";
import { readJson, requireReviewAdmin } from "@/lib/ai-review-admin";
import { repoFullNamePattern } from "@/lib/request-security";

export const runtime = "nodejs";

// 共享的仓库名正则放行 "." / ".." 这类纯点号段；GitHub 不存在这样的 owner/仓库，这里拒绝。
const bodySchema = z
  .object({
    repoFullName: z
      .string()
      .regex(repoFullNamePattern)
      .refine((name) => name.split("/").every((part) => !/^\.+$/.test(part)), "dot-only segment"),
  })
  .strict();

/** 登记一个仓库；token 明文只在这次响应里出现，库里只有它的 SHA-256 摘要。 */
export async function POST(request: NextRequest) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid repoFullName" }, { status: 400 });

  const created = await createReviewRepo(admin.userId, parsed.data.repoFullName);
  if (!created) return NextResponse.json({ error: "repo already registered" }, { status: 409 });
  return NextResponse.json(created, { status: 201 });
}
