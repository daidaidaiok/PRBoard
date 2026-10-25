import { randomUUID } from "node:crypto";
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import type { ReviewConfigInput } from "@/lib/ai-review-config";
import type { LaneKind, LaneMeter, ThinkingMode } from "@/lib/ai-review-lanes";
import { loadProviderResolution } from "./ai-review";
import { db } from "./index";
import { aiReviewLanes, aiReviewProviders, aiReviewRepos, aiReviewSettings } from "./schema";

export type LaneRow = typeof aiReviewLanes.$inferSelect;

export interface LaneInput {
  laneKey: string;
  label: string;
  kind: LaneKind;
  thinkingMode: ThinkingMode;
  enabled: boolean;
  /** CI 是否真的读取 PRboard 的配置；false = 只读记录，页面标"未接入"。 */
  wired: boolean;
  model: string;
  thinking: string | null;
  credential: string | null;
  meter: LaneMeter;
  providerId: string | null;
  notes: string | null;
  sortOrder: number;
}

export type LanePatch = Partial<Pick<LaneInput, "label" | "enabled" | "wired" | "model" | "thinking" | "credential" | "providerId" | "notes" | "sortOrder">>;

/** 通道所属仓库必须是该用户的——所有读写都靠这个子查询限定归属。 */
const ownedByUser = (userId: number) => sql`${aiReviewLanes.repoId} in (select id from ${aiReviewRepos} where user_id = ${userId})`;

async function providerIsOwned(userId: number, providerId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: aiReviewProviders.id })
    .from(aiReviewProviders)
    .where(and(eq(aiReviewProviders.id, providerId), eq(aiReviewProviders.userId, userId)))
    .limit(1);
  return row !== undefined;
}

export async function listLanes(userId: number): Promise<LaneRow[]> {
  return db
    .select(getTableColumns(aiReviewLanes))
    .from(aiReviewLanes)
    .innerJoin(aiReviewRepos, eq(aiReviewLanes.repoId, aiReviewRepos.id))
    .where(eq(aiReviewRepos.userId, userId))
    .orderBy(asc(aiReviewLanes.repoId), asc(aiReviewLanes.sortOrder), asc(aiReviewLanes.label));
}

export async function getLane(userId: number, laneId: string): Promise<LaneRow | null> {
  const [row] = await db
    .select(getTableColumns(aiReviewLanes))
    .from(aiReviewLanes)
    .innerJoin(aiReviewRepos, eq(aiReviewLanes.repoId, aiReviewRepos.id))
    .where(and(eq(aiReviewLanes.id, laneId), eq(aiReviewRepos.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** 仓库不属于该用户返回 null；provider 不属于该用户返回 "invalid_provider"；同仓库同 key 已存在返回 "conflict"。 */
export async function createLane(
  userId: number,
  repoId: string,
  input: LaneInput,
): Promise<LaneRow | null | "invalid_provider" | "conflict"> {
  const [repo] = await db
    .select({ id: aiReviewRepos.id })
    .from(aiReviewRepos)
    .where(and(eq(aiReviewRepos.id, repoId), eq(aiReviewRepos.userId, userId)))
    .limit(1);
  if (!repo) return null;
  if (input.providerId && !(await providerIsOwned(userId, input.providerId))) return "invalid_provider";

  const [created] = await db
    .insert(aiReviewLanes)
    .values({ id: randomUUID(), repoId, ...input })
    .onConflictDoNothing()
    .returning();
  return created ?? "conflict";
}

export async function updateLane(userId: number, laneId: string, patch: LanePatch): Promise<LaneRow | null | "invalid_provider"> {
  // 不校验归属的话，可以把别人的服务商挂到自己的通道上，借其 secret 名 / 额度。
  if (patch.providerId && !(await providerIsOwned(userId, patch.providerId))) return "invalid_provider";
  const [updated] = await db
    .update(aiReviewLanes)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(aiReviewLanes.id, laneId), ownedByUser(userId)))
    .returning();
  return updated ?? null;
}

export async function deleteLane(userId: number, laneId: string): Promise<boolean> {
  const deleted = await db
    .delete(aiReviewLanes)
    .where(and(eq(aiReviewLanes.id, laneId), ownedByUser(userId)))
    .returning({ id: aiReviewLanes.id });
  return deleted.length > 0;
}

/**
 * 供 config 接口按 lane 取配置：返回该路、全局暂停状态，以及（若关联了服务商）
 * 该服务商的预算 / 订阅窗口状态。通道不存在返回 null。
 */
export async function loadLaneConfig(
  repoId: string,
  userId: number,
  laneKey: string,
  now = new Date(),
): Promise<{ lane: LaneRow; paused: boolean; resolution: Pick<ReviewConfigInput, "provider" | "usedThisPeriod" | "quota"> | null } | null> {
  const [lane] = await db
    .select()
    .from(aiReviewLanes)
    .where(and(eq(aiReviewLanes.repoId, repoId), eq(aiReviewLanes.laneKey, laneKey), ownedByUser(userId)))
    .limit(1);
  if (!lane) return null;

  const [settings] = await db
    .select({ paused: aiReviewSettings.paused })
    .from(aiReviewSettings)
    .where(eq(aiReviewSettings.userId, userId))
    .limit(1);
  const resolution = lane.providerId ? await loadProviderResolution(userId, lane.providerId, now) : null;
  return { lane, paused: settings?.paused ?? false, resolution };
}
