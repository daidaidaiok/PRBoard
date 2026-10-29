"use client";

import { memo, useEffect, useState } from "react";
import type { CheckItem, PullRequestSummary } from "@/lib/github/prs";
import { AUTO_RETRY_LIMIT, isFailureConclusion } from "@/lib/github/retry-policy";
import { computeCheckProgress, computePrProgress, formatDurationSeconds } from "@/lib/github/progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Progress, ProgressIndicator, ProgressTrack } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  RotateCcw,
  ExternalLink,
  CircleCheck,
  CircleX,
  CircleDashed,
  LoaderCircle,
  GitPullRequestDraft,
  Clock3,
  TriangleAlert,
  GitMerge,
  Maximize2,
  Minimize2,
} from "lucide-react";

function rollupBadge(state: string | null) {
  switch (state) {
    case "success":
      return (
        <Badge className="border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <CircleCheck className="size-3" />
          通过
        </Badge>
      );
    case "failure":
    case "error":
      return (
        <Badge variant="destructive">
          <CircleX className="size-3" />
          失败
        </Badge>
      );
    case "pending":
    case "expected":
      return (
        <Badge className="border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <LoaderCircle className="size-3 animate-spin" />
          进行中
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <CircleDashed className="size-3" />
          无检查
        </Badge>
      );
  }
}

function compactDotClass(state: string | null): string {
  switch (state) {
    case "success":
      return "bg-emerald-600";
    case "failure":
    case "error":
      return "bg-destructive";
    case "pending":
    case "expected":
      return "bg-amber-500";
    default:
      return "bg-zinc-400";
  }
}

export function prCanMerge(pr: PullRequestSummary): boolean {
  return pr.mergeable === "MERGEABLE" && pr.reviewDecision !== "REVIEW_REQUIRED" && pr.reviewDecision !== "CHANGES_REQUESTED";
}

/** A tiny ring that fills in as `percent` climbs — used in place of the generic spinner once a check has an estimated duration to measure progress against. */
function CheckProgressRing({ percent, className }: { percent: number; className?: string }) {
  const radius = 6;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 16 16" className={className} aria-hidden="true">
      <circle cx="8" cy="8" r={radius} strokeWidth="2.5" className="fill-none stroke-current opacity-25" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        strokeWidth="2.5"
        strokeLinecap="round"
        transform="rotate(-90 8 8)"
        className="fill-none stroke-current transition-[stroke-dashoffset] duration-1000 ease-linear"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
      />
    </svg>
  );
}

export function checkStatusMeta(check: CheckItem): {
  colorClass: string;
  shapeClass: string;
  indicator: "dot" | "spinner" | "queue";
  label: string;
} {
  const isDone = check.status === "completed";
  if (check.status === "in_progress") {
    return { colorClass: "text-amber-500", shapeClass: "", indicator: "spinner", label: "运行中" };
  }
  if (check.status === "queued" || check.status === "pending") {
    return { colorClass: "text-amber-500", shapeClass: "", indicator: "queue", label: "排队中" };
  }
  if (check.status === "requested") {
    return { colorClass: "text-amber-500", shapeClass: "", indicator: "queue", label: "等待排队" };
  }
  if (check.status === "waiting") {
    return { colorClass: "text-amber-500", shapeClass: "", indicator: "queue", label: "等待条件" };
  }
  if (check.status === "expected") {
    return { colorClass: "text-amber-500", shapeClass: "", indicator: "queue", label: "等待上报" };
  }
  if (!isDone) return { colorClass: "bg-zinc-400", shapeClass: "rounded-full", indicator: "dot", label: "未知" };
  if (check.conclusion === "success") {
    return { colorClass: "bg-emerald-600", shapeClass: "rounded-full", indicator: "dot", label: "通过" };
  }
  if (check.conclusion === "failure" || check.conclusion === "error")
    return { colorClass: "bg-destructive", shapeClass: "rounded-sm", indicator: "dot", label: "失败" };
  return {
    colorClass: "bg-zinc-400",
    shapeClass: "rounded-full",
    indicator: "dot",
    label: check.conclusion ?? "未知",
  };
}

export interface PrCardProps {
  pr: PullRequestSummary;
  /** Pre-collapsed repo label (shared short-name logic lives in the parent). */
  repoDisplayName: string;
  /** Just became mergeable — drives the one-shot ready glow on card + button. */
  isReady: boolean;
  /** The dashboard's pending-operation key, guarding merge/rerun buttons. */
  pendingKey: string | null;
  /** Check ids playing the one-shot pass/fail flourishes (parent-owned). */
  poppingCheckIds: Set<string>;
  shakingCheckIds: Set<string>;
  onMergeRequest: (pr: PullRequestSummary) => void;
  onRerun: (pr: PullRequestSummary, check: CheckItem) => void;
  onRerunAll: (pr: PullRequestSummary, workflowRunIds: number[]) => void;
  /** Fired when the ready glow's animation ends so the parent can drop the id. */
  onReadyGlowEnd: (prId: string) => void;
  /** Fired when a flourish's animation ends so the parent can drop the id. */
  onFlourishEnd: (checkId: string) => void;
}

