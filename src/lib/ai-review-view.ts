import { QUOTA_WARN_RATIO } from "./ai-review-config";
import type { LaneKind, LaneMeter, ThinkingMode } from "./ai-review-lanes";

// 设置页（/settings/ai-review）的纯展示辅助：额度条、金额/时间格式化、
// 接入用的 workflow 片段。项目前端测试是 node 环境、不渲染组件，所以可测的
// 逻辑都集中在这里，组件只做拼装。

export type BudgetStatus = "ok" | "warn" | "exhausted";
export type DisplayUnit = "token" | "usd" | "count" | null;

/** 已用占上限的整数百分比（封顶 100）；没有上限时返回 null。 */
export function budgetPercent(limit: number | null, used: number): number | null {
  if (limit === null || limit <= 0) return null;
  return Math.min(100, Math.round((used / limit) * 100));
}

export function statusBarClass(status: BudgetStatus): string {
  switch (status) {
    case "warn":
      return "bg-amber-500";
    case "exhausted":
      return "bg-destructive";
    default:
      return "bg-emerald-500";
  }
}

export function formatAmount(unit: DisplayUnit, amount: number): string {
  switch (unit) {
    case "token":
      return `${Math.round(amount).toLocaleString("en-US")} tokens`;
    case "usd":
      return `$${amount.toFixed(2)}`;
    case "count":
      return `${Math.round(amount)} 次`;
    default:
      return "—";
  }
}

export interface UsageSummary {
  tokens: number;
  /** null = 不按钱计费（Claude 订阅按限流窗口计量），此时不显示金额。 */
  costUsd: number | null;
  count: number;
}

/** 本月原始用量一句话：没设预算的服务商（如 Claude OAuth 订阅）靠它看"烧了多少"。 */
export function formatUsageSummary(usage: UsageSummary): string {
  if (usage.count === 0) return "本月暂无用量";
  const parts = [`${usage.count} 次`, formatAmount("token", usage.tokens)];
  if (usage.costUsd !== null && usage.costUsd > 0) parts.push(formatAmount("usd", usage.costUsd));
  return parts.join(" · ");
}

/** 已用百分比 → 剩余百分比（订阅页面主打"剩多少"）；未知返回 null。 */
export function remainingPercent(usedPercent: number | null): number | null {
  if (usedPercent === null) return null;
  return Math.round(Math.max(0, 100 - usedPercent) * 10) / 10;
}

/**
 * 单个订阅窗口的状态色：与服务端 quotaStatus 同一条规则——达到 80% 黄、达到暂停阈值红；
 * 没设暂停阈值时只有 100%（被限流）才算红。
 */
export function windowStatus(usedPercent: number | null, stopPercent: number | null): BudgetStatus {
  if (usedPercent === null) return "ok";
  if (usedPercent >= (stopPercent ?? 100)) return "exhausted";
  if (usedPercent >= QUOTA_WARN_RATIO * 100) return "warn";
  return "ok";
}

/** 距离窗口重置还有多久；时间已过说明窗口已滚动，旧读数不再代表现状。 */
export function formatResetIn(value: Date | string | null, now: Date = new Date()): string {
  if (value === null) return "重置时间未知";
  const seconds = Math.floor((new Date(value).getTime() - now.getTime()) / 1000);
  if (seconds <= 0) return "已重置";
  if (seconds < 60) return "不到 1 分钟后重置";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ""}后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}后重置`;
}

export function formatRelativeTime(value: Date | string | null, now: Date = new Date()): string {
  if (value === null) return "从未";
  const seconds = Math.max(0, Math.floor((now.getTime() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 新增仓库后展示的、可粘贴进该仓库 review workflow 的接入片段。
 * 与 .github/workflows/claude-review.yml 的自接入写法保持一致；
 * token 本身不在片段里——它是仓库 secret `PRBOARD_TOKEN`，单独展示。
 */
export function buildWorkflowSnippet(prboardUrl: string): string {
  return `- id: ai-review-config
  uses: daidaidaiok/PRboard/.github/actions/ai-review-config@main
  with:
    prboard-url: ${prboardUrl}
    token: \${{ secrets.PRBOARD_TOKEN }}

- id: review
  if: steps.ai-review-config.outputs.enabled == 'true'
  uses: anthropics/claude-code-action@v1
  env:
    ANTHROPIC_BASE_URL: \${{ steps.ai-review-config.outputs.base-url || 'https://api.anthropic.com' }}
  with:
    claude_code_oauth_token: \${{ steps.ai-review-config.outputs.provider-kind == 'claude-oauth' && secrets[steps.ai-review-config.outputs.secret-name] || '' }}
    anthropic_api_key: \${{ steps.ai-review-config.outputs.provider-kind == 'anthropic-compatible' && secrets[steps.ai-review-config.outputs.secret-name] || '' }}
    claude_args: |
      --model \${{ steps.ai-review-config.outputs.model }}
      --effort \${{ steps.ai-review-config.outputs.effort }} \${{ steps.ai-review-config.outputs.extra-args }}
    # prompt: 保留该仓库原有的 review prompt

