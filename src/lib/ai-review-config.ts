// AI review 配置的纯函数决策层：把 DB 里的仓库/服务商/用量状态折叠成
// CI 能直接消费的一份配置（或"禁用 + 原因"）。无 IO，便于穷举边界。

export type ReviewDisableReason = "paused" | "disabled" | "budget_exhausted" | "quota_exhausted" | "no_provider";
export type ProviderKind = "claude-oauth" | "anthropic-compatible";
export type BudgetUnit = "token" | "usd" | "count";

export const THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 达到上限的 90% 起算"warn"（页面标黄 + Bark 预警）。 */
export const BUDGET_WARN_RATIO = 0.9;

/**
 * extra_args 白名单：首版只放行 `--max-turns <正整数>`。
 * 任意参数会让设置页变成"向 claude-code-action 注入 CLI flag"的入口
 * （如 --allowedTools 能放大 review agent 的权限），所以宁缺毋滥。
 */
export const ALLOWED_EXTRA_ARGS = {
  "--max-turns": /^[1-9][0-9]{0,3}$/,
} as const satisfies Record<string, RegExp>;

/** Claude 订阅窗口的黄色警戒线；停用线由服务商的 quotaStopRatio 决定。 */
export const QUOTA_WARN_RATIO = 0.8;
/** 订阅窗口默认在 95% 暂停——给你自己交互使用 Claude Code 留一点余量。 */
export const DEFAULT_QUOTA_STOP_RATIO = 0.95;

/**
 * Claude 订阅（Max/Pro）的一个限流窗口，来自 claude-code-action 的 execution_file 里的
 * `rate_limit_event`：five_hour / seven_day / seven_day_opus / seven_day_sonnet。
 * utilization 是已用比例 0..1（不是金额）；订阅按窗口限量，没有"美元预算"这回事。
 */
export interface QuotaWindow {
  type: string;
  utilization: number | null;
  resetsAt: Date | null;
  status: "allowed" | "allowed_warning" | "rejected" | null;
}

export interface QuotaState {
  windows: QuotaWindow[];
  /** 已用比例达到该值就暂停；null = 只在 SDK 明确 rejected 时才停。 */
  stopRatio: number | null;
}

const QUOTA_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5 小时窗口",
  seven_day: "7 天窗口",
  seven_day_opus: "Opus 7 天窗口",
  seven_day_sonnet: "Sonnet 7 天窗口",
};

/** 窗口的人话名；SDK 新增的窗口类型原样显示，不丢。 */
export function quotaWindowLabel(type: string): string {
  return QUOTA_WINDOW_LABELS[type] ?? type;
}

const QUOTA_SEVERITY = { ok: 0, warn: 1, exhausted: 2 } as const;

/**
 * 汇总订阅窗口：取最紧的那个窗口作为"约束窗口"。
 * - 重置时间已过的窗口视为已重置，直接忽略——否则暂停期间没有新的 review 来刷新读数，
 *   旧的高读数会让它永远停着；重置时间未知的窗口则保留（无法证明它已重置）。
 * - SDK 自己报的 rejected / allowed_warning 与比例阈值取更严的那个。
 */
export function quotaStatus(
  windows: QuotaWindow[],
  stopRatio: number | null,
  now: Date,
): { status: "ok" | "warn" | "exhausted"; binding: QuotaWindow | null } {
  let status: "ok" | "warn" | "exhausted" = "ok";
  let binding: QuotaWindow | null = null;
  let bindingRatio = -1;
  for (const window of windows) {
    if (window.resetsAt !== null && window.resetsAt.getTime() <= now.getTime()) continue;
    let own: "ok" | "warn" | "exhausted" = "ok";
    if (window.utilization !== null) {
      if (stopRatio !== null && window.utilization >= stopRatio) own = "exhausted";
      else if (window.utilization >= QUOTA_WARN_RATIO) own = "warn";
    }
    if (window.status === "rejected") own = "exhausted";
    else if (window.status === "allowed_warning" && own === "ok") own = "warn";
    const ratio = window.utilization ?? (own === "exhausted" ? 1 : 0);
    if (QUOTA_SEVERITY[own] > QUOTA_SEVERITY[status] || (own === status && ratio > bindingRatio)) {
      status = own;
      binding = window;
      bindingRatio = ratio;
    }
  }
  return { status, binding };
}

