import { NextRequest, NextResponse } from "next/server";
import { getWebhooks } from "@/lib/github/webhooks";
import type { EmitterWebhookEventName } from "@octokit/webhooks";

export async function POST(req: NextRequest) {
  const id = req.headers.get("x-github-delivery");
  const name = req.headers.get("x-github-event");
  const signature = req.headers.get("x-hub-signature-256");
  const payload = await req.text();

  if (!id || !name || !signature) {
    return NextResponse.json({ error: "missing required GitHub webhook headers" }, { status: 400 });
  }

  try {
    await getWebhooks().verifyAndReceive({
      id,
      name: name as EmitterWebhookEventName,
      payload,
      signature,
    });
  } catch (err) {
    // Signature mismatch or a handler threw. Either way, don't leak details.
    console.error("GitHub webhook rejected", err);
    return NextResponse.json({ error: "invalid signature or handler error" }, { status: 401 });
  }

  return NextResponse.json({ ok: true });
}
