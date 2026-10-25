import { NextRequest, NextResponse } from "next/server";
import { rotateReviewToken } from "@/db/ai-review";
import { isUuid, requireReviewAdmin } from "@/lib/ai-review-admin";

export const runtime = "nodejs";

/** 轮换 token：旧 token 立即失效，新明文只在这次响应里出现。 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const token = await rotateReviewToken(admin.userId, id);
  if (!token) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ token });
}
