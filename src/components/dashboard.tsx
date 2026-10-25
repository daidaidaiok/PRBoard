"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { PullRequestSummary, CheckItem } from "@/lib/github/prs";
import { rerunWorkflowRuns } from "@/lib/github/retry-policy";
import { fetchWithTimeout, isTimeoutError } from "@/lib/fetch-with-timeout";
import { parseRealtimeEvent } from "@/lib/realtime-events";
import { loadCachedDashboard, saveCachedDashboard } from "@/lib/prs-cache";
import { useOnlineStatus } from "@/lib/use-online-status";
import { PrCard, checkStatusMeta, prCanMerge } from "@/components/pr-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCw, LoaderCircle, LayoutGrid, FolderGit2, History, RotateCcw, WifiOff } from "lucide-react";

const ALL_PROJECTS = "__all__";

// Fallback only — real-time updates come from the SSE connection below.
// This just covers the gap if that connection is ever down. On repeated
// failures the cadence backs off exponentially up to MAX_POLL_INTERVAL_MS
// so a dead network doesn't turn into a request every 90s forever. While
// the browser reports offline, the poll parks entirely (OFFLINE_RETRY_MS).
const FALLBACK_POLL_INTERVAL_MS = 90_000;
// First failure retries at seconds-scale instead of entering the backoff
// curve at 90s × 2 — a transient GitHub blip mustn't cost the user a
// minutes-long error banner (worse on a first-ever load, where there is no
// snapshot to degrade to). Later failures still double up to the cap.
const QUICK_RETRY_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 720_000;
// While the browser reports offline the poll parks at this cadence instead
// of timing out against a dead network and ratcheting the backoff.
const OFFLINE_RETRY_MS = 10_000;

function repoShortName(fullName: string): string {
  return fullName.slice(fullName.lastIndexOf("/") + 1);
}

/** First-paint placeholder while the very first fetch is in flight — the localStorage preload usually covers this instead. */
function PrCardSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-44" />
        </div>
        <Skeleton className="h-8 w-20 rounded-md" />
      </CardHeader>
      <CardContent className="flex items-center gap-2 pt-0">
        <Skeleton className="h-2 flex-1 rounded-full" />
        <Skeleton className="h-3 w-14" />
      </CardContent>
      <CardContent className="flex items-center gap-2.5 pt-0">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="size-4 rounded-full" />
        ))}
      </CardContent>
    </Card>
  );
}

