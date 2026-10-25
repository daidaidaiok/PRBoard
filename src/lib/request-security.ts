import type { NextRequest } from "next/server";

/** GitHub owner/repository names accepted by all resource APIs. */
export const repoFullNamePattern = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** First entry of a comma-separated forwarded header (chained proxies append). */
function firstForwardedValue(value: string | null): string | null {
  if (!value) return null;
  const first = value.split(",")[0]?.trim();
  return first || null;
}

/**
 * The origin the browser actually talked to. Behind a reverse proxy, `next
 * start` builds req.nextUrl from localhost, so the public host/proto must
 * come from the proxy's x-forwarded-* headers — the same source Auth.js
 * trusts via AUTH_TRUST_HOST. Falls back to the request URL when no proxy
 * headers exist (direct access, serverless platforms).
 */
function appOrigin(req: NextRequest): string {
  const forwardedHost = firstForwardedValue(req.headers.get("x-forwarded-host"));
  const host = forwardedHost ?? req.headers.get("host");
  if (!host) return req.nextUrl.origin;
  const forwardedProto = firstForwardedValue(req.headers.get("x-forwarded-proto"));
  if (forwardedProto) return new URL(`${forwardedProto.toLowerCase()}://${host}`).origin;
  // Proxy present but tight-lipped about the scheme (e.g. host-only nginx
  // configs): `next start` builds req.nextUrl from localhost, so a host
  // mismatch proves TLS termination sits in front of us. Same-host access
  // (direct, serverless) keeps the request scheme.
  const proxied = host.toLowerCase() !== req.nextUrl.host.toLowerCase();
  return new URL(`${proxied ? "https" : req.nextUrl.protocol.replace(":", "")}://${host}`).origin;
}

/**
 * Browser mutation requests must originate from this application.  Requests
 * without an Origin header remain supported for server-to-server callers and
 * are still protected by the Auth.js session and SameSite cookies.
 */
export function hasSameOrigin(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (new URL(origin).origin !== appOrigin(req)) return false;
    } catch {
      return false;
    }
  }
  return req.headers.get("sec-fetch-site") !== "cross-site";
}
