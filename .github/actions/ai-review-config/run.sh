#!/usr/bin/env bash
# ai-review-config 的核心逻辑（action.yml 只负责把 inputs 传成 env）。
#
# 向 PRboard 拉取本仓库的 AI review 配置，写入 $GITHUB_OUTPUT：
#   enabled=true|false   false 表示 PRboard 明确要求跳过（暂停/关闭/额度用尽/未选服务商）
#   source=remote|fallback
#   reason / provider-kind / base-url / secret-name / model / effort / thinking / kind / extra-args
#
# 两种模式：
#   仓库级（LANE 为空）：取该仓库 Claude 主审那一路的配置（provider-kind / secret-name 供 workflow 选凭据）。
#   通道级（LANE=glm / haiku-web / free-pool …）：取该仓库下某一路 review 的配置。通道的凭据固定在各自
#     workflow 里，PRboard 只管开关、模型、思考；回退值走独立的 LANE_FALLBACK_*，**不沿用**仓库级的
#     FALLBACK_MODEL——免费池脚本没有配置时必须收到「空」模型才会走自己的默认池，收到 Claude 模型名会整路跑废。
#
# 降级口径：拿不到有效配置（未配 token、超时、5xx、token 无效、响应异常）一律
# 回退到调用方传入的内置默认配置并 ::warning::，review 照常跑——review 只是辅助，
# 不该因为 PRboard 故障阻塞 CI。只有 PRboard 明确返回 enabled:false 才跳过。
#
# 安全：token 只进 curl 的 Authorization 头，从不回显；远端返回的值先做校验再写入
# $GITHUB_OUTPUT，避免远端值注入额外输出或参数：model/thinking/secret 名按格式校验，
# extraArgs 按"成对白名单"校验——与 src/lib/ai-review-config.ts 的 ALLOWED_EXTRA_ARGS
# 保持同步（目前只放行 `--max-turns <1-9999>`），改一边必须同步改另一边。
# 注意空数组：jq 的 `[] | _nwise(2)` 会产出一个空数组元素（不是零个），必须先单独放行 length == 0；
# secret 名同理，对应 isAllowedSecretName（只放行"像服务商凭据"的名字，防止被攻破的
# PRboard 把仓库里任意 secret 当 API key 发往外部端点）。
set -uo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
FALLBACK_KIND="${FALLBACK_KIND:-claude-oauth}"
FALLBACK_SECRET="${FALLBACK_SECRET:-CLAUDE_CODE_OAUTH_TOKEN}"
FALLBACK_MODEL="${FALLBACK_MODEL:-claude-opus-5-5}"
FALLBACK_EFFORT="${FALLBACK_EFFORT:-high}"
LANE="${LANE:-}"
LANE_FALLBACK_MODEL="${LANE_FALLBACK_MODEL:-}"
LANE_FALLBACK_THINKING="${LANE_FALLBACK_THINKING:-}"

out() { printf '%s=%s\n' "$1" "$2" >> "$GITHUB_OUTPUT"; }

fallback() {
  echo "::warning::AI review 配置回退到内置默认（$1）"
  out enabled true
  out source fallback
  out reason ""
  out kind ""
  out base-url ""
  out extra-args ""
  if [ -n "$LANE" ]; then
    out provider-kind ""
    out secret-name ""
    out model "$LANE_FALLBACK_MODEL"
    out thinking "$LANE_FALLBACK_THINKING"
    out effort "$LANE_FALLBACK_THINKING"
  else
    out provider-kind "$FALLBACK_KIND"
    out secret-name "$FALLBACK_SECRET"
    out model "$FALLBACK_MODEL"
    out thinking "$FALLBACK_EFFORT"
    out effort "$FALLBACK_EFFORT"
  fi
  exit 0
}

if [ -z "${PRBOARD_URL:-}" ] || [ -z "${TOKEN:-}" ]; then
  fallback "未配置 prboard-url 或 PRBOARD_TOKEN"
fi

BODY_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE"' EXIT

LANE_ARGS=()
[ -n "$LANE" ] && LANE_ARGS=(--data-urlencode "lane=${LANE}")

CODE=$(curl -sS --connect-timeout 5 --max-time 10 --retry 1 \
  -o "$BODY_FILE" -w '%{http_code}' \
  -H "Authorization: Bearer ${TOKEN}" \
  --get --data-urlencode "repo=${REPO}" ${LANE_ARGS[@]+"${LANE_ARGS[@]}"} \
  "${PRBOARD_URL%/}/api/ai-review/config" 2>/dev/null) || fallback "PRboard 不可达或超时"
