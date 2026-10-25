import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getNotificationSettings } from "@/db/notification-settings";
import { parseBarkUrl, sendBarkNotification } from "@/lib/bark";

export async function POST(request: Request) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let input: Record<string, unknown> = {};
  try {
    input = (await request.json()) ?? {};
  } catch {
    // 无 body 视为"测试已保存的 URL"
  }

  // 允许测试尚未保存的输入（"先测试再保存"），否则回落到已存配置。
  let target: string | null = null;
  if (typeof input.barkUrl === "string" && input.barkUrl.trim() !== "") {
    target = parseBarkUrl(input.barkUrl.trim());
    if (!target) return NextResponse.json({ error: "invalid barkUrl" }, { status: 400 });
  } else {
    target = (await getNotificationSettings(session.user.userId)).barkUrl;
  }
  if (!target) return NextResponse.json({ error: "no barkUrl configured" }, { status: 400 });

  const result = await sendBarkNotification(
    target,
    { title: "PRboard 测试推送", body: "设置页测试推送 · 收到即链路畅通", level: "active" },
    { group: "prboard-test" },
  );
  return NextResponse.json(result);
}
