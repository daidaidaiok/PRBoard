#!/usr/bin/env bash
# ai-review-usage 的核心逻辑：把 claude-code-action 的 execution_file（单个 JSON
# 数组，取最后一条 type==result）里的用量回报给 PRboard。
#
# 口径：inputTokens = input + cache_creation + cache_read（本次处理的全部输入 token），
# outputTokens = output；costMicroUsd 取 total_cost_usd（美元→micro-USD）。
# 全程不阻断 job：任何失败只 ::warning::，退出码恒为 0。
set -uo pipefail

if [ -z "${PRBOARD_URL:-}" ] || [ -z "${TOKEN:-}" ]; then
  echo "::notice::未配置 PRboard，跳过用量回报"
  exit 0
fi
if [ "${SOURCE:-}" = "fallback" ]; then
  echo "::notice::本次使用的是回退配置，跳过用量回报"
  exit 0
fi

USAGE='[.[]? | select(.type == "result")] | .[-1] // {} | {
  inputTokens: ((.usage.input_tokens // 0) + (.usage.cache_creation_input_tokens // 0) + (.usage.cache_read_input_tokens // 0)),
  outputTokens: (.usage.output_tokens // 0),
  costMicroUsd: (if .total_cost_usd == null then null else ((.total_cost_usd * 1000000) | round) end)
}'
if [ -n "${EXEC_FILE:-}" ] && [ -f "$EXEC_FILE" ] && TOTALS=$(jq -c "$USAGE" "$EXEC_FILE" 2>/dev/null); then
  # result 消息存在但没有 usage：说明 execution_file 的字段结构变了，用量会被静默记 0，
  # 单独告警，别和"没有 execution_file"混为一谈。
  if jq -e '[.[]? | select(.type == "result")] | length > 0 and (.[-1].usage == null)' "$EXEC_FILE" >/dev/null 2>&1; then
    echo "::warning::execution_file 的 result 消息里没有 usage 字段（结构可能已变化），本次用量记 0"
  fi
else
  echo "::warning::取不到 execution_file 里的用量，仍回报本次运行（用量记 0）"
  TOTALS='{"inputTokens":0,"outputTokens":0,"costMicroUsd":null}'
fi

# Claude 订阅（OAuth）的限流窗口：execution_file 里的 rate_limit_event（claude-code-action 对订阅账号
# 才会有）。每种窗口取最后一次读数；unifiedWindows 里是 five_hour / seven_day 的完整读数，
# 顶层 rateLimitType 对应的窗口才带 SDK 的 status。utilization 是 0..1 的已用比例（兼容百分制的
# 取值：>1 视为百分数并封顶 1）；resetsAt 是秒级时间戳（毫秒级也兼容），转成 ISO 供服务端解析。
# 没有任何事件（比如 API key 服务商）时不带 rateLimits 字段。
# shellcheck disable=SC2016  # $i / $w 是 jq 变量，不是 shell 变量，必须保持单引号
RATE_LIMITS='
  def ratio: if . == null then null elif . > 1 then ([. / 100, 1] | min) else . end;
  def iso: if . == null then null else (if . > 100000000000 then . / 1000 else . end | floor | todate) end;
  [ .[]? | select(.type == "rate_limit_event") | .rate_limit_info // empty
    | . as $i
    | ( [ (if $i.rateLimitType != null then {type: $i.rateLimitType, utilization: ($i.utilization | ratio), resetsAt: ($i.resetsAt | iso), status: ($i.status // null)} else empty end),
          ( ($i.unifiedWindows // {}) | to_entries[]
            | {type: .key, utilization: (.value.utilization | ratio), resetsAt: (.value.resetsAt | iso),
               status: (if .key == $i.rateLimitType then ($i.status // null) else null end)} ) ] ) | .[] ]
  | map(select((.type | type) == "string" and (.type | test("^[a-z_]{1,40}$")) and .type != "overage"))
  | reduce .[] as $w ({}; .[$w.type] = $w)
  | [ .[] ] | .[0:8]'
RATE_JSON='[]'
if [ -n "${EXEC_FILE:-}" ] && [ -f "$EXEC_FILE" ]; then
  RATE_JSON=$(jq -c "$RATE_LIMITS" "$EXEC_FILE" 2>/dev/null) || RATE_JSON='[]'
fi

PAYLOAD=$(jq -nc \
  --arg repo "${REPO:-}" \
  --arg model "${MODEL:-unknown}" \
  --arg pr "${PR_NUMBER:-}" \
  --argjson runId "${RUN_ID:-0}" \
  --argjson runAttempt "${RUN_ATTEMPT:-1}" \
  --argjson totals "$TOTALS" \
  --argjson rate "$RATE_JSON" \
  '{repo: $repo, model: $model, prNumber: (if $pr == "" then null else ($pr | tonumber) end), runId: $runId, runAttempt: $runAttempt} + $totals
   + (if ($rate | length) > 0 then {rateLimits: $rate} else {} end)') \
  || { echo "::warning::用量载荷构造失败，跳过回报"; exit 0; }

curl -fsS --connect-timeout 5 --max-time 10 -X POST \
  -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
  -d "$PAYLOAD" "${PRBOARD_URL%/}/api/ai-review/usage" >/dev/null 2>&1 \
  || echo "::warning::用量回报失败（不阻断）"
exit 0
