// 一个仓库下各路 review 通道的纯逻辑：每一路支持什么思考选项、模型/思考值是否合法。
// 面板只给每一路提供它真正支持的选项（比如 Haiku 5.5 没有思考控制、免费池不传思考参数），
// 服务端用同一份规则校验——模型名最终会变成 CLI 参数或环境变量，必须严格。

import { THINKING_LEVELS } from "./ai-review-config";

/** claude-code：claude-code-action 的一路（模型是 --model 参数）；api-script：脚本直连 API（模型走环境变量）。 */
export type LaneKind = "claude-code" | "api-script";
/** 该路的思考控制方式：effort = low..max；toggle = off/on/max（GLM）；none = 没有思考控制。 */
export type ThinkingMode = "effort" | "toggle" | "none";
/** 计量方式：订阅窗口 / 按量美元 / 套餐 / 免费。仅用于展示。 */
export type LaneMeter = "subscription" | "usd" | "plan" | "free";

export const LANE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

const TOGGLE_OPTIONS = ["off", "on", "max"] as const;

export function thinkingOptionsFor(mode: ThinkingMode): readonly string[] {
  switch (mode) {
    case "effort":
      return THINKING_LEVELS;
    case "toggle":
      return TOGGLE_OPTIONS;
    default:
      return [];
  }
}

export interface LaneFields {
  kind: LaneKind;
  thinkingMode: ThinkingMode;
  model: string;
  thinking: string | null;
}

const SINGLE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
/** 故障转移链里的单个模型名：允许 provider 前缀、冒号后缀（如 :free）、@ 版本号。 */
const POOL_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;
const MAX_POOL_SIZE = 12;

export function validateLaneFields(fields: LaneFields): { ok: true } | { ok: false; error: string } {
  if (fields.kind === "claude-code" && fields.thinkingMode !== "effort") {
    return { ok: false, error: "claude-code lanes use the effort scale" };
  }
  // 空模型 = 「不指定，用 CLI / 脚本自带的默认」：比如从没传过 --model 的 @mention，
  // 或没有配置时走自己默认池的免费池脚本。
  if (fields.model !== "") {
    if (fields.kind === "claude-code") {
      if (!SINGLE_MODEL.test(fields.model)) return { ok: false, error: "invalid model" };
    } else {
      const models = fields.model.split(",");
      if (models.length > MAX_POOL_SIZE || models.some((m) => !POOL_MODEL.test(m))) return { ok: false, error: "invalid model" };
    }
  }
  if (fields.thinking !== null && !thinkingOptionsFor(fields.thinkingMode).includes(fields.thinking)) {
    return { ok: false, error: "invalid thinking" };
  }
  return { ok: true };
}
