import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 每个用例都要拉起 bash + jq 子进程；本机同时跑着自托管 runner，负载均值可达 20 以上，
// 默认的 5 秒超时会偶发撞线（全量并行时曾有 4 个用例误报，单跑与重跑均通过），放宽到 30 秒。
vi.setConfig({ testTimeout: 30_000 });

// 两个 composite action 的核心逻辑在 run.sh 里（action.yml 只负责传 env），
// 这样可以在本地用桩 curl 直接跑：既验证"PRboard 不可达 → 回退默认配置"
// 这条关键降级路径，也验证 token 不泄露、远端值不能注入 GITHUB_OUTPUT。
const CONFIG_SH = resolve(process.cwd(), ".github/actions/ai-review-config/run.sh");
const USAGE_SH = resolve(process.cwd(), ".github/actions/ai-review-usage/run.sh");
const TOKEN = "S".repeat(43);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ai-review-actions-"));
  // 桩 curl：记录参数；按 STUB_* 环境变量决定返回的状态码/响应体/退出码。
  writeFileSync(
    join(dir, "curl"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_LOG"
for arg in "$@"; do
  case "$prev" in
    -o) out="$arg" ;;
    -d) printf '%s' "$arg" > "$STUB_PAYLOAD" ;;
  esac
  prev="$arg"
done
if [ -n "\${out:-}" ]; then printf '%s' "\${STUB_BODY:-}" > "$out"; fi
printf '%s' "\${STUB_CODE:-200}"
exit "\${STUB_EXIT:-0}"
`,
  );
  chmodSync(join(dir, "curl"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, env: Record<string, string>) {
  const output = join(dir, "github_output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [script], {
    env: {
      NODE_ENV: "test", // next 的类型扩充要求 ProcessEnv 带 NODE_ENV
      PATH: `${dir}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      STUB_LOG: join(dir, "curl.log"),
      STUB_PAYLOAD: join(dir, "payload.json"),
      ...env,
    },
    encoding: "utf8",
  });
  const outputs = Object.fromEntries(
    readFileSync(output, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const log = existsSync(join(dir, "curl.log")) ? readFileSync(join(dir, "curl.log"), "utf8") : "";
  const payload = existsSync(join(dir, "payload.json")) ? JSON.parse(readFileSync(join(dir, "payload.json"), "utf8")) : null;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, outputs, log, payload };
}

const configEnv = {
  PRBOARD_URL: "https://prboard.example.com",
  TOKEN,
  REPO: "daidaidaiok/PRboard",
  FALLBACK_MODEL: "claude-opus-5-5",
  FALLBACK_EFFORT: "high",
  FALLBACK_KIND: "claude-oauth",
  FALLBACK_SECRET: "CLAUDE_CODE_OAUTH_TOKEN",
};

const remoteEnabled = {
  enabled: true,
  providerKind: "anthropic-compatible",
  baseUrl: "https://open.bigmodel.cn/api/anthropic",
  secretName: "GLM_API_KEY",
  model: "glm-4.6",
  thinking: "medium",
  extraArgs: ["--max-turns", "40"],
};

