import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { getInstallation, linkInstallationToUser } from "@/db/installations";
import { syncAllInstallations } from "@/lib/github/sync";

function validState(value: string | undefined) {
  if (!value) return false;
  const [state, signature] = value.split(".");
  const secret = process.env.AUTH_SECRET;
  if (!state || !signature || !secret) return false;
  const expected = createHmac("sha256", secret).update(state).digest("base64url");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const base = process.env.AUTH_URL ?? req.nextUrl.origin;
  if (!session?.user) return NextResponse.redirect(new URL("/login", base));
  if (!validState(req.cookies.get("prboard_install_state")?.value)) {
    return NextResponse.redirect(new URL("/?install=invalid_state", base));
  }
  const installationId = Number(req.nextUrl.searchParams.get("installation_id"));
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return NextResponse.redirect(new URL("/?install=missing", base));
  }

  await syncAllInstallations();
  const installation = await getInstallation(installationId);
  if (!installation || installation.accountGithubId !== session.user.githubId) {
    return NextResponse.redirect(new URL("/?install=not_owned", base));
  }
  await linkInstallationToUser(session.user.userId, installationId);
  const response = NextResponse.redirect(new URL("/?install=success", base));
  response.cookies.delete("prboard_install_state");
  return response;
}
