import { NextResponse, type NextRequest } from "next/server";
import { authenticateReviewToken } from "@/db/ai-review";

type ReviewAuth = NonNullable<Awaited<ReturnType<typeof authenticateReviewToken>>>;

function bearerToken(request: NextRequest): string | null {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  return match?.[1] ?? null;
}

/**
 * CI 端点（config / usage）共用的鉴权：token 必须有效（authenticateReviewBearer），
 * 且 token 绑定的仓库必须等于请求声称的仓库（repoMismatchResponse，GitHub 仓库名
 * 大小写不敏感）。绑定不一致统一返回 403 `forbidden`，不区分"对方仓库存不存在"，
 * 避免一个仓库的 token 探测其它仓库。usage 先验 token 再读请求体，匿名请求读不到 body。
 * DB 异常返回 502——action 侧据此判定为"PRboard 不可达"并回退到内置默认配置。
 */
export async function authenticateReviewBearer(
  request: NextRequest,
): Promise<{ ok: true; auth: ReviewAuth } | { ok: false; response: NextResponse }> {
  const token = bearerToken(request);
  if (!token) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };

  let auth: Awaited<ReturnType<typeof authenticateReviewToken>>;
  try {
    auth = await authenticateReviewToken(token);
  } catch (error) {
    console.error("AI review token verification failed", error instanceof Error ? error.message : "unknown error");
    return { ok: false, response: NextResponse.json({ error: "ai review unavailable" }, { status: 502 }) };
  }
  if (!auth) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  return { ok: true, auth };
}

/** token 绑定的仓库与请求声称的仓库不一致 → 403（大小写不敏感）；一致返回 null。 */
export function repoMismatchResponse(auth: ReviewAuth, claimedRepo: string): NextResponse | null {
  if (auth.repoFullName.toLowerCase() === claimedRepo.toLowerCase()) return null;
  return NextResponse.json({ error: "forbidden" }, { status: 403 });
}

export async function authenticateReviewRequest(
  request: NextRequest,
  claimedRepo: string,
): Promise<{ ok: true; auth: ReviewAuth } | { ok: false; response: NextResponse }> {
  const authenticated = await authenticateReviewBearer(request);
  if (!authenticated.ok) return authenticated;
  const mismatch = repoMismatchResponse(authenticated.auth, claimedRepo);
  return mismatch ? { ok: false, response: mismatch } : authenticated;
}
