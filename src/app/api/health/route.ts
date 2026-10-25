import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health — unauthenticated deploy probe.
 *
 * `deploy-sync-check.yml` compares the `sha` here against GitHub main HEAD to
 * detect a silently dead deploy trigger (push landed, Coolify build never
 * ran). The sha chain mirrors the sibling-project convention: Vercel injects VERCEL_GIT_COMMIT_SHA,
 * plain git checkouts GIT_COMMIT_SHA, and Coolify's build injects
 * SOURCE_COMMIT — so the field survives a future hosting move. `unknown`
 * means no platform variable was injected and version comparison is
 * impossible; the workflow treats that as a failure.
 *
 * force-dynamic: a prerendered response would freeze uptime/timestamp and
 * report the build-time sha forever.
 */
export function GET() {
  return NextResponse.json({
    status: "ok",
    version: process.env.npm_package_version || "0.1.0",
    sha: process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.SOURCE_COMMIT || "unknown",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
}
