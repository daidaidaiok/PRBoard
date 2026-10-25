import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { DEFAULT_QUOTA_STOP_RATIO, isAllowedSecretName } from "@/lib/ai-review-config";
import { LANE_KEY_PATTERN, thinkingOptionsFor, validateLaneFields, type LaneKind, type LaneMeter, type ThinkingMode } from "@/lib/ai-review-lanes";
import { requireSession } from "@/lib/auth-guard";
import { hasSameOrigin } from "@/lib/request-security";

const MICRO_USD = 1_000_000;
const uuidSchema = z.string().uuid();

export function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

/**
 * 管理 API 的统一前置：登录会话 → （变更请求）同源校验。
 * GET 不传 request，只验会话；PUT/POST/PATCH/DELETE 传入 request 追加 CSRF 同源检查。
 */
export async function requireReviewAdmin(
  request?: NextRequest,
): Promise<{ ok: true; userId: number } | { ok: false; response: NextResponse }> {
  const session = await requireSession();
  if (!session) return { ok: false, response: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  if (request && !hasSameOrigin(request)) {
    return { ok: false, response: NextResponse.json({ error: "forbidden origin" }, { status: 403 }) };
  }
  return { ok: true, userId: session.user.userId };
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}


export const providerBodySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(["claude-oauth", "anthropic-compatible"]),
    baseUrl: z.string().max(300).nullable(),
    secretName: z.string().max(100).refine(isAllowedSecretName, "secret name must look like a provider credential"),
    /** 展示单位：token/count 为整数；usd 为美元（存储时换算成 micro-USD）。 */
    budgetLimit: z.number().positive().finite().nullable(),
    budgetUnit: z.enum(["token", "usd", "count"]).nullable(),
    /**
     * 仅订阅（claude-oauth）：任一限流窗口已用达到该百分比就暂停 review，窗口重置后自动恢复。
     * 省略 = 默认 95%；null = 只在 SDK 明确 rejected 时才停。
     */
    quotaStopPercent: z.number().int().min(50).max(100).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.budgetLimit === null) !== (value.budgetUnit === null)) {
      ctx.addIssue({ code: "custom", path: ["budgetLimit"], message: "budgetLimit and budgetUnit must be set together" });
    }
    if (value.budgetUnit && value.budgetUnit !== "usd" && !Number.isInteger(value.budgetLimit)) {
      ctx.addIssue({ code: "custom", path: ["budgetLimit"], message: "budgetLimit must be an integer" });
    }
    if (value.kind === "claude-oauth") {
      if (value.baseUrl !== null) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "oauth provider takes no baseUrl" });
      // 订阅按时间窗口限量，没有美元/token 预算这回事；预算只属于按量计费的 API key。
      if (value.budgetLimit !== null) ctx.addIssue({ code: "custom", path: ["budgetLimit"], message: "subscription providers are limited by window, not by budget" });
      return;
    }
    if (value.quotaStopPercent !== undefined && value.quotaStopPercent !== null) {
      ctx.addIssue({ code: "custom", path: ["quotaStopPercent"], message: "pause threshold only applies to subscription providers" });
    }
    let https = false;
    try {
      https = value.baseUrl !== null && new URL(value.baseUrl).protocol === "https:";
    } catch {
      https = false;
    }
    if (!https) ctx.addIssue({ code: "custom", path: ["baseUrl"], message: "baseUrl must be https" });
  });

export type ProviderBody = z.infer<typeof providerBodySchema>;

/** API 层展示单位 → 存储单位（usd 美元 → micro-USD）。 */
export function toStoredProvider(body: ProviderBody) {
  const { quotaStopPercent, ...rest } = body;
  return {
    ...rest,
    quotaStopRatio:
      body.kind !== "claude-oauth" ? null : quotaStopPercent === undefined ? DEFAULT_QUOTA_STOP_RATIO : quotaStopPercent === null ? null : quotaStopPercent / 100,
    budgetLimit: body.budgetLimit !== null && body.budgetUnit === "usd" ? Math.round(body.budgetLimit * MICRO_USD) : body.budgetLimit,
  };
}

export function toDisplayAmount(unit: "token" | "usd" | "count" | null, amount: number | null): number | null {
  if (amount === null) return null;
  return unit === "usd" ? amount / MICRO_USD : amount;
}

export function serializeProvider(row: {
  id: string;
  name: string;
  kind: string;
  baseUrl: string | null;
  secretName: string;
  budgetLimit: number | null;
  budgetUnit: "token" | "usd" | "count" | null;
  quotaStopRatio?: number | null;
}) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.baseUrl,
    secretName: row.secretName,
    budgetLimit: toDisplayAmount(row.budgetUnit, row.budgetLimit),
    budgetUnit: row.budgetUnit,
    quotaStopPercent: row.kind === "claude-oauth" && row.quotaStopRatio != null ? Math.round(row.quotaStopRatio * 100) : null,
  };
}

/** 创建一路通道。默认：开启、未接入（wired=false）、无思考值、无关联服务商。 */
export const laneBodySchema = z
  .object({
    laneKey: z.string().regex(LANE_KEY_PATTERN),
    label: z.string().trim().min(1).max(60),
    kind: z.enum(["claude-code", "api-script"]),
    thinkingMode: z.enum(["effort", "toggle", "none"]),
    enabled: z.boolean().default(true),
    wired: z.boolean().default(false),
    model: z.string().max(400),
    thinking: z.string().max(40).nullable().default(null),
    /** 仅展示用的 secret 名（密钥本身不进 PRboard）。 */
    credential: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).nullable().default(null),
    meter: z.enum(["subscription", "usd", "plan", "free"]),
    providerId: z.string().uuid().nullable().default(null),
    notes: z.string().max(200).nullable().default(null),
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  .strict()
  .superRefine((lane, ctx) => {
    const check = validateLaneFields(lane);
    if (!check.ok) ctx.addIssue({ code: "custom", path: [check.error.includes("thinking") ? "thinking" : "model"], message: check.error });
  });

export type LaneBody = z.infer<typeof laneBodySchema>;

/** 修改一路通道：只允许这些字段；kind / thinkingMode / laneKey 创建后不可改（它们决定了校验规则与 CI 的取值口径）。 */
export const lanePatchSchema = z
  .object({
    label: z.string().trim().min(1).max(60),
    enabled: z.boolean(),
    wired: z.boolean(),
    model: z.string().max(400),
    thinking: z.string().max(40).nullable(),
    credential: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).nullable(),
    providerId: z.string().uuid().nullable(),
    notes: z.string().max(200).nullable(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, "empty patch");

export function serializeLane(lane: {
  id: string;
  repoId: string;
  laneKey: string;
  label: string;
  kind: LaneKind;
  thinkingMode: ThinkingMode;
  enabled: boolean;
  wired: boolean;
  model: string;
  thinking: string | null;
  credential: string | null;
  meter: LaneMeter;
  providerId: string | null;
  notes: string | null;
  sortOrder: number;
}) {
  return {
    id: lane.id,
    repoId: lane.repoId,
    laneKey: lane.laneKey,
    label: lane.label,
    kind: lane.kind,
    thinkingMode: lane.thinkingMode,
    /** 该路支持的思考选项，面板据此渲染下拉框（空数组 = 没有思考控制，不显示该项）。 */
    thinkingOptions: thinkingOptionsFor(lane.thinkingMode),
    enabled: lane.enabled,
    wired: lane.wired,
    model: lane.model,
    thinking: lane.thinking,
    credential: lane.credential,
    meter: lane.meter,
    providerId: lane.providerId,
    notes: lane.notes,
    sortOrder: lane.sortOrder,
  };
}
