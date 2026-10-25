import { budgetStatus, quotaStatus, quotaWindowLabel } from "@/lib/ai-review-config";
import { sendBarkNotification } from "@/lib/bark";
import { claimBudgetAlert, loadProviderBudget, releaseBudgetAlert } from "./ai-review";
import { getNotificationSettings } from "./notification-settings";

const BARK_GROUP = "prboard-ai-review";

/**
 * usage 回报入库后调用：额度达 90% 推警告，达 100% 推"已自动停用"。
 * 每个服务商每月每档只推一次（claimBudgetAlert 原子认领）。没配 Bark 时
 * 不认领名额——之后补配 Bark 仍能收到当月的预警。推送失败会释放认领，
 * 下一次 usage 回报重试，避免一次网络抖动让整月静默。
 */
export async function checkBudgetAlert(
  userId: number,
  providerId: string,
  now = new Date(),
): Promise<"none" | "warn-sent" | "exhausted-sent"> {
  const budget = await loadProviderBudget(userId, providerId, now);
  if (!budget) return "none";

  // 订阅（claude-oauth）：按限流窗口判定，不是金额预算。去重键 = 窗口类型 + 重置时间，
  // 这样下一个 5 小时窗口、下一周的 7 天窗口都会重新提醒，而同一窗口只提醒一次。
  let status: "ok" | "warn" | "exhausted";
  let period: string;
  let body: string;
  let name = budget.name;
  if (budget.quota) {
    const quota = quotaStatus(budget.quota.windows, budget.quota.stopRatio, now);
    status = quota.status;
    if (status === "ok" || !quota.binding) return "none";
    const window = quota.binding;
    const percent = window.utilization === null ? "已受限" : `${Math.round(window.utilization * 100)}%`;
    const resets = window.resetsAt ? `，${window.resetsAt.toISOString().slice(0, 16).replace("T", " ")} UTC 重置` : "";
    period = `${window.type}@${window.resetsAt ? window.resetsAt.toISOString() : "unknown"}`;
    body =
      status === "exhausted"
        ? `${quotaWindowLabel(window.type)}已用 ${percent}${resets}；相关仓库的 AI review 已暂停，重置后自动恢复`
        : `${quotaWindowLabel(window.type)}已用 ${percent}${resets}`;
    name = `${budget.name}（订阅）`;
  } else {
    status = budgetStatus(budget.budgetLimit, budget.used);
    if (status === "ok") return "none";
    period = now.toISOString().slice(0, 7);
    body = status === "exhausted" ? "本月额度已用完，相关仓库的 AI review 已自动停用" : "本月额度已用 90% 以上";
  }

  const { barkUrl } = await getNotificationSettings(userId);
  if (!barkUrl) return "none";
  if (!(await claimBudgetAlert(providerId, period, status))) return "none";

  const exhausted = status === "exhausted";
  const result = await sendBarkNotification(
    barkUrl,
    {
      title: exhausted ? `AI review 额度已用尽：${name}` : `AI review 额度告急：${name}`,
      body,
      level: exhausted ? "timeSensitive" : "active",
    },
    { group: BARK_GROUP },
  );
  if (!result.ok) {
    await releaseBudgetAlert(providerId, period, status);
    return "none";
  }
  return exhausted ? "exhausted-sent" : "warn-sent";
}
