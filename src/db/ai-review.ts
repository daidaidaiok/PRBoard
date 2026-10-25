import { randomUUID } from "node:crypto";
import { and, asc, eq, gte, isNull, max, ne, or, sql } from "drizzle-orm";
import {
  budgetStatus,
  currentPeriodStart,
  quotaStatus,
  usedInUnit,
  type QuotaWindow,
  type ReviewConfigInput,
  type UsageTotals,
} from "@/lib/ai-review-config";
import { hashIngestToken, newIngestToken } from "@/lib/host-ingest-auth";
import { db } from "./index";
import { aiReviewProviders, aiReviewQuotaWindows, aiReviewRepos, aiReviewSettings, aiReviewUsage } from "./schema";

/** 新增仓库时的默认模型：与 其他项目现有 review workflow 保持一致。 */
export const DEFAULT_REVIEW_MODEL = "claude-opus-5-5";

export type ProviderRow = typeof aiReviewProviders.$inferSelect;

export interface ProviderInput {
  name: string;
  kind: ProviderRow["kind"];
  baseUrl: string | null;
  secretName: string;
  /** 单位见 budgetUnit；usd 以 micro-USD 存（换算由 API 层负责）。 */
  budgetLimit: number | null;
  budgetUnit: ProviderRow["budgetUnit"];
  /** 仅 claude-oauth：订阅窗口的暂停阈值（0..1），null = 只在 SDK 明确 rejected 时才停。 */
  quotaStopRatio: number | null;
}

export interface QuotaWindowView extends QuotaWindow {
  observedAt: Date;
}

export interface ProviderQuota {
  windows: QuotaWindowView[];
  stopRatio: number | null;
  /** 约束窗口决定的状态（忽略已过重置时间的窗口）。 */
  status: "ok" | "warn" | "exhausted";
  /** 最近一次读数的时间——只有 review 运行时才会更新。 */
  observedAt: Date | null;
}

export interface ProviderWithUsage {
  id: string;
  name: string;
  kind: ProviderRow["kind"];
  baseUrl: string | null;
  secretName: string;
  budgetLimit: number | null;
  budgetUnit: ProviderRow["budgetUnit"];
  usedThisPeriod: number;
  status: "ok" | "warn" | "exhausted";
  /** 本周期原始用量；没设预算的服务商也能据此展示"用了多少"。 */
  totals: UsageTotals;
  /** Claude 订阅的窗口额度；API key 类服务商为 null。 */
  quota: ProviderQuota | null;
}

export interface ReviewRepoRow {
  id: string;
  repoFullName: string;
  enabled: boolean;
  providerId: string | null;
  model: string;
  thinkingLevel: string | null;
  extraArgs: unknown;
  tokenCreatedAt: Date;
  lastConfigAt: Date | null;
  lastUsageAt: Date | null;
}

export interface ReviewUsageInput {
  providerId: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number | null;
  prNumber: number | null;
  runId: number;
  runAttempt: number;
}

const ZERO_TOTALS: UsageTotals = { inputTokens: 0, outputTokens: 0, costMicroUsd: 0, count: 0 };

/** 一个预算周期内按服务商聚合的用量表达式；float8 让 postgres-js 直接返回 number。 */
const totalsSelect = {
  inputTokens: sql<number>`coalesce(sum(${aiReviewUsage.inputTokens}), 0)::float8`,
  outputTokens: sql<number>`coalesce(sum(${aiReviewUsage.outputTokens}), 0)::float8`,
  costMicroUsd: sql<number>`coalesce(sum(${aiReviewUsage.costMicroUsd}), 0)::float8`,
  count: sql<number>`count(*)::float8`,
};

/**
 * 按 token 的 SHA-256 摘要直接命中唯一索引（明文从不入库、也不参与比较）。纯读。
 */
export async function authenticateReviewToken(
  token: string,
): Promise<{ repoId: string; userId: number; repoFullName: string; providerId: string | null } | null> {
  const [row] = await db
    .select({
      repoId: aiReviewRepos.id,
      userId: aiReviewRepos.userId,
      repoFullName: aiReviewRepos.repoFullName,
      providerId: aiReviewRepos.providerId,
    })
    .from(aiReviewRepos)
    .where(eq(aiReviewRepos.tokenHash, hashIngestToken(token)))
    .limit(1);
  return row ?? null;
}

