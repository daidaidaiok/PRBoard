export interface BarkNotification {
  title: string;
  body: string;
  url?: string;
  level?: "active" | "timeSensitive" | "passive";
}

export interface BarkPushResult {
  ok: boolean;
  status?: number;
}

const DEFAULT_GROUP = "prboard-ci";

/**
 * Validates a user-supplied Bark push URL and normalizes it for storage:
 * must be http(s) (self-hosted bark servers are often plain http on a LAN),
 * trailing slash stripped so path appending stays predictable.
 * Returns null instead of throwing so API routes can 400 cleanly.
 */
export function parseBarkUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.href.replace(/\/$/, "");
}

/**
 * Safe-to-display form: origin plus the last 4 chars of the last path
 * segment (the device key). Only ever sent to the settings page — the full
 * URL works as a "push to this phone" credential and must not leak.
 */
export function maskBarkUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const key = segments.at(-1) ?? "";
  const tail = key.slice(-4);
  return `${url.origin}/${key.length > 4 ? "…" : ""}${tail}`;
}

/**
 * Bark（https://bark.day.app）推送：路径本身即正文，device key 已经编进
 * `barkUrl`（形如 https://.../<device-key>，存于调用方查出的用户设置里）。
 *
 * 用 `url.pathname = ...` 而不是手写 encodeURIComponent：URL 的 path 解析
 * 会把字符串里的 '/' 当成路径分隔符保留，只转义其它特殊字符——正好是
 * bark-worker 想要的效果（body 常带 owner/repo 这种自带斜杠的内容,转义成
 * %2F 不会出错但推送里会显示成 %2F,体验更差）。
 *
 * 返回 Bark 服务器的响应状态而不是抛错/只记日志：测试推送端点需要把它
 * 反馈给设置页；周期性通知的调用方照旧忽略返回值。
 */
export async function sendBarkNotification(
  barkUrl: string,
  notification: BarkNotification,
  options: { group?: string } = {},
): Promise<BarkPushResult> {
  const url = new URL(barkUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${notification.body}`;
  url.searchParams.set("title", notification.title);
  url.searchParams.set("group", options.group ?? DEFAULT_GROUP);
  url.searchParams.set("level", notification.level ?? "active");
  if (notification.url) url.searchParams.set("url", notification.url);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.error(`[bark] push failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
    return { ok: res.ok, status: res.status };
  } catch (error) {
    console.error("[bark] push error", error);
    return { ok: false };
  }
}