export interface ReviewConfigInput {
  paused: boolean;
  repo: { enabled: boolean; model: string; thinkingLevel: string | null; extraArgs: unknown };
  provider: {
    kind: ProviderKind;
    baseUrl: string | null;
    secretName: string;
    budgetLimit: number | null;
    budgetUnit: BudgetUnit | null;
  } | null;
  /** 本预算周期已用量，单位与 provider.budgetUnit 一致。 */
  usedThisPeriod: number;
  /** Claude 订阅的限流窗口读数（仅 claude-oauth 服务商有）。 */
  quota?: QuotaState;
  now?: Date;
}

export type LaneConfigResult =
  | {
      enabled: true;
      kind: "claude-code" | "api-script";
      /** 关联了服务商才有；没有则凭据完全留在 CI 自己的 secret 里。 */
      providerKind: ProviderKind | null;
      baseUrl: string | null;
      /** 优先取服务商的 secret 名，否则是该路自己记录的凭据名（仅作传递，密钥从不经过 PRboard）。 */
      secretName: string | null;
      model: string;
      thinking: string | null;
      extraArgs: string[];
    }
  | { enabled: false; reason: ReviewDisableReason };

export type ReviewConfigResult =
  | {
      enabled: true;
      providerKind: ProviderKind;
      baseUrl: string | null;
      secretName: string;
      model: string;
      thinking: string | null;
      extraArgs: string[];
    }
  | { enabled: false; reason: ReviewDisableReason };

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  count: number;
}

/**
 * 把一个周期内的用量合计折算成预算单位。usd 预算以 micro-USD 存储
 * （与 ai_review_usage.cost_micro_usd 同单位，避免小数换算误差；
 * 设置页/API 层负责美元 ↔ micro-USD 转换）。
 */
export function usedInUnit(unit: BudgetUnit | null, totals: UsageTotals): number {
  switch (unit) {
    case "token":
      return totals.inputTokens + totals.outputTokens;
    case "usd":
      return totals.costMicroUsd;
    case "count":
      return totals.count;
    default:
      return 0;
  }
}

export function budgetStatus(limit: number | null, used: number): "ok" | "warn" | "exhausted" {
  if (limit === null) return "ok";
  if (used >= limit) return "exhausted";
  if (used >= limit * BUDGET_WARN_RATIO) return "warn";
  return "ok";
}

/** 预算周期：UTC 自然月，返回当月 1 日 00:00:00.000Z。 */
export function currentPeriodStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function resolveReviewConfig(input: ReviewConfigInput): ReviewConfigResult {
  if (input.paused) return { enabled: false, reason: "paused" };
  if (!input.repo.enabled) return { enabled: false, reason: "disabled" };
  if (!input.provider) return { enabled: false, reason: "no_provider" };
  if (budgetStatus(input.provider.budgetLimit, input.usedThisPeriod) === "exhausted") {
    return { enabled: false, reason: "budget_exhausted" };
  }
  if (input.quota && quotaStatus(input.quota.windows, input.quota.stopRatio, input.now ?? new Date()).status === "exhausted") {
    return { enabled: false, reason: "quota_exhausted" };
  }
  return {
    enabled: true,
    providerKind: input.provider.kind,
    baseUrl: input.provider.baseUrl,
    secretName: input.provider.secretName,
    model: input.repo.model,
    thinking: input.repo.thinkingLevel,
    // 出口再兜一层：库里的 jsonb 理论上已校验，但这里不信任存量数据。
    extraArgs: Array.isArray(input.repo.extraArgs)
      ? input.repo.extraArgs.filter((arg): arg is string => typeof arg === "string")
      : [],
  };
}