describe("ai-review-config run.sh", () => {
  const expectFallback = (r: ReturnType<typeof run>) => {
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({
      enabled: "true",
      source: "fallback",
      "provider-kind": "claude-oauth",
      "secret-name": "CLAUDE_CODE_OAUTH_TOKEN",
      model: "claude-opus-5-5",
      effort: "high",
      "base-url": "",
    });
    expect(r.stdout).toContain("::warning::");
  };

  it("falls back to the built-in defaults when no token is configured, without calling PRboard", () => {
    const r = run(CONFIG_SH, { ...configEnv, TOKEN: "" });
    expectFallback(r);
    expect(r.log).toBe("");
  });

  it("uses the remote config when PRboard answers enabled, sending the token and repo", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify(remoteEnabled) });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({
      enabled: "true",
      source: "remote",
      "provider-kind": "anthropic-compatible",
      "base-url": "https://open.bigmodel.cn/api/anthropic",
      "secret-name": "GLM_API_KEY",
      model: "glm-4.6",
      effort: "medium",
      "extra-args": "--max-turns 40",
    });
    expect(r.log).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(r.log).toContain("repo=daidaidaiok/PRboard");
    expect(r.log).toContain("https://prboard.example.com/api/ai-review/config");
  });

  it("accepts the common case of an empty extraArgs list (every repo starts with [])", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify({ ...remoteEnabled, extraArgs: [] }) });
    expect(r.outputs).toMatchObject({ enabled: "true", source: "remote", model: "glm-4.6", "extra-args": "" });
    expect(r.stdout).not.toContain("::warning::");
  });

  it("never prints the token to stdout or stderr", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify(remoteEnabled) });
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("skips (enabled=false) with the reason when PRboard says disabled — no fallback", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify({ enabled: false, reason: "budget_exhausted" }) });
    expect(r.status).toBe(0);
    expect(r.outputs).toMatchObject({ enabled: "false", reason: "budget_exhausted", source: "remote" });
  });

  it("uses the fallback effort when the repo's thinking level is the default (null)", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify({ ...remoteEnabled, thinking: null }) });
    expect(r.outputs.effort).toBe("high");
  });

  it.each([
    ["HTTP 502", { STUB_CODE: "502", STUB_BODY: '{"error":"x"}' }],
    ["HTTP 401 (revoked token)", { STUB_CODE: "401", STUB_BODY: '{"error":"unauthorized"}' }],
    ["network failure / timeout (curl exits non-zero)", { STUB_EXIT: "28", STUB_CODE: "000" }],
    ["200 with a non-JSON body", { STUB_BODY: "<html>gateway</html>" }],
    ["200 with an unrecognised shape", { STUB_BODY: '{"hello":"world"}' }],
  ])("falls back to the defaults on %s", (_name, stub) => {
    expectFallback(run(CONFIG_SH, { ...configEnv, ...stub }));
  });

  it.each([
    ["a model with spaces (would smuggle extra CLI args)", { model: "x --allowedTools Bash" }],
    ["an unknown thinking level", { thinking: "extreme" }],
    ["an extra arg with a space", { extraArgs: ["--max-turns 40"] }],
    ["a flag that is not on the whitelist (even with safe characters)", { extraArgs: ["--dangerously-skip-permissions"] }],
    ["a flag=value form that bypasses the pair whitelist", { extraArgs: ["--allowedTools=Bash"] }],
    ["a non-numeric --max-turns value", { extraArgs: ["--max-turns", "abc"] }],
    ["an odd-length extraArgs list", { extraArgs: ["--max-turns"] }],
    ["a reserved GITHUB_ secret name", { secretName: "GITHUB_TOKEN" }],
    ["a secret name that is not credential-shaped (e.g. DEPLOY_KEY)", { secretName: "DEPLOY_KEY" }],
    ["a plain-http base url", { baseUrl: "http://evil.example" }],
  ])("falls back when the remote config carries %s", (_name, override) => {
    expectFallback(run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify({ ...remoteEnabled, ...override }) }));
  });

  it("refuses a remote value containing a newline instead of letting it inject extra outputs", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify({ ...remoteEnabled, model: "x\nenabled=false" }) });
    expectFallback(r);
    expect(r.outputs.model).toBe("claude-opus-5-5");
  });
});

