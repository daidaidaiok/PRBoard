"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { quotaWindowLabel } from "@/lib/ai-review-config";
import {
  budgetPercent,
  formatAmount,
  formatRelativeTime,
  formatResetIn,
  formatUsageSummary,
  remainingPercent,
  reviewApi,
  statusBarClass,
  windowStatus,
  type ProviderView,
} from "@/lib/ai-review-view";

export const selectClass =
  "h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

interface FormState {
  name: string;
  kind: ProviderView["kind"];
  baseUrl: string;
  secretName: string;
  budgetLimit: string;
  budgetUnit: "" | "token" | "usd" | "count";
  /** 仅订阅：窗口已用达到该百分比就暂停；留空 = 只在被限流（100%）时才停。 */
  quotaStopPercent: string;
}

const EMPTY_FORM: FormState = {
  name: "",
  kind: "claude-oauth",
  baseUrl: "",
  secretName: "CLAUDE_CODE_OAUTH_TOKEN",
  budgetLimit: "",
  budgetUnit: "",
  quotaStopPercent: "95",
};

function toForm(provider: ProviderView): FormState {
  return {
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl ?? "",
    secretName: provider.secretName,
    budgetLimit: provider.budgetLimit === null ? "" : String(provider.budgetLimit),
    budgetUnit: provider.budgetUnit ?? "",
    quotaStopPercent: provider.quota?.stopPercent == null ? "" : String(provider.quota.stopPercent),
  };
}

