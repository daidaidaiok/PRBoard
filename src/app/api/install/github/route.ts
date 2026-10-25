import { randomBytes, createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { auth } from "@/auth";

function signState(value: string) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET is not set");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export async function GET() {
  const session = await auth();
  if (!session?.user) return NextResponse.redirect(new URL("/login", process.env.AUTH_URL ?? "http://localhost:3000"));
  const slug = process.env.GITHUB_APP_SLUG;
  if (!slug) return NextResponse.json({ error: "GITHUB_APP_SLUG is not configured" }, { status: 500 });
  const state = randomBytes(24).toString("base64url");
  const signed = `${state}.${signState(state)}`;
  const response = NextResponse.redirect(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
  response.cookies.set("prboard_install_state", signed, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 600, path: "/" });
  return response;
}
