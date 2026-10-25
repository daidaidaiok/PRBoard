import { describe, expect, it } from "vitest";
import { LANE_KEY_PATTERN, thinkingOptionsFor, validateLaneFields, type LaneFields } from "./ai-review-lanes";

const claude: LaneFields = { kind: "claude-code", thinkingMode: "effort", model: "claude-opus-5-5", thinking: "high" };
const glm: LaneFields = { kind: "api-script", thinkingMode: "toggle", model: "glm-5.3", thinking: "max" };
const pool: LaneFields = { kind: "api-script", thinkingMode: "none", model: "nvidia/nemotron-3-ultra-550b-a55b,z-ai/glm-5.3", thinking: null };

describe("thinkingOptionsFor", () => {
  it("offers only the choices a lane actually supports", () => {
    expect(thinkingOptionsFor("effort")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(thinkingOptionsFor("toggle")).toEqual(["off", "on", "max"]);
    expect(thinkingOptionsFor("none")).toEqual([]);
  });
});

describe("LANE_KEY_PATTERN", () => {
  it.each(["claude-web", "haiku-desktop", "free-pool", "mention", "glm"])("accepts %s", (key) => expect(LANE_KEY_PATTERN.test(key)).toBe(true));
  it.each(["", "Claude", "a b", "-x", "x-", "a/b", "x".repeat(41), "a;b"])("rejects %j", (key) => expect(LANE_KEY_PATTERN.test(key)).toBe(false));
});

describe("validateLaneFields", () => {
  it("accepts a well-formed lane of each family", () => {
    expect(validateLaneFields(claude)).toEqual({ ok: true });
    expect(validateLaneFields(glm)).toEqual({ ok: true });
    expect(validateLaneFields(pool)).toEqual({ ok: true });
  });

  it("allows an empty thinking value (= the lane's own default) for every family", () => {
    expect(validateLaneFields({ ...claude, thinking: null }).ok).toBe(true);
    expect(validateLaneFields({ ...glm, thinking: null }).ok).toBe(true);
  });

  it.each([
    ["an effort level on a toggle lane", { ...glm, thinking: "high" }],
    ["a toggle value on a claude lane", { ...claude, thinking: "on" }],
    ["any thinking value on a lane that has no thinking control (Haiku / free pool)", { ...pool, thinking: "high" }],
    ["an unknown effort level", { ...claude, thinking: "extreme" }],
  ])("rejects %s", (_name, fields) => expect(validateLaneFields(fields as LaneFields).ok).toBe(false));

  it("keeps a claude-code lane's model a single clean token, since it becomes a --model argument", () => {
    expect(validateLaneFields({ ...claude, model: "a,b" }).ok).toBe(false);
    expect(validateLaneFields({ ...claude, model: "x --allowedTools Bash" }).ok).toBe(false);
    expect(validateLaneFields({ ...claude, model: "x\n--y" }).ok).toBe(false);
  });

  it("lets an api-script lane carry a comma-separated failover list, but nothing that could smuggle shell/args", () => {
    expect(validateLaneFields({ ...pool, model: "a/b-1,c/d:free,e" }).ok).toBe(true);
    expect(validateLaneFields({ ...pool, model: "a b" }).ok).toBe(false);
    expect(validateLaneFields({ ...pool, model: "a,,b" }).ok).toBe(false);
    expect(validateLaneFields({ ...pool, model: "a;b" }).ok).toBe(false);
    expect(validateLaneFields({ ...pool, model: "a\nb" }).ok).toBe(false);
    expect(validateLaneFields({ ...pool, model: Array.from({ length: 13 }, (_, i) => `m${i}`).join(",") }).ok).toBe(false);
  });

  it("accepts an empty model on either family: it means 'use the CLI / script's own default' (e.g. a @mention that never passed --model)", () => {
    expect(validateLaneFields({ ...claude, model: "" })).toEqual({ ok: true });
    expect(validateLaneFields({ ...pool, model: "" })).toEqual({ ok: true });
  });

  it("still refuses a blank-looking model that is really whitespace", () => {
    expect(validateLaneFields({ ...claude, model: " " }).ok).toBe(false);
    expect(validateLaneFields({ ...pool, model: "a, b" }).ok).toBe(false);
  });

  it("requires a claude-code lane to use the effort scale", () => {
    expect(validateLaneFields({ ...claude, thinkingMode: "toggle", thinking: "on" }).ok).toBe(false);
  });
});