describe("ai-review-config run.sh — lane mode", () => {
  // 通道模式：workflow 里每一路（Haiku / GLM / 免费池 / mention）按自己的 lane 取配置。
  // 回退值用独立的 lane-fallback-* 输入，绝不沿用仓库级的 fallback-model（默认 claude-opus-5-5）：
  // 免费池脚本在没有配置时必须收到「空」模型才会走自己的默认池，收到 Claude 模型名会整路跑废。
  const laneEnv = { ...configEnv, LANE: "glm", LANE_FALLBACK_MODEL: "glm-5.3", LANE_FALLBACK_THINKING: "max" };
  const laneRemote = { enabled: true, kind: "api-script", providerKind: null, baseUrl: null, secretName: "ZHIPU_API_KEY", model: "glm-5.3", thinking: "off", extraArgs: [] };

  it("asks for the lane and maps the answer to outputs, without a provider kind", () => {
    const r = run(CONFIG_SH, { ...laneEnv, STUB_BODY: JSON.stringify(laneRemote) });
    expect(r.log).toContain("lane=glm");
    expect(r.outputs).toMatchObject({ enabled: "true", source: "remote", kind: "api-script", model: "glm-5.3", thinking: "off", "provider-kind": "" });
  });

  it("reports a switched-off lane as enabled=false so that one lane is skipped and the others keep running", () => {
    const r = run(CONFIG_SH, { ...laneEnv, STUB_BODY: JSON.stringify({ enabled: false, reason: "disabled" }) });
    expect(r.outputs).toMatchObject({ enabled: "false", reason: "disabled", source: "remote" });
  });

  it.each([
    ["HTTP 404 (PRboard does not know the lane)", { STUB_CODE: "404", STUB_BODY: '{"error":"lane not found"}' }],
    ["HTTP 502", { STUB_CODE: "502", STUB_BODY: "{}" }],
    ["a network failure", { STUB_EXIT: "28", STUB_CODE: "000" }],
  ])("falls back to the LANE's own defaults on %s — never to the repo-level Claude defaults", (_name, stub) => {
    const r = run(CONFIG_SH, { ...laneEnv, ...stub });
    expect(r.outputs).toMatchObject({ enabled: "true", source: "fallback", model: "glm-5.3", thinking: "max", "provider-kind": "" });
    expect(r.outputs.model).not.toBe("claude-opus-5-5");
  });

  it("an empty lane fallback model stays empty, so a script-driven lane can use its own built-in default pool", () => {
    const r = run(CONFIG_SH, { ...laneEnv, LANE: "free-pool", LANE_FALLBACK_MODEL: "", LANE_FALLBACK_THINKING: "", STUB_CODE: "404", STUB_BODY: "{}" });
    expect(r.outputs).toMatchObject({ enabled: "true", source: "fallback", model: "", thinking: "" });
  });

  it("accepts an empty model from PRboard (= use the script's / CLI's own default) and passes it through empty", () => {
    const r = run(CONFIG_SH, { ...laneEnv, LANE: "mention", STUB_BODY: JSON.stringify({ ...laneRemote, kind: "claude-code", model: "", thinking: null }) });
    expect(r.outputs).toMatchObject({ source: "remote", enabled: "true", model: "", kind: "claude-code" });
  });

  it("accepts a comma-separated failover list for a script lane", () => {
    const pool = "nvidia/nemotron-3-super-120b-a12b,sensenova-6.8-flash-lite,cohere/north-mini-code:free";
    const r = run(CONFIG_SH, { ...laneEnv, LANE: "free-pool", STUB_BODY: JSON.stringify({ ...laneRemote, model: pool, thinking: null }) });
    expect(r.outputs).toMatchObject({ source: "remote", model: pool, thinking: "" });
  });

  it.each([
    ["a comma list on a claude-code lane (it becomes a --model argument)", { kind: "claude-code", model: "a,b" }],
    ["a model with a space", { model: "glm 5.3" }],
    ["a model with a newline", { model: "glm\nenabled=false" }],
    ["an upper-case / spaced thinking value", { thinking: "Max Effort" }],
    ["a non-empty extraArgs list (lanes carry none)", { extraArgs: ["--max-turns", "5"] }],
    ["a secret name outside the allow-list", { secretName: "DEPLOY_KEY" }],
    ["an unknown lane kind", { kind: "other" }],
  ])("falls back when the lane answer carries %s", (_name, override) => {
    const r = run(CONFIG_SH, { ...laneEnv, STUB_BODY: JSON.stringify({ ...laneRemote, ...override }) });
    expect(r.outputs).toMatchObject({ source: "fallback", model: "glm-5.3", thinking: "max" });
  });

  it("leaves repo-level behaviour untouched when no lane is given", () => {
    const r = run(CONFIG_SH, { ...configEnv, STUB_BODY: JSON.stringify(remoteEnabled) });
    expect(r.log).not.toContain("lane=");
    expect(r.outputs).toMatchObject({ source: "remote", model: "glm-4.6", effort: "medium" });
  });
});