[ "$CODE" = "200" ] || fallback "PRboard 返回 HTTP ${CODE}"

# 形状 + 内容校验；通不过就当作"拿不到有效配置"。
SECRET_OK='(test("^GITHUB_") | not) and test("^(AI_REVIEW_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN(_[0-9]+)?))$")'
# 通道级：模型按这一路的类型校验——claude-code 的模型会变成 --model 参数（单个干净 token）；
# api-script 的模型走环境变量，可以是逗号分隔的故障转移列表（≤12 个）。通道不带额外 CLI 参数。
LANE_VALID="
  def single: type == \"string\" and (. == \"\" or test(\"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}\$\"));
  def pool: type == \"string\" and (. == \"\" or test(\"^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}(,[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}){0,11}\$\"));
  if .enabled == true then
    (.kind == \"claude-code\" or .kind == \"api-script\")
    and (.providerKind == null or .providerKind == \"claude-oauth\" or .providerKind == \"anthropic-compatible\")
    and (.secretName == null or (.secretName | type == \"string\" and ${SECRET_OK}))
    and (if .kind == \"claude-code\" then (.model | single) else (.model | pool) end)
    and (.baseUrl == null or (.baseUrl | type == \"string\" and test(\"^https://[^[:space:]]+\$\")))
    and (.thinking == null or (.thinking | type == \"string\" and test(\"^[a-z]{1,10}\$\")))
    and (.extraArgs | type == \"array\" and length == 0)
  elif .enabled == false then
    (.reason | type == \"string\" and test(\"^[a-z_]+\$\"))
  else false end"
VALID='
  def safe: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$");
  if .enabled == true then
    (.providerKind == "claude-oauth" or .providerKind == "anthropic-compatible")
    and (.secretName | type == "string" and (test("^GITHUB_") | not)
         and test("^(AI_REVIEW_[A-Z0-9_]+|[A-Z][A-Z0-9_]*_(API_KEY|AUTH_TOKEN|OAUTH_TOKEN(_[0-9]+)?))$"))
    and (.model | safe)
    and (.baseUrl == null or (.baseUrl | type == "string" and test("^https://[^[:space:]]+$")))
    and (.thinking == null or (.thinking | IN("low","medium","high","xhigh","max")))
    and (.extraArgs | type == "array" and length % 2 == 0
         and (length == 0 or ([_nwise(2)] | all(.[0] == "--max-turns" and (.[1] | test("^[1-9][0-9]{0,3}$"))))))
  elif .enabled == false then
    (.reason | type == "string" and test("^[a-z_]+$"))
  else false end'
if [ -n "$LANE" ]; then PROGRAM="$LANE_VALID"; else PROGRAM="$VALID"; fi
jq -e "$PROGRAM" "$BODY_FILE" >/dev/null 2>&1 || fallback "PRboard 响应格式异常"

if [ "$(jq -r '.enabled' "$BODY_FILE")" = "false" ]; then
  REASON=$(jq -r '.reason' "$BODY_FILE")
  echo "::notice::PRboard 已停用本仓库的 AI review（${REASON}），跳过"
  out enabled false
  out source remote
  out reason "$REASON"
  exit 0
fi

out enabled true
out source remote
out reason ""
out kind "$(jq -r '.kind // ""' "$BODY_FILE")"
out provider-kind "$(jq -r '.providerKind // ""' "$BODY_FILE")"
out base-url "$(jq -r '.baseUrl // ""' "$BODY_FILE")"
out secret-name "$(jq -r '.secretName // ""' "$BODY_FILE")"
out model "$(jq -r '.model' "$BODY_FILE")"
if [ -n "$LANE" ]; then
  # 通道的思考值为空（页面上的"默认"）= 该路自己的默认，保持为空，由脚本/CLI 决定。
  out thinking "$(jq -r '.thinking // ""' "$BODY_FILE")"
  out effort "$(jq -r '.thinking // ""' "$BODY_FILE")"
else
  # 仓库级：thinking 为空（页面上的"默认"）时沿用调用方的 fallback-effort，保证 --effort 永远有值。
  out thinking "$(jq -r --arg d "$FALLBACK_EFFORT" '.thinking // $d' "$BODY_FILE")"
  out effort "$(jq -r --arg d "$FALLBACK_EFFORT" '.thinking // $d' "$BODY_FILE")"
fi
out extra-args "$(jq -r '.extraArgs | join(" ")' "$BODY_FILE")"