/** config 路由在仓库绑定校验通过后调用，设置页据此显示"最近拉配置"（usage 回报与被拒请求不算）。 */
export async function touchReviewConfigPull(repoId: string): Promise<void> {
  await db.update(aiReviewRepos).set({ lastConfigAt: new Date() }).where(eq(aiReviewRepos.id, repoId));
}

export async function loadReviewConfigInput(repoId: string, userId: number, now = new Date()): Promise<ReviewConfigInput> {
  const [repo] = await db
    .select({
      enabled: aiReviewRepos.enabled,
      model: aiReviewRepos.model,
      thinkingLevel: aiReviewRepos.thinkingLevel,
      extraArgs: aiReviewRepos.extraArgs,
      providerId: aiReviewRepos.providerId,
    })
    .from(aiReviewRepos)
    .where(and(eq(aiReviewRepos.id, repoId), eq(aiReviewRepos.userId, userId)))
    .limit(1);
  if (!repo) throw new Error("ai-review repo not found");

  const [settings] = await db
    .select({ paused: aiReviewSettings.paused })
    .from(aiReviewSettings)
    .where(eq(aiReviewSettings.userId, userId))
    .limit(1);
  const paused = settings?.paused ?? false;
  const repoView = { enabled: repo.enabled, model: repo.model, thinkingLevel: repo.thinkingLevel, extraArgs: repo.extraArgs };

  const resolution = repo.providerId ? await loadProviderResolution(userId, repo.providerId, now) : null;
  if (!resolution) return { paused, repo: repoView, provider: null, usedThisPeriod: 0 };
  return { paused, repo: repoView, ...resolution, now };
}

/**
 * 装载一个服务商的当前状态（预算本期用量 + 订阅窗口读数），供 resolveReviewConfig 判定。
 * 仓库级配置和各路通道共用——通道可以关联服务商来复用它的订阅窗口暂停 / 美元预算。
 * 服务商不存在或不属于该用户返回 null。
 */
export async function loadProviderResolution(
  userId: number,
  providerId: string,
  now = new Date(),
): Promise<Pick<ReviewConfigInput, "provider" | "usedThisPeriod" | "quota"> | null> {
  const [provider] = await db
    .select({
      kind: aiReviewProviders.kind,
      baseUrl: aiReviewProviders.baseUrl,
      secretName: aiReviewProviders.secretName,
      budgetLimit: aiReviewProviders.budgetLimit,
      budgetUnit: aiReviewProviders.budgetUnit,
      quotaStopRatio: aiReviewProviders.quotaStopRatio,
    })
    .from(aiReviewProviders)
    .where(and(eq(aiReviewProviders.id, providerId), eq(aiReviewProviders.userId, userId)))
    .limit(1);
  if (!provider) return null;

  const [totals] = await db
    .select(totalsSelect)
    .from(aiReviewUsage)
    .where(and(eq(aiReviewUsage.providerId, providerId), gte(aiReviewUsage.createdAt, currentPeriodStart(now))));
  const { quotaStopRatio, ...providerView } = provider;
  const result: Pick<ReviewConfigInput, "provider" | "usedThisPeriod" | "quota"> = {
    provider: providerView,
    usedThisPeriod: usedInUnit(provider.budgetUnit, totals ?? ZERO_TOTALS),
  };
  if (provider.kind === "claude-oauth") {
    const rows = await db
      .select({
        windowType: aiReviewQuotaWindows.windowType,
        utilization: aiReviewQuotaWindows.utilization,
        resetsAt: aiReviewQuotaWindows.resetsAt,
        status: aiReviewQuotaWindows.status,
      })
      .from(aiReviewQuotaWindows)
      .where(eq(aiReviewQuotaWindows.providerId, providerId));
    result.quota = {
      windows: rows.map((row) => ({ type: row.windowType, utilization: row.utilization, resetsAt: row.resetsAt, status: row.status })),
      stopRatio: quotaStopRatio ?? null,
    };
  }
  return result;
}