- if: always() && steps.ai-review-config.outputs.enabled == 'true'
  uses: daidaidaiok/PRboard/.github/actions/ai-review-usage@main
  with:
    prboard-url: ${prboardUrl}
    token: \${{ secrets.PRBOARD_TOKEN }}
    source: \${{ steps.ai-review-config.outputs.source }}
    execution-file: \${{ steps.review.outputs.execution_file }}
    model: \${{ steps.ai-review-config.outputs.model }}
    pr-number: \${{ github.event.pull_request.number }}
`;
}

/** GET /api/settings/ai-review 的响应形状（日期经 JSON 变成 ISO 字符串）。 */
export interface ProviderView {
  id: string;
  name: string;
  kind: "claude-oauth" | "anthropic-compatible";
  baseUrl: string | null;
  secretName: string;
  budgetLimit: number | null;
  budgetUnit: Exclude<DisplayUnit, null> | null;
  usedThisPeriod: number | null;
  status: BudgetStatus;
  usage: UsageSummary;
  /** Claude 订阅的限流窗口读数（剩余额度）；API key 类服务商为 null。 */
  quota: {
    windows: Array<{ type: string; usedPercent: number | null; resetsAt: string | null }>;
    stopPercent: number | null;
    status: BudgetStatus;
    observedAt: string | null;
  } | null;
}

export interface RepoView {
  id: string;
  repoFullName: string;
  enabled: boolean;
  providerId: string | null;
  model: string;
  thinkingLevel: string | null;
  tokenCreatedAt: string;
  lastConfigAt: string | null;
  lastUsageAt: string | null;
  /** 该项目 CI 里其余各路 review（Claude 主审在仓库级配置里）。 */
  lanes: LaneView[];
}

export interface OverviewView {
  paused: boolean;
  providers: ProviderView[];
  repos: RepoView[];
}

/** 管理 API 的统一调用：非 2xx 抛出带服务端 error 文案的 Error，调用方 toast。 */
export async function reviewApi<T = unknown>(url: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `请求失败（HTTP ${res.status}）`);
  return data as T;
}

/** 一路通道在面板里的形状（与 serializeLane 的响应对应）。 */
export interface LaneView {
  id: string;
  repoId: string;
  laneKey: string;
  label: string;
  kind: LaneKind;
  thinkingMode: ThinkingMode;
  /** 该路支持的思考选项；空数组 = 没有思考控制（Haiku 5.5、免费池），面板不显示这一项。 */
  thinkingOptions: string[];
  enabled: boolean;
  wired: boolean;
  model: string;
  thinking: string | null;
  credential: string | null;
  meter: LaneMeter;
  providerId: string | null;
  notes: string | null;
  sortOrder: number;
}

export function meterLabel(meter: LaneMeter): string {
  switch (meter) {
    case "subscription":
      return "订阅窗口";
    case "usd":
      return "按量（美元）";
    case "plan":
      return "套餐";
    default:
      return "免费";
  }
}

/**
 * 一路通道在面板里的状态。核心是"接入"：只有 CI 真的读取 PRboard 配置的通道才可改；
 * 未接入的只是记录，改了不会生效——必须明确标出，否则会出现"面板说 X、实际跑 Y"。
 */
export function laneStatus(lane: { wired: boolean; enabled: boolean }): { text: string; tone: "on" | "off" | "readonly"; editable: boolean } {
  if (!lane.wired) return { text: "未接入 · 只读（改了不生效）", tone: "readonly", editable: false };
  return lane.enabled ? { text: "已接入 · 运行中", tone: "on", editable: true } : { text: "已接入 · 已关闭", tone: "off", editable: true };
}

/** 「添加通道」时的预设：给出该路的类型、思考控制方式、常见凭据名和默认模型，用户再按实际情况改。 */
export interface LanePreset {
  id: string;
  label: string;
  laneKey: string;
  kind: LaneKind;
  thinkingMode: ThinkingMode;
  model: string;
  thinking: string | null;
  credential: string;
  meter: LaneMeter;
}

export const LANE_PRESETS: LanePreset[] = [
  { id: "claude", label: "Claude（额外一路，如桌面端）", laneKey: "claude-desktop", kind: "claude-code", thinkingMode: "effort", model: "claude-opus-5-5", thinking: "high", credential: "CLAUDE_CODE_OAUTH_TOKEN", meter: "subscription" },
  { id: "mention", label: "@mention", laneKey: "mention", kind: "claude-code", thinkingMode: "effort", model: "claude-opus-5-5", thinking: null, credential: "CLAUDE_CODE_OAUTH_TOKEN", meter: "subscription" },
  { id: "haiku", label: "Haiku", laneKey: "haiku", kind: "api-script", thinkingMode: "none", model: "claude-haiku-5-5", thinking: null, credential: "ANTHROPIC_API_KEY", meter: "usd" },
  { id: "glm", label: "GLM（智谱）", laneKey: "glm", kind: "api-script", thinkingMode: "toggle", model: "glm-5.3", thinking: "max", credential: "ZHIPU_API_KEY", meter: "plan" },
  { id: "free-pool", label: "免费模型池（自建网关）", laneKey: "free-pool", kind: "api-script", thinkingMode: "none", model: "nvidia/nemotron-3-super-120b-a12b,sensenova-6.8-flash-lite,cohere/north-mini-code:free", thinking: null, credential: "NEWAPI_API_KEY", meter: "free" },
];