export function ProviderSection({ providers, onChanged }: { providers: ProviderView[]; onChanged: () => void }) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  function startEdit(provider: ProviderView | null) {
    setEditingId(provider ? provider.id : "new");
    setForm(provider ? toForm(provider) : EMPTY_FORM);
  }

  async function save() {
    setSaving(true);
    try {
      const subscription = form.kind === "claude-oauth";
      // 订阅按限流窗口计量，没有金额预算；预算只属于按量计费的 API key。
      const limit = subscription ? "" : form.budgetLimit.trim();
      if (limit !== "" && !form.budgetUnit) {
        toast.error("填写了预算上限，请同时选择单位");
        return;
      }
      const stop = form.quotaStopPercent.trim();
      if (subscription && stop !== "" && !(Number.isInteger(Number(stop)) && Number(stop) >= 50 && Number(stop) <= 100)) {
        toast.error("暂停阈值需为 50–100 的整数，或留空");
        return;
      }
      const body = {
        name: form.name,
        kind: form.kind,
        baseUrl: subscription ? null : form.baseUrl.trim(),
        secretName: form.secretName.trim(),
        budgetLimit: limit === "" ? null : Number(limit),
        budgetUnit: limit === "" ? null : form.budgetUnit || null,
        ...(subscription ? { quotaStopPercent: stop === "" ? null : Number(stop) } : {}),
      };
      if (editingId === "new") await reviewApi("/api/settings/ai-review/providers", "POST", body);
      else await reviewApi(`/api/settings/ai-review/providers/${editingId}`, "PUT", body);
      toast.success("服务商已保存");
      setEditingId(null);
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function remove(provider: ProviderView) {
    if (!window.confirm(`删除服务商「${provider.name}」？引用它的仓库会变为"未选择服务商"并停止 review。`)) return;
    try {
      await reviewApi(`/api/settings/ai-review/providers/${provider.id}`, "DELETE");
      toast.success("服务商已删除");
      onChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>服务商与额度</CardTitle>
        <CardDescription>
          密钥始终留在各仓库的 GitHub Secrets 里，这里只记录用哪个 secret 名。Claude 订阅按限流窗口显示剩余额度，到暂停阈值自动暂停、窗口重置后自动恢复；按量计费的 API key 才有金额预算（按 UTC 自然月，达 90% 推送提醒，用尽后自动停用）。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {providers.length === 0 && <p className="text-sm text-muted-foreground">还没有服务商。先添加一个，再给仓库选用。</p>}
        {providers.map((provider) => {
          const percent = budgetPercent(provider.budgetLimit, provider.usedThisPeriod ?? 0);
          return (
            <div key={provider.id} className="flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  <Badge variant="secondary">{provider.kind === "claude-oauth" ? "Claude OAuth" : "Anthropic 兼容"}</Badge>
                </div>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => startEdit(provider)}>
                    编辑
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => remove(provider)}>
                    删除
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                secret：{provider.secretName}
                {provider.baseUrl ? ` · ${provider.baseUrl}` : ""}
              </p>
              {provider.quota ? (
                <div className="flex flex-col gap-2">
                  {provider.quota.windows.length === 0 ? (
                    <p className="text-xs text-muted-foreground">暂无额度读数，下一次 review 运行后显示。</p>
                  ) : (
                    provider.quota.windows.map((window) => {
                      const state = windowStatus(window.usedPercent, provider.quota?.stopPercent ?? null);
                      const left = remainingPercent(window.usedPercent);
                      return (
                        <div key={window.type} className="flex flex-col gap-1">
                          <Progress value={window.usedPercent ?? 0} aria-label={`${provider.name} ${quotaWindowLabel(window.type)}`}>
                            <ProgressTrack>
                              <ProgressIndicator className={statusBarClass(state)} />
                            </ProgressTrack>
                          </Progress>
                          <p className="text-xs text-muted-foreground">
                            {quotaWindowLabel(window.type)}：{left === null ? "已受限" : `剩余 ${left}%（已用 ${window.usedPercent}%）`} · {formatResetIn(window.resetsAt)}
                          </p>
                        </div>
                      );
                    })
                  )}
                  <p className="text-xs text-muted-foreground">
                    本月 {formatUsageSummary(provider.usage)}
                    {provider.quota.observedAt ? ` · 额度读数更新于 ${formatRelativeTime(provider.quota.observedAt)}（仅在 review 运行时更新）` : ""}
                  </p>
                  {provider.quota.status === "exhausted" && (
                    <p className="text-xs text-destructive">已到暂停阈值，相关仓库的 AI review 已暂停，窗口重置后自动恢复。</p>
                  )}
                  {provider.quota.status === "warn" && <p className="text-xs text-amber-600">额度告急。</p>}
                </div>
              ) : percent === null ? (
                <p className="text-xs text-muted-foreground">
                  未设预算上限 · {formatUsageSummary(provider.usage)}
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  <Progress value={percent} aria-label={`${provider.name} 额度`}>
                    <ProgressTrack>
                      <ProgressIndicator className={statusBarClass(provider.status)} />
                    </ProgressTrack>
                  </Progress>
                  <p className="text-xs text-muted-foreground">
                    {formatAmount(provider.budgetUnit, provider.usedThisPeriod ?? 0)} / {formatAmount(provider.budgetUnit, provider.budgetLimit ?? 0)}（{percent}%）· {formatUsageSummary(provider.usage)}
                    {provider.status === "exhausted" && " · 已用尽，相关仓库已自动停用"}
                    {provider.status === "warn" && " · 额度告急"}
                  </p>
                </div>
              )}
            </div>
          );
        })}

        {editingId === null ? (
          <Button type="button" variant="outline" className="w-fit" onClick={() => startEdit(null)}>
            添加服务商
          </Button>
        ) : (
          <div className="flex flex-col gap-3 rounded-lg border border-dashed p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">
                名称
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="如 GLM" />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                类型
                <select
                  className={selectClass}
                  value={form.kind}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as FormState["kind"] })}
                >
                  <option value="claude-oauth">Claude OAuth 订阅</option>
                  <option value="anthropic-compatible">Anthropic 兼容端点（GLM 等）</option>
                </select>
              </label>
              {form.kind === "anthropic-compatible" && (
                <label className="flex flex-col gap-1 text-sm sm:col-span-2">
                  Base URL（https）
                  <Input
                    value={form.baseUrl}
                    onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                    placeholder="https://open.bigmodel.cn/api/anthropic"
                  />
                </label>
              )}
              <label className="flex flex-col gap-1 text-sm">
                仓库 Secret 名
                <Input value={form.secretName} onChange={(e) => setForm({ ...form, secretName: e.target.value })} />
              </label>
              {form.kind === "claude-oauth" ? (
                <label className="flex flex-col gap-1 text-sm">
                  暂停阈值（窗口已用 %）
                  <Input
                    inputMode="numeric"
                    value={form.quotaStopPercent}
                    onChange={(e) => setForm({ ...form, quotaStopPercent: e.target.value })}
                    placeholder="留空 = 仅被限流时才停"
                  />
                  <span className="text-xs text-muted-foreground">订阅不按金额计费；任一窗口达到该值就暂停，重置后自动恢复。默认 95，给你自己使用留余量。</span>
                </label>
              ) : (
              <div className="flex gap-2">
                <label className="flex flex-1 flex-col gap-1 text-sm">
                  月预算上限（可空）
                  <Input
                    inputMode="decimal"
                    value={form.budgetLimit}
                    onChange={(e) => setForm({ ...form, budgetLimit: e.target.value })}
                    placeholder="不限"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  单位
                  <select
                    className={selectClass}
                    value={form.budgetUnit}
                    onChange={(e) => setForm({ ...form, budgetUnit: e.target.value as FormState["budgetUnit"] })}
                  >
                    <option value="">—</option>
                    <option value="token">tokens</option>
                    <option value="usd">美元</option>
                    <option value="count">次数</option>
                  </select>
                </label>
              </div>
              )}
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={save} disabled={saving}>
                {saving ? "保存中…" : "保存"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setEditingId(null)}>
                取消
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