/**
 * 用最新读数覆盖该服务商各限流窗口（每种窗口一行）。读数来自 CI 回报的 rate_limit_event，
 * 反映整个订阅账号的真实占用（含你自己交互使用的部分）。
 */
export async function upsertQuotaWindows(providerId: string, windows: QuotaWindow[]): Promise<void> {
  if (windows.length === 0) return;
  const observedAt = new Date();
  await db
    .insert(aiReviewQuotaWindows)
    .values(
      windows.map((w) => ({
        providerId,
        windowType: w.type,
        utilization: w.utilization,
        resetsAt: w.resetsAt,
        status: w.status,
        observedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [aiReviewQuotaWindows.providerId, aiReviewQuotaWindows.windowType],
      set: {
        utilization: sql`excluded.utilization`,
        resetsAt: sql`excluded.resets_at`,
        status: sql`excluded.status`,
        observedAt: sql`excluded.observed_at`,
      },
    });
}

/** (repoId, runId, runAttempt) 唯一：CI 重试同一次 run 重复回报只计一次。 */
export async function recordReviewUsage(repoId: string, usage: ReviewUsageInput): Promise<"recorded" | "duplicate"> {
  const inserted = await db
    .insert(aiReviewUsage)
    .values({ repoId, ...usage })
    .onConflictDoNothing({ target: [aiReviewUsage.repoId, aiReviewUsage.runId, aiReviewUsage.runAttempt] })
    .returning({ id: aiReviewUsage.id });
  return inserted.length > 0 ? "recorded" : "duplicate";
}

/** 新仓库默认 enabled=false，等用户在设置页选好服务商再开。已登记的仓库返回 null。 */
export async function createReviewRepo(userId: number, repoFullName: string): Promise<{ repoId: string; token: string } | null> {
  const token = newIngestToken();
  const repoId = randomUUID();
  const inserted = await db
    .insert(aiReviewRepos)
    .values({
      id: repoId,
      userId,
      repoFullName,
      enabled: false,
      model: DEFAULT_REVIEW_MODEL,
      extraArgs: [],
      tokenHash: hashIngestToken(token),
    })
    .onConflictDoNothing()
    .returning({ id: aiReviewRepos.id });
  return inserted.length > 0 ? { repoId, token } : null;
}

/** 轮换后旧 token 的摘要被覆盖，立即失效。 */
export async function rotateReviewToken(userId: number, repoId: string): Promise<string | null> {
  const token = newIngestToken();
  const updated = await db
    .update(aiReviewRepos)
    .set({ tokenHash: hashIngestToken(token), tokenCreatedAt: new Date(), lastConfigAt: null })
    .where(and(eq(aiReviewRepos.id, repoId), eq(aiReviewRepos.userId, userId)))
    .returning({ id: aiReviewRepos.id });
  return updated.length > 0 ? token : null;
}

export async function listReviewOverview(
  userId: number,
  now = new Date(),
): Promise<{ paused: boolean; providers: ProviderWithUsage[]; repos: ReviewRepoRow[] }> {
  const periodStart = currentPeriodStart(now);
  const [[settings], providers, repos, totals, lastUsage, windowRows] = await Promise.all([
    db.select({ paused: aiReviewSettings.paused }).from(aiReviewSettings).where(eq(aiReviewSettings.userId, userId)).limit(1),
    db.select().from(aiReviewProviders).where(eq(aiReviewProviders.userId, userId)).orderBy(asc(aiReviewProviders.name)),
    db
      .select({
        id: aiReviewRepos.id,
        repoFullName: aiReviewRepos.repoFullName,
        enabled: aiReviewRepos.enabled,
        providerId: aiReviewRepos.providerId,
        model: aiReviewRepos.model,
        thinkingLevel: aiReviewRepos.thinkingLevel,
        extraArgs: aiReviewRepos.extraArgs,
        tokenCreatedAt: aiReviewRepos.tokenCreatedAt,
        lastConfigAt: aiReviewRepos.lastConfigAt,
      })
      .from(aiReviewRepos)
      .where(eq(aiReviewRepos.userId, userId))
      .orderBy(asc(aiReviewRepos.repoFullName)),
    db
      .select({ providerId: aiReviewUsage.providerId, ...totalsSelect })
      .from(aiReviewUsage)
      .innerJoin(aiReviewProviders, eq(aiReviewUsage.providerId, aiReviewProviders.id))
      .where(and(eq(aiReviewProviders.userId, userId), gte(aiReviewUsage.createdAt, periodStart)))
      .groupBy(aiReviewUsage.providerId),
    db
      .select({ repoId: aiReviewUsage.repoId, lastUsageAt: max(aiReviewUsage.createdAt) })
      .from(aiReviewUsage)
      .innerJoin(aiReviewRepos, eq(aiReviewUsage.repoId, aiReviewRepos.id))
      .where(eq(aiReviewRepos.userId, userId))
      .groupBy(aiReviewUsage.repoId),
    db
      .select({
        providerId: aiReviewQuotaWindows.providerId,
        windowType: aiReviewQuotaWindows.windowType,
        utilization: aiReviewQuotaWindows.utilization,
        resetsAt: aiReviewQuotaWindows.resetsAt,
        status: aiReviewQuotaWindows.status,
        observedAt: aiReviewQuotaWindows.observedAt,
      })
      .from(aiReviewQuotaWindows)
      .innerJoin(aiReviewProviders, eq(aiReviewQuotaWindows.providerId, aiReviewProviders.id))
      .where(eq(aiReviewProviders.userId, userId)),
  ]);

  const totalsByProvider = new Map(totals.map((row) => [row.providerId, row]));
  const lastUsageByRepo = new Map(lastUsage.map((row) => [row.repoId, row.lastUsageAt]));
  return {
    paused: settings?.paused ?? false,
    providers: providers.map((provider) => {
      const providerTotals = totalsByProvider.get(provider.id);
      const totals: UsageTotals = providerTotals
        ? {
            inputTokens: providerTotals.inputTokens,
            outputTokens: providerTotals.outputTokens,
            costMicroUsd: providerTotals.costMicroUsd,
            count: providerTotals.count,
          }
        : ZERO_TOTALS;
      const used = usedInUnit(provider.budgetUnit, totals);
      return {
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
        baseUrl: provider.baseUrl,
        secretName: provider.secretName,
        budgetLimit: provider.budgetLimit,
        budgetUnit: provider.budgetUnit,
        usedThisPeriod: used,
        status: budgetStatus(provider.budgetLimit, used),
        totals,
        quota: provider.kind === "claude-oauth" ? buildQuota(provider.quotaStopRatio ?? null, windowRows.filter((w) => w.providerId === provider.id), now) : null,
      };
    }),
    repos: repos.map((repo) => ({ ...repo, lastUsageAt: lastUsageByRepo.get(repo.id) ?? null })),
  };
}

function buildQuota(
  stopRatio: number | null,
  rows: Array<{ windowType: string; utilization: number | null; resetsAt: Date | null; status: QuotaWindow["status"]; observedAt: Date }>,
  now: Date,
): ProviderQuota {
  const windows: QuotaWindowView[] = rows.map((row) => ({
    type: row.windowType,
    utilization: row.utilization,
    resetsAt: row.resetsAt,
    status: row.status,
    observedAt: row.observedAt,
  }));
  const observed = windows.map((w) => w.observedAt.getTime());
  return {
    windows,
    stopRatio,
    status: quotaStatus(windows, stopRatio, now).status,
    observedAt: observed.length > 0 ? new Date(Math.max(...observed)) : null,
  };
}

export interface ReviewRepoPatch {
  enabled?: boolean;
  providerId?: string | null;
  model?: string;
  thinkingLevel?: string | null;
  extraArgs?: string[];
}

/** 找不到仓库（含他人的仓库）或 providerId 不属于该用户时返回 false。 */
export async function updateReviewRepo(userId: number, repoId: string, patch: ReviewRepoPatch): Promise<boolean> {
  if (patch.providerId) {
    // 不校验归属的话，可以把别人的 providerId 挂到自己仓库上，借其 secretName/预算。
    const [owned] = await db
      .select({ id: aiReviewProviders.id })
      .from(aiReviewProviders)
      .where(and(eq(aiReviewProviders.id, patch.providerId), eq(aiReviewProviders.userId, userId)))
      .limit(1);
    if (!owned) return false;
  }

  const set: Partial<typeof aiReviewRepos.$inferInsert> = {};
  if (patch.enabled !== undefined) set.enabled = patch.enabled;
  if (patch.providerId !== undefined) set.providerId = patch.providerId;
  if (patch.model !== undefined) set.model = patch.model;
  if (patch.thinkingLevel !== undefined) set.thinkingLevel = patch.thinkingLevel;
  if (patch.extraArgs !== undefined) set.extraArgs = patch.extraArgs;

  const where = and(eq(aiReviewRepos.id, repoId), eq(aiReviewRepos.userId, userId));
  if (Object.keys(set).length === 0) {
    const [existing] = await db.select({ id: aiReviewRepos.id }).from(aiReviewRepos).where(where).limit(1);
    return existing !== undefined;
  }
  const updated = await db.update(aiReviewRepos).set(set).where(where).returning({ id: aiReviewRepos.id });
  return updated.length > 0;
}

export async function deleteReviewRepo(userId: number, repoId: string): Promise<boolean> {
  const deleted = await db
    .delete(aiReviewRepos)
    .where(and(eq(aiReviewRepos.id, repoId), eq(aiReviewRepos.userId, userId)))
    .returning({ id: aiReviewRepos.id });
  return deleted.length > 0;
}

/**
 * 新建（不传 id）或更新（传 id）服务商。同名冲突返回 "conflict"，更新时 id 不属于该用户返回 null。
 * 只有预算上限/单位真的变了才清空预警去重状态（让新额度从头判断）；
 * 仅改名或换 secret 不重置，否则同月会重复推"额度告急"。
 */
export async function upsertProvider(userId: number, input: ProviderInput, id?: string): Promise<ProviderRow | null | "conflict"> {
  if (id) {
    const [current] = await db
      .select({ budgetLimit: aiReviewProviders.budgetLimit, budgetUnit: aiReviewProviders.budgetUnit })
      .from(aiReviewProviders)
      .where(and(eq(aiReviewProviders.id, id), eq(aiReviewProviders.userId, userId)))
      .limit(1);
    if (!current) return null;
    const budgetChanged = current.budgetLimit !== input.budgetLimit || current.budgetUnit !== input.budgetUnit;
    try {
      const [updated] = await db
        .update(aiReviewProviders)
        .set(budgetChanged ? { ...input, budgetAlertPeriod: null, budgetAlertLevel: null } : input)
        .where(and(eq(aiReviewProviders.id, id), eq(aiReviewProviders.userId, userId)))
        .returning();
      return updated ?? null;
    } catch (error) {
      if (isUniqueViolation(error)) return "conflict";
      throw error;
    }
  }
  const [inserted] = await db
    .insert(aiReviewProviders)
    .values({ id: randomUUID(), userId, ...input })
    .onConflictDoNothing()
    .returning();
  return inserted ?? "conflict";
}

/** postgres-js 的 23505；drizzle 会再包一层，真正的 pg 错误在 .cause 上。 */
function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);
  return code(error) === "23505" || code((error as { cause?: unknown } | null)?.cause) === "23505";
}

