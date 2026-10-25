"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, CircleAlert, CircleCheck, CircleDashed, Clock3, ExternalLink, LoaderCircle, RefreshCw, RotateCcw, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { HostCapacityMonitor } from "@/components/host-capacity-monitor";
import type { ActiveJobItem } from "@/lib/github/active-jobs";
import { groupActiveJobsByHost } from "@/lib/github/active-jobs-view";
import { formatDurationSeconds } from "@/lib/github/progress";
import type { RunnerSummary } from "@/lib/github/runners";
import { mib, percentage } from "@/lib/host-capacity";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetch-with-timeout";
import { parseRealtimeEvent, shouldRefreshOnAnyEvent } from "@/lib/realtime-events";
import { useOnlineStatus } from "@/lib/use-online-status";

// Fallback only — the SSE subscription below refreshes whenever any watched
// repo or host event lands (check_run/workflow_run are exactly when busy
// flips), and returning to the tab refreshes stale data immediately. The
// shared throttle window keeps those two triggers from stacking.
const POLL_INTERVAL_MS = 300_000;
const RUNNER_SSE_MIN_REFRESH_MS = 60_000;
const VISIBILITY_STALE_MS = 30_000;

function statusLabel(status: string) {
  return status === "online" ? "在线" : status === "offline" ? "离线" : status;
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  return status === "online" ? "default" : status === "offline" ? "secondary" : "outline";
}

