import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getNotificationSettings, upsertNotificationSettings } from "@/db/notification-settings";
import { maskBarkUrl, parseBarkUrl } from "@/lib/bark";

function serialize(settings: Awaited<ReturnType<typeof getNotificationSettings>>) {
  return {
    barkUrlMasked: settings.barkUrl ? maskBarkUrl(settings.barkUrl) : null,
    hasBarkUrl: settings.barkUrl !== null,
    notifyCiGreen: settings.notifyCiGreen,
    notifyRetryExhausted: settings.notifyRetryExhausted,
    notifyPrConflict: settings.notifyPrConflict,
    notifyDeployFailed: settings.notifyDeployFailed,
  };
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  return NextResponse.json(serialize(await getNotificationSettings(session.user.userId)));
}

export async function PUT(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  // barkUrl 只取自本端点：null/undefined 语义不同——null 清除配置，
  // undefined 表示这次不动它（只改开关）。
  let barkUrl: string | null | undefined;
  if (typeof input.barkUrl === "string") {
    const trimmed = input.barkUrl.trim();
    if (trimmed === "") {
      barkUrl = null;
    } else {
      barkUrl = parseBarkUrl(trimmed);
      if (!barkUrl) return NextResponse.json({ error: "invalid barkUrl" }, { status: 400 });
    }
  } else if (input.barkUrl === null) {
    barkUrl = null;
  }

  const booleanFields = ["notifyCiGreen", "notifyRetryExhausted", "notifyPrConflict", "notifyDeployFailed"] as const;
  const patch: Record<string, unknown> = {};
  for (const field of booleanFields) {
    if (typeof input[field] === "boolean") patch[field] = input[field];
  }
  if (barkUrl !== undefined) patch.barkUrl = barkUrl;

  const settings = await upsertNotificationSettings(session.user.userId, patch);
  return NextResponse.json(serialize(settings));
}