/** 删除后引用它的仓库 providerId 置空（FK set null），config 随之返回 no_provider。 */
export async function deleteProvider(userId: number, id: string): Promise<boolean> {
  const deleted = await db
    .delete(aiReviewProviders)
    .where(and(eq(aiReviewProviders.id, id), eq(aiReviewProviders.userId, userId)))
    .returning({ id: aiReviewProviders.id });
  return deleted.length > 0;
}

export async function setGlobalPause(userId: number, paused: boolean): Promise<void> {
  await db
    .insert(aiReviewSettings)
    .values({ userId, paused, updatedAt: new Date() })
    .onConflictDoUpdate({ target: aiReviewSettings.userId, set: { paused, updatedAt: new Date() } });
}

/** 单个服务商本预算周期的用量（预警用）；服务商不存在/不属于该用户返回 null。 */
export async function loadProviderBudget(
  userId: number,
  providerId: string,
  now = new Date(),
): Promise<{
  name: string;
  kind: ProviderRow["kind"];
  budgetLimit: number | null;
  budgetUnit: ProviderRow["budgetUnit"];
  used: number;
  /** claude-oauth 才有：订阅窗口读数与暂停阈值；其余为 null。 */
  quota: { windows: QuotaWindow[]; stopRatio: number | null } | null;
} | null> {
  const [provider] = await db
    .select({
      name: aiReviewProviders.name,
      kind: aiReviewProviders.kind,
      budgetLimit: aiReviewProviders.budgetLimit,
      budgetUnit: aiReviewProviders.budgetUnit,
      quotaStopRatio: aiReviewProviders.quotaStopRatio,
    })
    .from(aiReviewProviders)
    .where(and(eq(aiReviewProviders.id, providerId), eq(aiReviewProviders.userId, userId)))
    .limit(1);
  if (!provider) return null;
  const [totals] = await db
    .select(totalsSelect)
    .from(aiReviewUsage)
    .where(and(eq(aiReviewUsage.providerId, providerId), gte(aiReviewUsage.createdAt, currentPeriodStart(now))));
  const { quotaStopRatio, ...rest } = provider;
  const used = usedInUnit(provider.budgetUnit, totals ?? ZERO_TOTALS);
  if (provider.kind !== "claude-oauth") return { ...rest, used, quota: null };
  const rows = await db
    .select({
      windowType: aiReviewQuotaWindows.windowType,
      utilization: aiReviewQuotaWindows.utilization,
      resetsAt: aiReviewQuotaWindows.resetsAt,
      status: aiReviewQuotaWindows.status,
    })
    .from(aiReviewQuotaWindows)
    .where(eq(aiReviewQuotaWindows.providerId, providerId));
  return {
    ...rest,
    used,
    quota: {
      windows: rows.map((row) => ({ type: row.windowType, utilization: row.utilization, resetsAt: row.resetsAt, status: row.status })),
      stopRatio: quotaStopRatio ?? null,
    },
  };
}