/**
 * One PR card. Memoized: the parent re-renders on every fetch and every
 * flourish state change, and each card with a running estimated check ticks
 * its own `now` clock once per second — memo keeps all *other* cards from
 * re-rendering along with it. Props are kept memo-stable on purpose:
 * callbacks must arrive identity-stable and Sets must be the parent's
 * (rarely replaced) state, not freshly built objects.
 */
function PrCardImpl({
  pr,
  repoDisplayName,
  isReady,
  pendingKey,
  poppingCheckIds,
  shakingCheckIds,
  onMergeRequest,
  onRerun,
  onRerunAll,
  onReadyGlowEnd,
  onFlourishEnd,
}: PrCardProps) {
  // Drives the progress bars/rings — each ticking card runs its own clock,
  // so an idle card costs no renders and a card with no estimated running
  // check (or where the estimate rounded to 0s) never arms one.
  const [now, setNow] = useState(() => Date.now());
  // Per-card compact view: a one-line summary instead of the full card. Local
  // state on purpose — it resets on reload and never affects other cards.
  const [compact, setCompact] = useState(false);
  const hasEstimatedCheckRunning = pr.checks.some(
    (check) => check.kind === "check_run" && check.status === "in_progress" && (check.durationEstimate?.seconds ?? 0) > 0,
  );
  useEffect(() => {
    if (!hasEstimatedCheckRunning) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasEstimatedCheckRunning]);

  const failedChecks = pr.checks.filter(
    (check) => check.status === "completed" && isFailureConclusion(check.conclusion),
  );
  const rerunnableFailedChecks = failedChecks.filter((check) => check.canRerun);
  const rerunnableCheckIds = new Set(rerunnableFailedChecks.map((check) => check.id));
  const failedWorkflowRunIds = [
    ...new Set(rerunnableFailedChecks.flatMap((check) => (check.workflowRunId !== null ? [check.workflowRunId] : []))),
  ];
  const canMerge = prCanMerge(pr);
  const hasConflict = pr.mergeable === "CONFLICTING";
  const prProgress = pr.rollupState === "pending" ? computePrProgress(pr.checks, now) : null;
  const mergePending = pendingKey === `merge-${pr.id}`;

  if (compact) {
    return (
      <Card className={isReady ? "motion-safe:animate-ci-ready" : undefined}>
        <div className="flex items-center gap-2 px-3 py-2 text-sm">
          <span
            aria-hidden="true"
            className={`size-2 shrink-0 rounded-full ${compactDotClass(pr.rollupState)}`}
          />
          <a href={pr.url} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium hover:underline">
            #{pr.number} {pr.title}
          </a>
          <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline" title={pr.repoFullName}>
            {repoDisplayName}
          </span>
          <Button size="icon-xs" variant="ghost" aria-label="展开 PR 卡片" title="展开 PR 卡片" onClick={() => setCompact(false)}>
            <Maximize2 />
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className={isReady ? "motion-safe:animate-ci-ready" : undefined}>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span title={pr.repoFullName}>{repoDisplayName}</span>
            {pr.isDraft && (
              <Badge variant="outline" className="text-muted-foreground">
                <GitPullRequestDraft className="size-3" />
                Draft
              </Badge>
            )}
          </div>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-sm font-medium hover:underline"
          >
            #{pr.number} {pr.title}
            <ExternalLink className="size-3 text-muted-foreground" />
          </a>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{pr.headRefName} → {pr.baseRefName}</span>
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 sm:justify-end">
          <Button size="icon-xs" variant="ghost" aria-label="收起为精简视图" title="收起为精简视图" onClick={() => setCompact(true)}>
            <Minimize2 />
          </Button>
          {rollupBadge(pr.rollupState)}
          {hasConflict ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button size="sm" variant="destructive" disabled focusableWhenDisabled>
                    <TriangleAlert className="size-3.5" />
                    解决冲突
                  </Button>
                }
              />
              <TooltipContent>请在 GitHub 或本地解决冲突</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="sm"
              className={isReady ? "motion-safe:animate-ci-ready" : undefined}
              disabled={!canMerge || mergePending}
              onClick={() => onMergeRequest(pr)}
              onAnimationEnd={() => onReadyGlowEnd(pr.id)}
            >
              <GitMerge className="size-3.5" />
              合并
            </Button>
          )}
        </div>
      </CardHeader>
      {prProgress && (
        <CardContent className="flex items-center gap-2 pt-0">
          <Progress value={prProgress.percent} className="flex-1">
            <ProgressTrack>
              <ProgressIndicator />
            </ProgressTrack>
          </Progress>
          <span
            className="text-xs tabular-nums whitespace-nowrap text-muted-foreground"
            title={`预计值来自各 check 最近成功运行的历史(加权中位数,越近权重越高);进度条按各 check 累计工作量推进;剩余时间取当前最慢未完成 check 的预计剩余(按并行执行估计,随运行实时更新;剩余按历史 70 分位起算、有意报高——宁可提示多等,不让进度条顶格干等),± 为该 check 的历史波动`}
          >
            剩 ~{formatDurationSeconds(prProgress.remainingSeconds)}
            {prProgress.remainingSpreadSeconds > 0 && <> ±{formatDurationSeconds(prProgress.remainingSpreadSeconds)}</>}
          </span>
        </CardContent>
      )}
      {pr.checks.length > 0 && (
        <CardContent className="flex flex-wrap items-center gap-2.5 pt-0 pointer-coarse:gap-3.5">
          {pr.checks.map((check) => {
            const meta = checkStatusMeta(check);
            const isRerunnable = rerunnableCheckIds.has(check.id);
            const isRerunPending = pendingKey === `rerun-${check.workflowRunId}` || pendingKey === `rerun-all-${pr.id}`;
            const justPassed = poppingCheckIds.has(check.id);
            const justFailed = shakingCheckIds.has(check.id);
            const checkProgress = computeCheckProgress(check, now);
            const estimateSuffix = checkProgress
              ? ` / ~${formatDurationSeconds(checkProgress.estimatedSeconds)}` +
                (checkProgress.spreadSeconds > 0 ? ` ±${formatDurationSeconds(checkProgress.spreadSeconds)}` : "") +
                ` (n=${checkProgress.sampleCount})`
              : "";
            const statusLabel = checkProgress
              ? `${check.name} · ${meta.label} · ${formatDurationSeconds(checkProgress.elapsedSeconds)}${estimateSuffix}`
              : `${check.name} · ${meta.label}`;
            const statusClassName = [
              "inline-flex size-4 items-center justify-center pointer-coarse:size-6 touch-manipulation transition-[background-color,border-radius,color] duration-500",
              meta.shapeClass,
              meta.colorClass,
              justPassed && "motion-safe:animate-ci-pop",
              justFailed && "motion-safe:animate-ci-shake",
              check.detailsUrl ? "cursor-pointer" : "cursor-default opacity-60",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <div key={check.id} className="flex items-center gap-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <a
                        href={check.detailsUrl ?? undefined}
                        target={check.detailsUrl ? "_blank" : undefined}
                        rel={check.detailsUrl ? "noreferrer" : undefined}
                        tabIndex={check.detailsUrl ? undefined : 0}
                        aria-label={statusLabel}
                        className={statusClassName}
                        onAnimationEnd={() => onFlourishEnd(check.id)}
                      >
                        {meta.indicator === "spinner" &&
                          (checkProgress ? (
                            <CheckProgressRing percent={checkProgress.percent} className="size-full" />
                          ) : (
                            <LoaderCircle className="size-full motion-safe:animate-spin" aria-hidden="true" />
                          ))}
                        {meta.indicator === "queue" && <Clock3 className="size-full" aria-hidden="true" />}
                      </a>
                    }
                  />
                  <TooltipContent>{statusLabel}</TooltipContent>
                </Tooltip>
                {isRerunnable && (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="outline"
                          className="aria-disabled:opacity-50 touch-manipulation"
                          aria-label={`重试 ${check.name}`}
                          disabled={isRerunPending}
                          focusableWhenDisabled
                          onClick={() => onRerun(pr, check)}
                        />
                      }
                    >
                      <RotateCcw />
                    </TooltipTrigger>
                    <TooltipContent>
                      {check.runAttempt !== null && check.runAttempt > AUTO_RETRY_LIMIT
                        ? `已自动重试 ${AUTO_RETRY_LIMIT} 次，仍可手动重试 ${check.name}`
                        : `重试 ${check.name}`}
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            );
          })}
          {failedWorkflowRunIds.length > 1 && (
            <Button
              size="sm"
              variant="outline"
              disabled={pendingKey?.startsWith("rerun-") ?? false}
              onClick={() => onRerunAll(pr, failedWorkflowRunIds)}
            >
              <RotateCcw className="size-3" />
              重试全部失败工作流 ({failedWorkflowRunIds.length})
            </Button>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export const PrCard = memo(PrCardImpl);
