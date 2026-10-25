import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 与 ai-review.test.ts 同款：db.<op>() 依次弹出排队结果，链式调用被记录下来，
// 既能断言结果映射，也能断言查询结构（所有权限定、冲突处理），不需要真 Postgres。
const { calls, queue, db, loadProviderResolution } = vi.hoisted(() => {
  const calls: Array<{ op: string; steps: Array<[string, unknown[]]> }> = [];
  const queue: unknown[] = [];
  function chain(op: string) {
    const record = { op, steps: [] as Array<[string, unknown[]]> };
    calls.push(record);
    const result = queue.length ? queue.shift() : [];
    const proxy: unknown = new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          record.steps.push([String(prop), args]);
          return proxy;
        };
      },
    });
    return proxy;
  }
  return {
    calls,
    queue,
    loadProviderResolution: vi.fn(),
    db: {
      select: vi.fn(() => chain("select")),
      insert: vi.fn(() => chain("insert")),
      update: vi.fn(() => chain("update")),
      delete: vi.fn(() => chain("delete")),
    },
  };
});

vi.mock("./index", () => ({ db }));
vi.mock("./ai-review", () => ({ loadProviderResolution }));

import { createLane, deleteLane, getLane, listLanes, loadLaneConfig, updateLane, type LaneInput } from "./ai-review-lanes";

const dialect = new PgDialect();
const stepArgs = (i: number, m: string) => calls[i].steps.find(([n]) => n === m)?.[1] ?? [];
const renderWhere = (i: number) => dialect.sqlToQuery(stepArgs(i, "where")[0] as Parameters<typeof dialect.sqlToQuery>[0]);

const input: LaneInput = {
  laneKey: "haiku-web",
  label: "Haiku (web)",
  kind: "api-script",
  thinkingMode: "none",
  enabled: true,
  wired: false,
  model: "claude-haiku-5-5",
  thinking: null,
  credential: "ANTHROPIC_API_KEY",
  meter: "usd",
  providerId: null,
  notes: null,
  sortOrder: 20,
};

beforeEach(() => {
  calls.length = 0;
  queue.length = 0;
  loadProviderResolution.mockReset();
});

describe("listLanes", () => {
  it("returns the user's lanes joined to their repos, scoped to that user", async () => {
    queue.push([{ id: "l1", repoId: "r1", laneKey: "glm" }]);
    expect(await listLanes(7)).toEqual([{ id: "l1", repoId: "r1", laneKey: "glm" }]);
    expect(renderWhere(0).params).toContain(7);
  });
});

describe("createLane", () => {
  it("returns null when the repo is not the user's, without inserting", async () => {
    queue.push([]);
    expect(await createLane(8, "r1", input)).toBeNull();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses a provider that belongs to another user", async () => {
    queue.push([{ id: "r1" }], []);
    expect(await createLane(7, "r1", { ...input, providerId: "foreign" })).toBe("invalid_provider");
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("returns 'conflict' when the lane key already exists for that repo", async () => {
    queue.push([{ id: "r1" }], []);
    expect(await createLane(7, "r1", input)).toBe("conflict");
    expect(calls[1].steps.map(([n]) => n)).toContain("onConflictDoNothing");
  });

  it("inserts and returns the new row", async () => {
    queue.push([{ id: "r1" }], [{ id: "l1", laneKey: "haiku-web" }]);
    expect(await createLane(7, "r1", input)).toEqual({ id: "l1", laneKey: "haiku-web" });
    expect(stepArgs(1, "values")[0]).toMatchObject({ repoId: "r1", laneKey: "haiku-web", wired: false, model: "claude-haiku-5-5" });
  });
});

describe("getLane / updateLane / deleteLane are all scoped to the owning user", () => {
  it("getLane returns null for another user's lane", async () => {
    queue.push([]);
    expect(await getLane(8, "l1")).toBeNull();
    expect(renderWhere(0).params).toContain(8);
  });

  it("updateLane writes only the patched fields and returns the row", async () => {
    queue.push([{ id: "l1" }]);
    expect(await updateLane(7, "l1", { enabled: false, model: "glm-5.3" })).toEqual({ id: "l1" });
    const set = stepArgs(0, "set")[0] as Record<string, unknown>;
    expect(set).toMatchObject({ enabled: false, model: "glm-5.3" });
    expect(set).not.toHaveProperty("wired");
    expect(set).toHaveProperty("updatedAt");
    expect(renderWhere(0).params).toContain(7);
  });

  it("updateLane returns null when the lane is not the user's", async () => {
    queue.push([]);
    expect(await updateLane(8, "l1", { enabled: false })).toBeNull();
  });

  it("updateLane refuses to attach a provider owned by someone else", async () => {
    queue.push([]);
    expect(await updateLane(7, "l1", { providerId: "foreign" })).toBe("invalid_provider");
    expect(db.update).not.toHaveBeenCalled();
  });

  it("updateLane lets a provider be detached with null without an ownership lookup", async () => {
    queue.push([{ id: "l1" }]);
    await updateLane(7, "l1", { providerId: null });
    expect(db.select).not.toHaveBeenCalled();
  });

  it("deleteLane reports whether anything was deleted", async () => {
    queue.push([{ id: "l1" }], []);
    expect(await deleteLane(7, "l1")).toBe(true);
    expect(await deleteLane(8, "l1")).toBe(false);
  });
});

describe("loadLaneConfig", () => {
  const lane = { id: "l1", enabled: true, model: "claude-haiku-5-5", thinking: null, thinkingMode: "none", credential: "ANTHROPIC_API_KEY", providerId: null, kind: "api-script", wired: true };

  it("returns null for an unknown lane key", async () => {
    queue.push([]);
    expect(await loadLaneConfig("r1", 7, "nope")).toBeNull();
  });

  it("returns the lane, the global pause flag and no provider state for a lane without a provider", async () => {
    queue.push([lane], [{ paused: true }]);
    const result = await loadLaneConfig("r1", 7, "haiku-web");
    expect(result).toEqual({ lane, paused: true, resolution: null });
    expect(loadProviderResolution).not.toHaveBeenCalled();
  });

  it("pulls in the provider's budget / subscription state when the lane is linked to one", async () => {
    queue.push([{ ...lane, providerId: "p1" }], []);
    const resolution = { provider: { kind: "claude-oauth" }, usedThisPeriod: 3 };
    loadProviderResolution.mockResolvedValue(resolution);
    const result = await loadLaneConfig("r1", 7, "claude-desktop");
    expect(loadProviderResolution).toHaveBeenCalledWith(7, "p1", expect.any(Date));
    expect(result?.paused).toBe(false);
    expect(result?.resolution).toBe(resolution);
  });
});