/**
 * 原子认领预警名额：同一服务商同一月同一档位只会有一个调用方拿到 true
 * （两个并发的 usage 回报同时越线也只推一次）。"exhausted"可以覆盖同月的
 * "warn"，反过来不行；换月后名额重置。
 */
export async function claimBudgetAlert(providerId: string, period: string, level: "warn" | "exhausted"): Promise<boolean> {
  const claimed = await db
    .update(aiReviewProviders)
    .set({ budgetAlertPeriod: period, budgetAlertLevel: level })
    .where(
      and(
        eq(aiReviewProviders.id, providerId),
        or(
          isNull(aiReviewProviders.budgetAlertPeriod),
          ne(aiReviewProviders.budgetAlertPeriod, period),
          isNull(aiReviewProviders.budgetAlertLevel),
          level === "exhausted" ? eq(aiReviewProviders.budgetAlertLevel, "warn") : sql`false`,
        ),
      ),
    )
    .returning({ id: aiReviewProviders.id });
  return claimed.length > 0;
}

/** 推送失败时释放认领：只清掉这一次的 (月份, 档位)，下次 usage 回报会重试。 */
export async function releaseBudgetAlert(providerId: string, period: string, level: "warn" | "exhausted"): Promise<void> {
  await db
    .update(aiReviewProviders)
    .set({ budgetAlertPeriod: null, budgetAlertLevel: null })
    .where(
      and(
        eq(aiReviewProviders.id, providerId),
        eq(aiReviewProviders.budgetAlertPeriod, period),
        eq(aiReviewProviders.budgetAlertLevel, level),
      ),
    );
}