describe("ai-review-usage run.sh", () => {
  const usageEnv = {
    PRBOARD_URL: "https://prboard.example.com",
    TOKEN,
    REPO: "daidaidaiok/PRboard",
    SOURCE: "remote",
    MODEL: "claude-opus-5-5",
    PR_NUMBER: "42",
    RUN_ID: "123456789",
    RUN_ATTEMPT: "2",
  };

  function execFile(messages: unknown[]) {
    const path = join(dir, "execution.json");
    writeFileSync(path, JSON.stringify(messages));
    return path;
  }

  it("reports the last result message's usage: all input tokens summed, cost in micro-USD", () => {
    const EXEC_FILE = execFile([
      { type: "assistant" },
      { type: "result", usage: { input_tokens: 100, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 7 }, total_cost_usd: 0.054321 },
    ]);
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE });
    expect(r.status).toBe(0);
    expect(r.payload).toEqual({
      repo: "daidaidaiok/PRboard",
      model: "claude-opus-5-5",
      inputTokens: 150,
      outputTokens: 7,
      costMicroUsd: 54321,
      prNumber: 42,
      runId: 123456789,
      runAttempt: 2,
    });
    expect(r.log).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(r.log).toContain("https://prboard.example.com/api/ai-review/usage");
  });

  describe("subscription windows from rate_limit_event", () => {
    const result = { type: "result", usage: { input_tokens: 1, output_tokens: 1 } };
    // 形状取自 Claude CLI 的真实 rate_limit_event：resetsAt 为秒级时间戳，utilization 为 0..1 小数。
    const event = (info: Record<string, unknown>) => ({ type: "rate_limit_event", rate_limit_info: info });

    function report(messages: unknown[]) {
      const EXEC_FILE = execFile(messages);
      return run(USAGE_SH, { ...usageEnv, EXEC_FILE });
    }

    it("reports every unified window with ISO reset times; only the binding window carries the SDK status", () => {
      const r = report([
        event({
          status: "allowed_warning",
          rateLimitType: "five_hour",
          resetsAt: 1789678800,
          unifiedWindows: { five_hour: { utilization: 0.82, resetsAt: 1789678800 }, seven_day: { utilization: 0.21, resetsAt: 1790172000 } },
        }),
        result,
      ]);
      expect(r.payload.rateLimits).toEqual([
        { type: "five_hour", utilization: 0.82, resetsAt: "2026-09-17T21:00:00Z", status: "allowed_warning" },
        { type: "seven_day", utilization: 0.21, resetsAt: "2026-09-23T14:00:00Z", status: null },
      ]);
    });

    it("lets a later event override an earlier reading of the same window", () => {
      const r = report([
        event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.3, resetsAt: 1789678800 }),
        event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.5, resetsAt: 1789678800 }),
        result,
      ]);
      expect(r.payload.rateLimits).toEqual([{ type: "five_hour", utilization: 0.5, resetsAt: "2026-09-17T21:00:00Z", status: "allowed" }]);
    });

    it("keeps a status-only reading (no utilization, no reset time)", () => {
      const r = report([event({ status: "rejected", rateLimitType: "seven_day_opus" }), result]);
      expect(r.payload.rateLimits).toEqual([{ type: "seven_day_opus", utilization: null, resetsAt: null, status: "rejected" }]);
    });

    it("normalises a percent-scale utilization (62) to a fraction (0.62), and clamps at 1", () => {
      const r = report([event({ status: "allowed", rateLimitType: "five_hour", utilization: 62 }), event({ status: "allowed", rateLimitType: "seven_day", utilization: 250 }), result]);
      expect(r.payload.rateLimits.map((w: { utilization: number }) => w.utilization)).toEqual([0.62, 1]);
    });

    it("omits the key entirely when the run produced no rate_limit_event (e.g. API-key providers)", () => {
      const r = report([result]);
      expect(r.payload).not.toHaveProperty("rateLimits");
    });

    it("skips overage and window names that are not plain identifiers", () => {
      const r = report([
        event({ status: "allowed", rateLimitType: "overage", utilization: 0.1 }),
        event({ status: "allowed", rateLimitType: "five hour;x", utilization: 0.1 }),
        event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 1789678800 }),
        result,
      ]);
      expect(r.payload.rateLimits.map((w: { type: string }) => w.type)).toEqual(["five_hour"]);
    });

    it("converts a millisecond reset time as well", () => {
      const r = report([event({ status: "allowed", rateLimitType: "five_hour", utilization: 0.1, resetsAt: 1789678800000 }), result]);
      expect(r.payload.rateLimits[0].resetsAt).toBe("2026-09-17T21:00:00Z");
    });
  });

  it("sends null for cost and PR number when unknown", () => {
    const EXEC_FILE = execFile([{ type: "result", usage: { input_tokens: 1, output_tokens: 1 } }]);
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE, PR_NUMBER: "" });
    expect(r.payload).toMatchObject({ costMicroUsd: null, prNumber: null, inputTokens: 1, outputTokens: 1 });
  });

  it("still reports the run (zero tokens) with a warning when the execution file is missing", () => {
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE: join(dir, "nope.json") });
    expect(r.status).toBe(0);
    expect(r.payload).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicroUsd: null });
    expect(r.stdout).toContain("::warning::");
  });

  it("warns specifically when a result message exists but carries no usage (schema drift)", () => {
    const EXEC_FILE = execFile([{ type: "result", subtype: "success" }]);
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE });
    expect(r.stdout).toMatch(/::warning::.*usage/);
    expect(r.payload).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });

  it.each([
    ["no token", { TOKEN: "" }],
    ["no PRboard URL", { PRBOARD_URL: "" }],
    ["config came from the fallback", { SOURCE: "fallback" }],
  ])("does not call PRboard when %s", (_name, override) => {
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE: execFile([]), ...override });
    expect(r.status).toBe(0);
    expect(r.log).toBe("");
  });

  it("never fails the job when PRboard is unreachable", () => {
    const r = run(USAGE_SH, { ...usageEnv, EXEC_FILE: execFile([{ type: "result" }]), STUB_EXIT: "7", STUB_CODE: "000" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("::warning::");
  });
});
