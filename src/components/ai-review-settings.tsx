"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LaneTable } from "@/components/ai-review-lanes";
import { ProviderSection, selectClass } from "@/components/ai-review-providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  buildWorkflowSnippet,
  formatRelativeTime,
  reviewApi,
  type OverviewView,
  type RepoView,
} from "@/lib/ai-review-view";

const THINKING_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 创建/轮换 token 后只展示这一次的凭据面板。 */
interface IssuedToken {
  repoFullName: string;
  token: string;
}

function copy(text: string, label: string) {
  navigator.clipboard.writeText(text).then(
    () => toast.success(`${label}已复制`),
    () => toast.error("复制失败，请手动选择复制"),
  );
}

export function AiReviewSettings() {
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const [newRepo, setNewRepo] = useState("");
  const [issued, setIssued] = useState<IssuedToken | null>(null);

  const load = useCallback(async () => {
    try {
      setOverview(await reviewApi<OverviewView>("/api/settings/ai-review", "GET"));
    } catch {
      toast.error("加载 AI Review 设置失败");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载时拉取一次初始数据
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      toast.success(success);
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败");
      await load();
    }
  }

  async function addRepo() {
    const repoFullName = newRepo.trim();
    try {
      const created = await reviewApi<{ token: string }>("/api/settings/ai-review/repos", "POST", { repoFullName });
      setIssued({ repoFullName, token: created.token });
      setNewRepo("");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "添加失败");
    }
  }

  async function rotate(repo: RepoView) {
    if (!window.confirm(`轮换「${repo.repoFullName}」的 token？旧 token 会立即失效，需要更新该仓库的 PRBOARD_TOKEN secret。`)) return;
    try {
      const rotated = await reviewApi<{ token: string }>(`/api/settings/ai-review/repos/${repo.id}/token`, "POST");
      setIssued({ repoFullName: repo.repoFullName, token: rotated.token });
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "轮换失败");
    }
  }

  function patchRepo(repo: RepoView, patch: Record<string, unknown>) {
    return run(() => reviewApi(`/api/settings/ai-review/repos/${repo.id}`, "PATCH", patch), "已保存");
  }

  if (!overview) return <p className="text-sm text-muted-foreground">加载中…</p>;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>AI Review 管理</CardTitle>
          <CardDescription>集中控制各仓库 CI 里每一路 AI review（Claude、Haiku、GLM、免费池、@mention …）：开关、服务商、模型与思考等级。只有标「已接入」的才会真正生效。</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col">
              <span className="text-sm font-medium">暂停全部仓库</span>
              <span className="text-xs text-muted-foreground">开启后所有仓库的 AI review 立即跳过（比如额度告急时的总闸）。</span>
            </div>
            <Switch
              checked={overview.paused}
              onCheckedChange={(checked) =>
                run(() => reviewApi("/api/settings/ai-review", "PUT", { paused: Boolean(checked) }), checked ? "已暂停全部" : "已恢复")
              }
              aria-label="暂停全部仓库"
            />
          </div>
        </CardContent>
      </Card>

      <ProviderSection providers={overview.providers} onChanged={load} />

      <Card>
        <CardHeader>
          <CardTitle>仓库</CardTitle>
          <CardDescription>新增仓库默认关闭，选好服务商后再开启。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {overview.repos.length === 0 && <p className="text-sm text-muted-foreground">还没有接入的仓库。</p>}
          {overview.repos.map((repo) => (
            <div key={repo.id} className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{repo.repoFullName}</span>
                <Switch
                  checked={repo.enabled}
                  onCheckedChange={(checked) => patchRepo(repo, { enabled: Boolean(checked) })}
                  aria-label={`${repo.repoFullName} 开关`}
                />
              </div>
              <p className="text-xs font-medium">Claude 主审（该仓库 Claude review 的默认配置）</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  服务商
                  <select
                    className={selectClass}
                    value={repo.providerId ?? ""}
                    onChange={(e) => patchRepo(repo, { providerId: e.target.value || null })}
                  >
                    <option value="">未选择</option>
                    {overview.providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  模型
                  <Input
                    key={`${repo.id}:${repo.model}`}
                    defaultValue={repo.model}
                    onBlur={(e) => {
                      const model = e.target.value.trim();
                      if (model !== repo.model) void patchRepo(repo, { model });
                    }}
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                  思考等级
                  <select
                    className={selectClass}
                    value={repo.thinkingLevel ?? ""}
                    onChange={(e) => patchRepo(repo, { thinkingLevel: e.target.value || null })}
                  >
                    <option value="">默认</option>
                    {THINKING_OPTIONS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <LaneTable repo={repo} onChanged={load} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  最近拉配置：{formatRelativeTime(repo.lastConfigAt)} · 最近 review：{formatRelativeTime(repo.lastUsageAt)}
                </p>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="outline" onClick={() => rotate(repo)}>
                    轮换 token
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (window.confirm(`移除「${repo.repoFullName}」？其 token 将失效；已产生的用量记录保留，仍计入服务商的月额度。`)) {
                        void run(() => reviewApi(`/api/settings/ai-review/repos/${repo.id}`, "DELETE"), "已移除");
                      }
                    }}
                  >
                    移除
                  </Button>
                </div>
              </div>
            </div>
          ))}

          <div className="flex flex-col gap-2 sm:flex-row">
            <Input value={newRepo} onChange={(e) => setNewRepo(e.target.value)} placeholder="owner/repo，如 owner/other-repo" />
            <Button type="button" variant="outline" onClick={addRepo} disabled={newRepo.trim() === ""}>
              添加仓库
            </Button>
          </div>

          {issued && (
            <div className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3">
              <p className="text-sm font-medium">「{issued.repoFullName}」的接入凭据（只显示这一次）</p>
              <p className="text-xs text-muted-foreground">
                1) 把下面的 token 存为该仓库的 Actions secret <code>PRBOARD_TOKEN</code>；2) 把 workflow 片段接进该仓库的 review workflow。
              </p>
              <div className="flex gap-2">
                <Input readOnly value={issued.token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={() => copy(issued.token, "token ")}>
                  复制
                </Button>
              </div>
              <pre className="max-h-64 overflow-auto rounded-md bg-muted p-2 text-xs">{buildWorkflowSnippet(window.location.origin)}</pre>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => copy(buildWorkflowSnippet(window.location.origin), "片段")}>
                  复制片段
                </Button>
                <Button type="button" variant="ghost" onClick={() => setIssued(null)}>
                  我已保存，关闭
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