/**
 * 服务商 secret 名白名单：只放行"像服务商凭据"的名字。secret 名最终会作为
 * `secrets[<name>]` 的键、连同 baseUrl 一起交给 claude-code-action；若放任任意
 * 名字，被攻破的 PRboard 就能让 CI 把仓库里任何 secret（如 DEPLOY_KEY）当作 API
 * key 发往攻击者端点。GITHUB_ 前缀是 GitHub 保留名，一并拒绝。
 * ai-review-config/run.sh 里有同一条正则，改一边必须同步改另一边。
 */
export function isAllowedSecretName(name: string): boolean {
  if (/^GITHUB_/.test(name)) return false;
  return /^(AI_REVIEW_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN(_[0-9]+)?))$/.test(name);
}

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

export function validateReviewFields(fields: {
  model: string;
  thinkingLevel: string | null;
  extraArgs: unknown;
  baseUrl?: string | null;
}): { ok: true } | { ok: false; error: string } {
  if (!MODEL_PATTERN.test(fields.model)) return { ok: false, error: "invalid model" };
  if (fields.thinkingLevel !== null && !(THINKING_LEVELS as readonly string[]).includes(fields.thinkingLevel)) {
    return { ok: false, error: "invalid thinkingLevel" };
  }
  if (!Array.isArray(fields.extraArgs) || fields.extraArgs.length % 2 !== 0) {
    return { ok: false, error: "invalid extraArgs" };
  }
  for (let i = 0; i < fields.extraArgs.length; i += 2) {
    const flag = fields.extraArgs[i];
    const value = fields.extraArgs[i + 1];
    const pattern = typeof flag === "string" && Object.hasOwn(ALLOWED_EXTRA_ARGS, flag)
      ? ALLOWED_EXTRA_ARGS[flag as keyof typeof ALLOWED_EXTRA_ARGS]
      : null;
    if (!pattern || typeof value !== "string" || !pattern.test(value)) {
      return { ok: false, error: "invalid extraArgs" };
    }
  }
  if (fields.baseUrl) {
    let url: URL;
    try {
      url = new URL(fields.baseUrl);
    } catch {
      return { ok: false, error: "invalid baseUrl" };
    }
    if (url.protocol !== "https:") return { ok: false, error: "invalid baseUrl" };
  }
  return { ok: true };
}

/**
 * 一路通道（Haiku / GLM / 免费池 / mention …）的配置决策。
 * 全局暂停 > 该路自己的开关 > 关联服务商的预算 / 订阅窗口（沿用 resolveReviewConfig 的同一套判定）。
 * 模型与思考永远取该路自己的值；没有关联服务商的通道不受预算 / 额度约束。
 */
export function resolveLaneConfig(input: {
  paused: boolean;
  lane: { enabled: boolean; kind: "claude-code" | "api-script"; model: string; thinking: string | null; credential: string | null };
  resolution: Pick<ReviewConfigInput, "provider" | "usedThisPeriod" | "quota"> | null;
  now?: Date;
}): LaneConfigResult {
  if (input.paused) return { enabled: false, reason: "paused" };
  if (!input.lane.enabled) return { enabled: false, reason: "disabled" };
  const { lane, resolution } = input;
  const base = { kind: lane.kind, model: lane.model, thinking: lane.thinking, extraArgs: [] as string[] };
  if (!resolution?.provider) {
    return { enabled: true, ...base, providerKind: null, baseUrl: null, secretName: lane.credential };
  }
  const decided = resolveReviewConfig({
    paused: false,
    repo: { enabled: true, model: lane.model, thinkingLevel: lane.thinking, extraArgs: [] },
    provider: resolution.provider,
    usedThisPeriod: resolution.usedThisPeriod,
    quota: resolution.quota,
    now: input.now,
  });
  if (!decided.enabled) return decided;
  return { enabled: true, ...base, providerKind: decided.providerKind, baseUrl: decided.baseUrl, secretName: decided.secretName };
}
