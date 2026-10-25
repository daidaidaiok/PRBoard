"use client";

import { useState } from "react";
import { toast } from "sonner";
import { selectClass } from "@/components/ai-review-providers";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { LANE_PRESETS, laneStatus, meterLabel, reviewApi, type LaneView, type RepoView } from "@/lib/ai-review-view";

const TONE_CLASS = { on: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300", off: "bg-muted text-muted-foreground", readonly: "bg-amber-500/15 text-amber-700 dark:text-amber-300" } as const;

/**
 * 一个项目 CI 里除 Claude 主审之外的各路 review：每路一行，显示模型、思考、凭据、计量方式，
 * 并能开关、改模型与思考。只有「已接入」（CI 真的读取 PRboard 配置）的通道可改；
 * 未接入的只读并明确标注，避免面板说 X、实际跑 Y。
 */
export function LaneTable({ repo, onChanged }: { repo: RepoView; onChanged: () => void }) {
  const [adding, setAdding] = useState(false);
  const [presetId, setPresetId] = useState(LANE_PRESETS[0].id);
  const [laneKey, setLaneKey] = useState(LANE_PRESETS[0].laneKey);
  const [label, setLabel] = useState(LANE_PRESETS[0].label);

  async function act(action: () => Promise<unknown>, success?: string) {
    try {
      await action();
      if (success) toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      onChanged();
    }
  }

  const patch = (lane: LaneView, body: Record<string, unknown>) =>
    act(() => reviewApi(`/api/settings/ai-review/lanes/${lane.id}`, "PATCH", body), "已保存");

  function pickPreset(id: string) {
    const preset = LANE_PRESETS.find((p) => p.id === id) ?? LANE_PRESETS[0];
    setPresetId(preset.id);
    setLaneKey(preset.laneKey);
    setLabel(preset.label);
  }

  function add() {
    const preset = LANE_PRESETS.find((p) => p.id === presetId) ?? LANE_PRESETS[0];
    void act(
      () =>
        reviewApi(`/api/settings/ai-review/repos/${repo.id}/lanes`, "POST", {
          laneKey: laneKey.trim(),
          label: label.trim(),
          kind: preset.kind,
          thinkingMode: preset.thinkingMode,
          model: preset.model,
          thinking: preset.thinking,
          credential: preset.credential,
          meter: preset.meter,
        }),
      "已添加（默认未接入，只是记录）",
    ).then(() => setAdding(false));
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium">其余各路 review</p>
      {repo.lanes.length === 0 && <p className="text-xs text-muted-foreground">还没有登记其它通道（Haiku、GLM、免费池、@mention …）。</p>}
      {repo.lanes.map((lane) => {
        const status = laneStatus(lane);
        const hasThinking = lane.thinkingOptions.length > 0;
        return (
          <div key={lane.id} className="flex flex-col gap-2 rounded-md border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{lane.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${TONE_CLASS[status.tone]}`}>{status.text}</span>
                <Badge variant="secondary">{meterLabel(lane.meter)}</Badge>
              </div>
              <Switch
                checked={lane.enabled}
                disabled={!status.editable}
                onCheckedChange={(checked) => patch(lane, { enabled: Boolean(checked) })}
                aria-label={`${repo.repoFullName} ${lane.label} 开关`}
                className={status.editable ? undefined : "opacity-40"}
                title={status.editable ? undefined : "未接入：CI 没有读取 PRboard 配置，改了不会生效"}
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-[2fr_1fr]">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                模型{lane.model.includes(",") || lane.meter === "free" ? "（逗号分隔 = 按顺序故障转移）" : ""}
                {status.editable ? (
                  <Input
                    key={`${lane.id}:${lane.model}`}
                    defaultValue={lane.model}
                    placeholder="留空 = 未指定，用默认"
                    onBlur={(e) => {
                      const model = e.target.value.trim();
                      if (model !== lane.model) void patch(lane, { model });
                    }}
                  />
                ) : (
                  <span className="break-all text-sm text-foreground">{lane.model || "（未指定，用默认）"}</span>
                )}
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                思考
                {!hasThinking ? (
                  <span className="text-sm text-foreground">— 该路不支持思考控制</span>
                ) : status.editable ? (
                  <select className={selectClass} value={lane.thinking ?? ""} onChange={(e) => patch(lane, { thinking: e.target.value || null })}>
                    <option value="">默认</option>
                    {lane.thinkingOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-sm text-foreground">{lane.thinking ?? "默认"}</span>
                )}
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                凭据：{lane.credential ?? "—"}
                {lane.notes ? ` · ${lane.notes}` : ""}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const next = !lane.wired;
                    const message = next
                      ? `仅当「${lane.label}」的 workflow 已经读取 PRboard 配置时才标记为已接入，否则面板上的修改不会生效。确认标记？`
                      : `标记为未接入后，面板上对「${lane.label}」的修改将不再生效（只作记录）。确认？`;
                    if (window.confirm(message)) void patch(lane, { wired: next });
                  }}
                >
                  {lane.wired ? "标记为未接入" : "标记为已接入"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    if (window.confirm(`移除「${lane.label}」这条记录？不会影响 CI 里实际运行的 workflow。`)) {
                      void act(() => reviewApi(`/api/settings/ai-review/lanes/${lane.id}`, "DELETE"), "已移除");
                    }
                  }}
                >
                  移除
                </Button>
              </div>
            </div>
          </div>
        );
      })}

      {adding ? (
        <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
          <div className="grid gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              类型
              <select className={selectClass} value={presetId} onChange={(e) => pickPreset(e.target.value)}>
                {LANE_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              通道标识（小写字母、数字、连字符）
              <Input value={laneKey} onChange={(e) => setLaneKey(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              显示名
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={add}>
              添加
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setAdding(true)}>
          添加通道
        </Button>
      )}
    </div>
  );
}