export function RunnerMonitor() {
  const [runners, setRunners] = useState<RunnerSummary[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeJobs, setActiveJobs] = useState<ActiveJobItem[] | null>(null);
  const [activeError, setActiveError] = useState<string | null>(null);
  // Same contract as the dashboard: heuristic signal that gates the banner
  // and pauses polling; never a data-trust signal.
  const online = useOnlineStatus();
  // Shared by the poll, the SSE listener and the visibility listener: time of
  // the last *successful* /api/runners fetch, 0 meaning "never fetched yet".
  // Only success advances it (in fetchRunners), so a failed refresh never
  // suppresses the next trigger; the in-flight flag is the burst debounce.
  const lastRefreshAt = useRef(0);
  const refreshInFlight = useRef(false);

  const fetchRunners = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const response = await fetchWithTimeout("/api/runners", { cache: "no-store" });
      const data = (await response.json()) as { runners?: RunnerSummary[]; checkedAt?: string; error?: string };
      if (!response.ok) throw new Error(data.error ?? "加载失败");
      setRunners(data.runners ?? []);
      setCheckedAt(data.checkedAt ?? null);
      // Only successful fetches advance the throttle window, so a failure
      // never suppresses the next SSE- or visibility-triggered attempt.
      lastRefreshAt.current = Date.now();
      setError(null);
    } catch (err) {
      setError(isTimeoutError(err) ? "请求超时，网络或服务响应缓慢" : err instanceof Error ? err.message : "加载失败");
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, []);

  const fetchActiveJobs = useCallback(async () => {
    try {
      const response = await fetchWithTimeout("/api/runners/active", { cache: "no-store" });
      const data = (await response.json()) as { jobs?: ActiveJobItem[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? "加载失败");
      setActiveJobs(data.jobs ?? []);
      setActiveError(null);
    } catch (err) {
      setActiveError(isTimeoutError(err) ? "请求超时，网络或服务响应缓慢" : err instanceof Error ? err.message : "加载失败");
    }
  }, []);

  /** Every refresh trigger below moves both panels together; overlapping triggers collapse into the in-flight one. */
  const refreshAll = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    void Promise.allSettled([fetchRunners(true), fetchActiveJobs()]).finally(() => {
      refreshInFlight.current = false;
    });
  }, [fetchRunners, fetchActiveJobs]);

  useEffect(() => {
    // Runner online/offline transitions are not included in PR webhooks.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (navigator.onLine) refreshAll();
    const timer = setInterval(() => {
      // Defensive: an SSE event may have just refreshed — stay inside the
      // shared throttle window instead of stacking a poll on top of it.
      if (Date.now() - lastRefreshAt.current < RUNNER_SSE_MIN_REFRESH_MS) return;
      if (navigator.onLine) refreshAll();
    }, POLL_INTERVAL_MS);
    // Reconnect: the next 5min tick is too late, refresh immediately.
    window.addEventListener("online", refreshAll);
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", refreshAll);
    };
  }, [refreshAll]);

  // Coming back to a backgrounded tab used to mean staring at stale runner
  // state until the next poll — refresh on visibility when data is stale.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (!navigator.onLine) return;
      if (Date.now() - lastRefreshAt.current < VISIBILITY_STALE_MS) return;
      refreshAll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [refreshAll]);

  // Real-time push: webhook / host ingest -> Postgres NOTIFY -> this SSE
  // stream -> throttled refetch. Runner busy flips exactly on check_run and
  // workflow_run events, so any update event is a valid refresh trigger; the
  // fixed poll above stays as the fallback. EventSource reconnects on its
  // own, so errors are left to it silently.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("update", (event: MessageEvent) => {
      if (!navigator.onLine) return;
      const payload = parseRealtimeEvent(typeof event.data === "string" ? event.data : "");
      if (!shouldRefreshOnAnyEvent(payload, lastRefreshAt.current, Date.now(), RUNNER_SSE_MIN_REFRESH_MS)) return;
      refreshAll();
    });
    return () => source.close();
  }, [refreshAll]);

  const stats = useMemo(() => ({
    total: runners?.length ?? 0,
    online: runners?.filter((runner) => runner.status === "online").length ?? 0,
    offline: runners?.filter((runner) => runner.status === "offline").length ?? 0,
    busy: runners?.filter((runner) => runner.busy).length ?? 0,
  }), [runners]);

  const grouped = useMemo(() => {
    const groups = new Map<string, RunnerSummary[]>();
    for (const runner of runners ?? []) {
      groups.set(runner.repoFullName, [...(groups.get(runner.repoFullName) ?? []), runner]);
    }
    return [...groups.entries()];
  }, [runners]);

  const activeGroups = useMemo(() => groupActiveJobsByHost(activeJobs ?? []), [activeJobs]);

  return (
    <div className="flex flex-col gap-4">
      <HostCapacityMonitor />
      <div className="border-t" />
      {!online && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            <WifiOff className="size-4 flex-none" />
            网络已断开——显示的是最近一次加载的数据，恢复连接后会自动刷新。
          </CardContent>
        </Card>
      )}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-semibold"><Activity className="size-5" />Runner 监控</h2>
          <p className="text-sm text-muted-foreground">监控所有已接入仓库的 self-hosted runner 在线状态</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void fetchRunners(); void fetchActiveJobs(); }} disabled={refreshing}>
          <RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} />刷新
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[["全部", stats.total], ["在线", stats.online], ["离线", stats.offline], ["忙碌", stats.busy]].map(([label, count]) => (
          <Card key={label as string} size="sm"><CardContent className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span><strong className="text-lg tabular-nums">{count}</strong></CardContent></Card>
        ))}
      </div>
      {checkedAt && <p className="text-xs text-muted-foreground">最近检查：{new Date(checkedAt).toLocaleString("zh-CN")}</p>}
      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert className="size-4 flex-none" />
            <span className="min-w-0 break-words">加载失败：{error}</span>
            <Button size="sm" variant="outline" className="ml-auto flex-none" onClick={() => fetchRunners()} disabled={refreshing}>
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </CardContent>
        </Card>
      )}
      {runners !== null && runners.length === 0 && !error && <Card><CardContent className="text-sm text-muted-foreground">当前监控仓库没有 self-hosted runner。</CardContent></Card>}
      {activeError && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center gap-2 text-sm text-destructive">
            <CircleAlert className="size-4 flex-none" />
            进行中/排队中任务加载失败：{activeError}
          </CardContent>
        </Card>
      )}
      {activeGroups.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">进行中 / 排队中</h3>
          {activeGroups.map((group) => (
              <Card key={group.key} size="sm">
                <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${group.host && !group.host.stale ? "bg-emerald-500" : "bg-zinc-400"}`} />
                    <h4 className="truncate font-medium">{group.host ? group.host.displayName : "排队中 · 等待空闲 Runner"}</h4>
                    {group.runnerName && <span className="truncate text-xs text-muted-foreground">{group.runnerName}</span>}
                  </div>
                  {group.host && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-muted-foreground">
                      {group.host.stale && <Badge variant="secondary">遥测过期</Badge>}
                      <span>CPU {percentage(group.host.cpuUsageBasisPoints)}</span>
                      <span>内存 {mib(group.host.memoryUsedMib)} / {mib(group.host.memoryTotalMib)}</span>
                      {group.host.load1 !== null && <span>Load {group.host.load1.toFixed(2)}</span>}
                    </div>
                  )}
                </CardHeader>
                <CardContent className="flex flex-col gap-1.5">
                  {group.jobs.map((job) => (
                    <a key={job.htmlUrl} href={job.htmlUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg bg-muted/50 p-2 text-sm hover:bg-muted">
                      {job.status === "in_progress" ? (
                        <LoaderCircle className="size-3.5 flex-none motion-safe:animate-spin text-amber-500" />
                      ) : (
                        <Clock3 className="size-3.5 flex-none text-amber-500" />
                      )}
                      <span className="truncate font-medium">{job.jobName}</span>
                      <span className="truncate text-xs text-muted-foreground">{job.workflowName} · {job.repoFullName}</span>
                      {job.startedAt && job.status === "in_progress" && (
                        <span className="ml-auto whitespace-nowrap text-xs tabular-nums text-muted-foreground">
                          {formatDurationSeconds(Math.max(0, Math.round((Date.now() - Date.parse(job.startedAt)) / 1000)))}
                        </span>
                      )}
                      <ExternalLink className="size-3 flex-none text-muted-foreground" />
                    </a>
                  ))}
                </CardContent>
              </Card>
            ))}
        </section>
      )}
      <div className="flex flex-col gap-3">
        {grouped.map(([repo, repoRunners]) => (
          <Card key={repo}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0"><h3 className="font-medium">{repo}</h3><span className="text-xs text-muted-foreground">{repoRunners.filter((runner) => runner.status === "online").length}/{repoRunners.length} 在线</span></CardHeader>
            <CardContent className="flex flex-col gap-2">
              {repoRunners.map((runner) => (
                <div key={`${repo}-${runner.id}`} className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-2"><span className={`size-2 shrink-0 rounded-full ${runner.status === "online" ? "bg-emerald-500" : runner.status === "offline" ? "bg-zinc-400" : "bg-amber-500"}`} /><span className="truncate font-medium" title={runner.name}>{runner.name}</span></div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground"><span>{runner.os}</span>{runner.busy && <Badge variant="outline">忙碌</Badge>}<Badge variant={statusVariant(runner.status)}>{runner.status === "online" ? <CircleCheck className="size-3" /> : <CircleDashed className="size-3" />}{statusLabel(runner.status)}</Badge></div>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