export function Dashboard({ hasInstallation = true, userLogin }: { hasInstallation?: boolean; userLogin: string }) {
  const [prs, setPrs] = useState<PullRequestSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<PullRequestSummary | null>(null);
  const [mergedPrIds, setMergedPrIds] = useState<Set<string>>(new Set());
  const [live, setLive] = useState(false);
  const [selectedProject, setSelectedProject] = useState<string>(ALL_PROJECTS);
  // Set when the server served the last-good snapshot because GitHub was
  // unreachable — the board still renders, but must say it's not live.
  const [staleCapturedAt, setStaleCapturedAt] = useState<string | null>(null);
  // Browser-level connectivity. Gates the offline banner and pauses the
  // poll; it is a heuristic (captive portals read "online") and never a
  // data-trust signal.
  const online = useOnlineStatus();

  // One-shot flourishes for state transitions (pending -> pass/fail, PR just
  // became mergeable).
  const [poppingChecks, setPoppingChecks] = useState<Set<string>>(new Set());
  const [shakingChecks, setShakingChecks] = useState<Set<string>>(new Set());
  const [readyPrs, setReadyPrs] = useState<Set<string>>(new Set());

  // Detecting a transition and reacting to it is "adjusting state based on a
  // prop change" (https://react.dev/learn/you-might-not-need-an-effect), so
  // it belongs in the render body guarded by an identity check against the
  // previous `prs` snapshot, not in a useEffect — an effect would fire
  // setState synchronously on every fetch, and refs can't be read or written
  // during render.
  //
  // `checkLabelMemory`/`rollupMemory` are merged forward rather than rebuilt
  // from just the immediately-previous fetch: PR listing goes through
  // GitHub's search API, which is eventually consistent, so a PR/check can
  // transiently drop out of one response — replacing the whole baseline each
  // time would forget its last-known state and silently miss the transition
  // when it reappears.
  const [scannedPrs, setScannedPrs] = useState<PullRequestSummary[] | null>(null);
  const [checkLabelMemory, setCheckLabelMemory] = useState<Map<string, string>>(new Map());
  const [rollupMemory, setRollupMemory] = useState<Map<string, string | null>>(new Map());
  if (prs !== scannedPrs) {
    setScannedPrs(prs);
    if (prs) {
      const newlyPassed: string[] = [];
      const newlyFailed: string[] = [];
      const nextLabelMemory = new Map(checkLabelMemory);
      for (const pr of prs) {
        for (const check of pr.checks) {
          const label = checkStatusMeta(check).label;
          const prevLabel = checkLabelMemory.get(check.id);
          if (prevLabel && prevLabel !== label) {
            if (label === "通过") newlyPassed.push(check.id);
            else if (label === "失败") newlyFailed.push(check.id);
          }
          nextLabelMemory.set(check.id, label);
        }
      }
      setCheckLabelMemory(nextLabelMemory);
      // Keep popping/shaking mutually exclusive — a check that shakes into
      // failure and pops back to success before its first animation's
      // onAnimationEnd fires would otherwise sit in both Sets, and since the
      // two `animate-*` utilities both drive the single-valued `animation`
      // property, only one would actually play.
      if (newlyPassed.length > 0) {
        setPoppingChecks((prev) => new Set([...prev, ...newlyPassed]));
        setShakingChecks((prev) => {
          if (!newlyPassed.some((id) => prev.has(id))) return prev;
          const next = new Set(prev);
          newlyPassed.forEach((id) => next.delete(id));
          return next;
        });
      }
      if (newlyFailed.length > 0) {
        setShakingChecks((prev) => new Set([...prev, ...newlyFailed]));
        setPoppingChecks((prev) => {
          if (!newlyFailed.some((id) => prev.has(id))) return prev;
          const next = new Set(prev);
          newlyFailed.forEach((id) => next.delete(id));
          return next;
        });
      }

      const nextRollupMemory = new Map(rollupMemory);
      const newlyReady: string[] = [];
      for (const pr of prs) {
        const prevState = rollupMemory.get(pr.id);
        if (prevState !== undefined && prevState !== "success" && pr.rollupState === "success" && prCanMerge(pr)) {
          newlyReady.push(pr.id);
        }
        nextRollupMemory.set(pr.id, pr.rollupState);
      }
      setRollupMemory(nextRollupMemory);
      if (newlyReady.length > 0) setReadyPrs((prev) => new Set([...prev, ...newlyReady]));
    }
  }

  // 90s poll, SSE updates, and the manual refresh button can all trigger a
  // fetch concurrently; without cancellation, a slower-but-earlier request
  // can resolve after a faster-but-later one and clobber fresher state with
  // stale data — which the transition-detection above would then read as a
  // spurious (or missed) status change. Aborting the previous in-flight
  // request (rather than just comparing sequence numbers after the fact)
  // also avoids starvation: under a burst of triggers arriving faster than
  // any single request round-trips (e.g. a flurry of webhook-driven SSE
  // updates), a "let only the latest-started one apply" counter can end up
  // discarding every response forever since a newer request is always
  // already in flight — aborting guarantees the burst's last request is
  // never itself superseded, so it always gets to complete and apply.
  const abortRef = useRef<AbortController | null>(null);
  // Consecutive failed fetches drive the poll backoff below. SSE updates
  // still refetch immediately regardless — a failure streak only stretches
  // the fallback cadence, never the event-driven path.
  const failureStreakRef = useRef(0);
  const fetchPrs = useCallback(
    async (opts?: { silent?: boolean }): Promise<boolean> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      if (!opts?.silent) setRefreshing(true);
      try {
        const res = await fetchWithTimeout("/api/prs", { signal: controller.signal });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "加载失败");
        failureStreakRef.current = 0;
        setPrs(data.prs);
        setStaleCapturedAt(data.stale ? (data.capturedAt ?? null) : null);
        saveCachedDashboard(data.prs, userLogin);
        setError(null);
        return true;
      } catch (e) {
        // Distinguish "superseded" from "timed out" by OUR controller's
        // state, not the error name: WebKit doesn't propagate abort reasons
        // (bugs.webkit.org/show_bug.cgi?id=246069), so a timeout surfaces
        // there as a bare AbortError just like a superseded request.
        const aborted = e instanceof DOMException && e.name === "AbortError";
        if (aborted && controller.signal.aborted) return true;
        failureStreakRef.current += 1;
        setError(aborted || isTimeoutError(e) ? "请求超时，网络或服务响应缓慢" : e instanceof Error ? e.message : "加载失败");
        return false;
      } finally {
        if (abortRef.current === controller) setRefreshing(false);
      }
    },
    [userLogin],
  );

  // Paint the last-good list from localStorage before the first network
  // round-trip resolves, so a slow load doesn't restart at a spinner — the
  // fetch below overwrites it with fresh data as soon as one lands. Reading
  // localStorage happens in an effect (not the state initializer) so server
  // render and hydration agree on "loading".
  useEffect(() => {
    const cached = loadCachedDashboard(userLogin);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (cached) setPrs(cached.prs);
  }, [userLogin]);

  useEffect(() => {
    // react-hooks/set-state-in-effect flags any effect that eventually calls
    // setState, including this standard fetch-on-mount-and-poll pattern —
    // there's no derived-state alternative here, this is genuinely
    // synchronizing with an external system (GitHub via our API).
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tick = () => {
      // Offline: skip the fetch entirely (it would just burn the 20s timeout)
      // and park briefly — the `online` event below refreshes immediately.
      if (!navigator.onLine) {
        timer = setTimeout(tick, OFFLINE_RETRY_MS);
        return;
      }
      void fetchPrs({ silent: true }).then(() => {
        if (cancelled) return;
        const streak = failureStreakRef.current;
        const delay = streak > 0 ? Math.min(QUICK_RETRY_MS * 2 ** (streak - 1), MAX_POLL_INTERVAL_MS) : FALLBACK_POLL_INTERVAL_MS;
        timer = setTimeout(tick, delay);
      });
    };
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [fetchPrs]);

  // Reconnect: the poll may be parked in its offline pause, so the browser's
  // online event itself triggers the immediate refresh.
  useEffect(() => {
    const refresh = () => void fetchPrs({ silent: true });
    window.addEventListener("online", refresh);
    return () => window.removeEventListener("online", refresh);
  }, [fetchPrs]);

  // Real-time push: webhook -> Postgres NOTIFY -> this SSE stream -> refetch.
  // EventSource reconnects on its own if the connection drops; `live` just
  // reflects current connection state for the UI, it doesn't gate fetching.
  useEffect(() => {
    const source = new EventSource("/api/events");
    source.addEventListener("connected", () => setLive(true));
    // Host-telemetry events (reason: "host-metrics") are consumed by the
    // host capacity monitor's own SSE subscription — letting them through
    // here would refetch the whole PR board on every host ingest, which is
    // exactly the amplification this filtering exists to prevent.
    source.addEventListener("update", (event: MessageEvent) => {
      const payload = parseRealtimeEvent(typeof event.data === "string" ? event.data : "");
      if (payload?.reason === "host-metrics") return;
      fetchPrs({ silent: true });
    });
    source.onerror = () => setLive(false);
    return () => source.close();
  }, [fetchPrs]);

  // Fallback cleanup: onAnimationEnd doesn't fire for prefers-reduced-motion
  // users (the flourish classes are motion-safe-gated) or if a PR/check is
  // removed from the list mid-animation, so ids would otherwise sit in these
  // Sets for the rest of the session. Sweep them well after the longest
  // flourish (the 1.6s ready-glow) has had time to finish.
  useEffect(() => {
    if (poppingChecks.size === 0 && shakingChecks.size === 0 && readyPrs.size === 0) return;
    const timer = setTimeout(() => {
      setPoppingChecks(new Set());
      setShakingChecks(new Set());
      setReadyPrs(new Set());
    }, 2000);
    return () => clearTimeout(timer);
  }, [poppingChecks, shakingChecks, readyPrs]);

  const handleReadyGlowEnd = useCallback((prId: string) => {
    setReadyPrs((prev) => {
      if (!prev.has(prId)) return prev;
      const next = new Set(prev);
      next.delete(prId);
      return next;
    });
  }, []);

  const handleFlourishEnd = useCallback((checkId: string) => {
    setPoppingChecks((prev) => {
      if (!prev.has(checkId)) return prev;
      const next = new Set(prev);
      next.delete(checkId);
      return next;
    });
    setShakingChecks((prev) => {
      if (!prev.has(checkId)) return prev;
      const next = new Set(prev);
      next.delete(checkId);
      return next;
    });
  }, []);

  async function confirmMerge() {
    if (!mergeTarget) return;
    const pr = mergeTarget;
    setPendingKey(`merge-${pr.id}`);
    try {
      const res = await fetchWithTimeout("/api/prs/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoFullName: pr.repoFullName, prNumber: pr.number }),
        // Generous on purpose: the server's own GitHub call is bounded at
        // 30s, and a merge that actually landed but timed out client-side
        // must look like a timeout, not a silent half-failure.
        timeoutMs: 45_000,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "合并失败");
      // Merging is terminal, but the open-PR list comes from GitHub's search
      // API, which lags behind a just-merged PR — marking it locally makes
      // the card leave the list immediately and keeps it gone when a laggy
      // refetch still returns it.
      setMergedPrIds((prev) => new Set(prev).add(pr.id));
      toast.success(`已合并 ${pr.repoFullName}#${pr.number}`);
      void fetchPrs({ silent: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "合并失败");
    } finally {
      // Guarded clear: if another operation started while this one was in
      // flight, clearing unconditionally would drop its pending indicator.
      setPendingKey((cur) => (cur === `merge-${pr.id}` ? null : cur));
      setMergeTarget(null);
    }
  }

  const requestRerun = useCallback(async (repoFullName: string, workflowRunId: number) => {
    const res = await fetchWithTimeout("/api/checks/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoFullName, workflowRunId }),
      timeoutMs: 45_000,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "重试失败");
  }, []);

  const handleRerun = useCallback(
    async (pr: PullRequestSummary, check: CheckItem) => {
      if (!check.canRerun || check.workflowRunId === null) return;
      setPendingKey(`rerun-${check.workflowRunId}`);
      try {
        await requestRerun(pr.repoFullName, check.workflowRunId);
        toast.success(`已重新触发 ${check.name}`);
        await fetchPrs({ silent: true });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "重试失败");
      } finally {
        setPendingKey((cur) => (cur === `rerun-${check.workflowRunId}` ? null : cur));
      }
    },
    [requestRerun, fetchPrs],
  );

  const handleRerunAll = useCallback(
    async (pr: PullRequestSummary, workflowRunIds: number[]) => {
      setPendingKey(`rerun-all-${pr.id}`);
      try {
        const result = await rerunWorkflowRuns(workflowRunIds, (workflowRunId) =>
          requestRerun(pr.repoFullName, workflowRunId),
        );
        if (result.failed === 0) {
          toast.success(`已重新触发 ${result.succeeded} 个失败工作流`);
        } else {
          toast.error(`已触发 ${result.succeeded} 个工作流，另有 ${result.failed} 个重试失败`);
        }
        await fetchPrs({ silent: true });
      } finally {
        setPendingKey((cur) => (cur === `rerun-all-${pr.id}` ? null : cur));
      }
    },
    [requestRerun, fetchPrs],
  );

  // Recomputed from the live `prs` list rather than stored in state, so a
  // repo with no open PRs right now simply has no tab — no separate sync
  // effect needed. If the previously-selected project's tab disappears
  // (its last PR closed, or it dropped out of a slow-arriving fetch),
  // filtering falls back to "全部" on its own without resetting the stored
  // selection, so the tab reappears pre-selected if the PR comes back.
  const { projectCounts, projects, activeProject, visiblePrs, displayPrs, repoDisplayNames } = useMemo(() => {
    // Locally merged PRs stay hidden even if GitHub's search index (which
    // the open-PR list is built on) briefly keeps returning them.
    const list = prs?.filter((pr) => !mergedPrIds.has(pr.id)) ?? null;
    const counts = new Map<string, number>();
    for (const pr of list ?? []) {
      counts.set(pr.repoFullName, (counts.get(pr.repoFullName) ?? 0) + 1);
    }
    const sortedProjects = [...counts.keys()].sort();
    const active = counts.has(selectedProject) ? selectedProject : ALL_PROJECTS;
    const visible = list?.filter((pr) => active === ALL_PROJECTS || pr.repoFullName === active) ?? null;

    // A GitHub App installation can span multiple owners, so two watched
    // repos can share a short name (e.g. "org-a/site" and "org-b/site").
    // Only collapse to the short name when it's unambiguous among the
    // repos currently in view; otherwise keep the full "owner/repo" so
    // PRs from different owners stay visually distinguishable.
    const shortNameCounts = new Map<string, number>();
    for (const fullName of sortedProjects) {
      const short = repoShortName(fullName);
      shortNameCounts.set(short, (shortNameCounts.get(short) ?? 0) + 1);
    }
    const displayNames = new Map<string, string>();
    for (const fullName of sortedProjects) {
      const short = repoShortName(fullName);
      displayNames.set(fullName, shortNameCounts.get(short) === 1 ? short : fullName);
    }

    return { projectCounts: counts, projects: sortedProjects, activeProject: active, visiblePrs: visible, displayPrs: list, repoDisplayNames: displayNames };
  }, [prs, selectedProject, mergedPrIds]);

  if (!hasInstallation) {
    return (
      <main className="flex flex-1 items-center justify-center p-6">
        <Card className="max-w-lg">
          <CardHeader><h2 className="text-xl font-semibold">先安装 GitHub App</h2></CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            <p>安装后选择要查看的仓库，PRboard 只会读取你授权的个人仓库。</p>
            <a href="/api/install/github" className={buttonVariants({ size: "lg" })}>安装 GitHub App</a>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            {prs === null ? "加载中…" : `${displayPrs?.length ?? 0} 个待处理 PR`}
          </h2>
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={`size-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-400"}`} />
            {live ? "实时" : "轮询中"}
          </span>
          {staleCapturedAt && (
            <span
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
              title={`GitHub 连接失败，当前显示的是 ${new Date(staleCapturedAt).toLocaleString()} 抓取的快照`}
            >
              <History className="size-3" />
              快照
            </span>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => fetchPrs()} disabled={refreshing}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} />
          刷新
        </Button>
      </div>

      {!online && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
            <WifiOff className="size-4 flex-none" />
            网络已断开——显示的是最近一次加载的数据，恢复连接后会自动刷新。
          </CardContent>
        </Card>
      )}

      {projects.length > 1 && (
        <Tabs value={activeProject} onValueChange={setSelectedProject}>
          <TabsList
            draggable={false}
            className="max-w-full justify-start gap-1 overflow-x-auto rounded-xl border bg-muted/60 p-1 shadow-inner select-none group-data-horizontal/tabs:h-11 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden dark:bg-muted/40"
          >
            <TabsTrigger
              value={ALL_PROJECTS}
              draggable={false}
              className="group/project-tab h-9 flex-none rounded-lg px-3 py-1.5 select-none transition-[color,background-color,border-color,box-shadow] duration-200 hover:bg-background/60 data-active:border-border/70 data-active:bg-background data-active:shadow-sm dark:data-active:bg-background/80"
            >
              <LayoutGrid data-icon="inline-start" />
              全部
              <span className="min-w-5 rounded-full bg-background/80 px-1.5 py-0.5 text-center text-[11px] leading-none tabular-nums shadow-xs transition-colors group-data-active/project-tab:bg-primary group-data-active/project-tab:text-primary-foreground dark:bg-background/40">
                {displayPrs?.length ?? 0}
              </span>
            </TabsTrigger>
            {projects.map((project) => (
              <TabsTrigger
                key={project}
                value={project}
                title={project}
                draggable={false}
                className="group/project-tab h-9 flex-none rounded-lg px-3 py-1.5 select-none transition-[color,background-color,border-color,box-shadow] duration-200 hover:bg-background/60 data-active:border-border/70 data-active:bg-background data-active:shadow-sm dark:data-active:bg-background/80"
              >
                <FolderGit2 data-icon="inline-start" />
                {repoDisplayNames.get(project)}
                <span className="min-w-5 rounded-full bg-background/80 px-1.5 py-0.5 text-center text-[11px] leading-none tabular-nums shadow-xs transition-colors group-data-active/project-tab:bg-primary group-data-active/project-tab:text-primary-foreground dark:bg-background/40">
                  {projectCounts.get(project)}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      )}

      {error && (
        <Card className="border-destructive/50">
          <CardContent className="flex items-center justify-between gap-3 text-sm text-destructive">
            <span className="min-w-0 break-words">加载失败：{error}</span>
            <Button size="sm" variant="outline" className="flex-none" onClick={() => fetchPrs()} disabled={refreshing}>
              <RotateCcw className="size-3.5" />
              重试
            </Button>
          </CardContent>
        </Card>
      )}

      {displayPrs !== null && displayPrs.length === 0 && !error && (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            没有打开中的 PR。已监控的仓库列表来自 GitHub App 的安装范围，去仓库设置里增减安装的仓库会自动同步。
          </CardContent>
        </Card>
      )}

      {prs === null && !error && (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 4 }, (_, i) => (
            <PrCardSkeleton key={i} />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        {visiblePrs?.map((pr) => (
          <PrCard
            key={pr.id}
            pr={pr}
            repoDisplayName={repoDisplayNames.get(pr.repoFullName) ?? pr.repoFullName}
            isReady={readyPrs.has(pr.id)}
            pendingKey={pendingKey}
            poppingCheckIds={poppingChecks}
            shakingCheckIds={shakingChecks}
            onMergeRequest={setMergeTarget}
            onRerun={handleRerun}
            onRerunAll={handleRerunAll}
            onReadyGlowEnd={handleReadyGlowEnd}
            onFlourishEnd={handleFlourishEnd}
          />
        ))}
      </div>

      <Dialog open={mergeTarget !== null} onOpenChange={(open) => !open && !pendingKey?.startsWith("merge-") && setMergeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认合并</DialogTitle>
            <DialogDescription>
              {mergeTarget && (
                <>
                  即将合并 <strong>{mergeTarget.repoFullName}#{mergeTarget.number}</strong>「{mergeTarget.title}」，此操作不可撤销。
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMergeTarget(null)}
              disabled={pendingKey === `merge-${mergeTarget?.id}`}
            >
              取消
            </Button>
            <Button onClick={confirmMerge} disabled={pendingKey === `merge-${mergeTarget?.id}`}>
              {pendingKey === `merge-${mergeTarget?.id}` ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" />
                  合并中…
                </>
              ) : (
                "确认合并"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
