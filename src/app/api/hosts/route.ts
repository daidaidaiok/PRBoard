import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createMonitorHost, deleteMonitorHost, listMonitorCapacityDomains } from "@/db/host-monitor";
import { requireSession } from "@/lib/auth-guard";
import { hasSameOrigin } from "@/lib/request-security";

const createHostSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  platform: z.enum(["macos", "windows", "linux"]),
  capacityDomain: z.string().trim().min(1).max(80),
  capacityRole: z.enum(["primary", "shared"]),
  runnerName: z.string().trim().min(1).max(128).nullable(),
  runnerCpuReserveMilliCores: z.number().int().min(250).max(128_000),
  runnerMemoryReserveMib: z.number().int().min(512).max(4_194_304),
}).strict();

function isUniqueConstraint(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function GET() {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ domains: await listMonitorCapacityDomains(session.user.userId) });
  } catch (error) {
    console.error("Host capacity read failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "host capacity unavailable" }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasSameOrigin(req)) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  const parsed = createHostSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid request body" }, { status: 400 });

  try {
    const created = await createMonitorHost(session.user.userId, parsed.data);
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    if (isUniqueConstraint(error)) {
      return NextResponse.json({ error: "主机名称重复，或容量域已经有主容量来源" }, { status: 409 });
    }
    console.error("Host registration failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "host registration failed" }, { status: 502 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession();
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasSameOrigin(req)) return NextResponse.json({ error: "forbidden origin" }, { status: 403 });
  const hostId = z.string().uuid().safeParse(req.nextUrl.searchParams.get("hostId"));
  if (!hostId.success) return NextResponse.json({ error: "invalid host id" }, { status: 400 });

  try {
    const deleted = await deleteMonitorHost(session.user.userId, hostId.data);
    if (!deleted) return NextResponse.json({ error: "host not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Host deletion failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "host deletion failed" }, { status: 502 });
  }
}
