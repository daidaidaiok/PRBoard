import { NextRequest, NextResponse } from "next/server";
import { upsertProvider } from "@/db/ai-review";
import { providerBodySchema, readJson, requireReviewAdmin, serializeProvider, toStoredProvider } from "@/lib/ai-review-admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const admin = await requireReviewAdmin(request);
  if (!admin.ok) return admin.response;

  const parsed = providerBodySchema.safeParse(await readJson(request));
  if (!parsed.success) return NextResponse.json({ error: "invalid provider" }, { status: 400 });

  const created = await upsertProvider(admin.userId, toStoredProvider(parsed.data));
  if (created === "conflict" || !created) return NextResponse.json({ error: "provider name already exists" }, { status: 409 });
  return NextResponse.json(serializeProvider(created), { status: 201 });
}
