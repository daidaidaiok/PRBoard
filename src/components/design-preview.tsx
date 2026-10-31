"use client";

import { useState } from "react";
import {
  Activity,
  Bell,
  CheckCircle2,
  FolderGit2,
  GitMerge,
  LayoutGrid,
  Moon,
  RefreshCw,
  Settings2,
  XCircle,
} from "lucide-react";

type NavMode = "dock" | "segment" | "sheet";

const PROJECTS = [
  { id: "all", label: "全部", count: 5 },
  { id: "prboard", label: "PRboard", count: 2 },
  { id: "runner", label: "runner-kit", count: 2 },
  { id: "docs", label: "docs-site", count: 1 },
] as const;

const SAMPLE_PRS = [
  {
    id: "1",
    project: "prboard",
    title: "实时刷新改为 SSE 推送",
    repo: "PRboard",
    number: 128,
    status: "pass" as const,
    checks: "5/5",
  },
  {
    id: "2",
    project: "prboard",
    title: "合并确认弹窗补充仓库名",
    repo: "PRboard",
    number: 131,
    status: "pending" as const,
    checks: "2/4",
  },
  {
    id: "3",
    project: "runner",
    title: "主机容量监控折线图",
    repo: "runner-kit",
    number: 44,
    status: "fail" as const,
    checks: "3/5",
  },
  {
    id: "4",
    project: "runner",
    title: "离线重试退避策略",
    repo: "runner-kit",
    number: 47,
    status: "pass" as const,
    checks: "6/6",
  },
  {
    id: "5",
    project: "docs",
    title: "补充 iPad 安装说明",
    repo: "docs-site",
    number: 19,
    status: "pending" as const,
    checks: "1/3",
  },
];

const NAV_OPTIONS: { id: NavMode; title: string; desc: string }[] = [
  {
    id: "dock",
    title: "底部图标栏",
    desc: "最接近 iPhone / iPad 原生 App，适合一只手操作",
  },
  {
    id: "segment",
    title: "底部分段条",
    desc: "项目不太多时更干净，类似系统设置里的分段控件",
  },
  {
    id: "sheet",
    title: "底部弹出选择",
    desc: "当前项目收成一颗按钮，点开再选，项目很多时更省空间",
  },
];

function StatusPill({ status }: { status: "pass" | "pending" | "fail" }) {
  if (status === "pass") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
        <CheckCircle2 className="size-3" />
        通过
      </span>
    );
  }
  if (status === "fail") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/15 px-2 py-0.5 text-[11px] font-medium text-rose-700 dark:text-rose-300">
        <XCircle className="size-3" />
        失败
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300">
      <RefreshCw className="size-3 animate-spin [animation-duration:2.4s]" />
      进行中
    </span>
  );
}

export function DesignPreview() {
  const [navMode, setNavMode] = useState<NavMode>("dock");
  const [projectId, setProjectId] = useState<string>("all");
  const [sheetOpen, setSheetOpen] = useState(false);

  const activeProject = PROJECTS.find((p) => p.id === projectId) ?? PROJECTS[0];
  const visiblePrs =
    projectId === "all" ? SAMPLE_PRS : SAMPLE_PRS.filter((pr) => pr.project === projectId);

  return (
    <div className="relative min-h-dvh overflow-hidden bg-[#d7e3f4] text-slate-900 dark:bg-[#0b1220] dark:text-slate-50">
      {/* Atmospheric blobs — give the glass something to blur */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-[-10%] h-[42vh] w-[42vh] rounded-full bg-[#7eb6ff]/55 blur-3xl dark:bg-[#1d4ed8]/35"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-16 top-[18%] h-[36vh] w-[36vh] rounded-full bg-[#b7a6ff]/45 blur-3xl dark:bg-[#6366f1]/25"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-[-8%] left-[20%] h-[40vh] w-[40vh] rounded-full bg-[#9ad7c2]/50 blur-3xl dark:bg-[#0f766e]/25"
      />

      <div className="relative mx-auto flex min-h-dvh max-w-lg flex-col px-4 pb-[7.5rem] pt-4 sm:max-w-xl sm:px-5">
        {/* Intro banner */}
        <div className="mb-4 rounded-[22px] border border-white/60 bg-white/35 p-4 shadow-[0_8px_30px_rgba(15,23,42,0.08)] backdrop-blur-[28px] dark:border-white/15 dark:bg-white/[0.08] dark:shadow-[0_8px_30px_rgba(0,0,0,0.35)]">
          <p className="text-[11px] font-medium tracking-[0.14em] text-slate-500 uppercase dark:text-slate-400">
            设计预览 · 不接真实数据
          </p>
          <h1 className="mt-1 text-[22px] font-semibold tracking-tight">PRboard · iOS 毛玻璃方案</h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600 dark:text-slate-300">
            下面是手机/平板感的假界面。项目切换放在底部，你可以先点上方三种形式对比，再告诉我喜欢哪一种。
          </p>

          <div className="mt-3 grid gap-2">
            {NAV_OPTIONS.map((option) => {
              const selected = navMode === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setNavMode(option.id);
                    setSheetOpen(false);
                  }}
                  className={`rounded-2xl border px-3 py-2.5 text-left transition ${
                    selected
                      ? "border-sky-400/70 bg-sky-500/15 shadow-[inset_0_0_0_1px_rgba(56,189,248,0.25)]"
                      : "border-white/40 bg-white/30 hover:bg-white/45 dark:border-white/10 dark:bg-white/5 dark:hover:bg-white/10"
                  }`}
                >
                  <div className="text-[13px] font-semibold">{option.title}</div>
                  <div className="mt-0.5 text-[12px] leading-snug text-slate-600 dark:text-slate-400">
                    {option.desc}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Phone-like stage */}
        <div className="relative flex min-h-[72vh] flex-1 flex-col overflow-hidden rounded-[28px] border border-white/60 bg-white/25 shadow-[0_20px_60px_rgba(15,23,42,0.12)] backdrop-blur-[32px] dark:border-white/15 dark:bg-[#111827]/45 dark:shadow-[0_20px_60px_rgba(0,0,0,0.45)]">
          {/* Top glass bar */}
          <header className="sticky top-0 z-10 flex items-center justify-between border-b border-white/45 bg-white/30 px-4 py-3 backdrop-blur-[28px] dark:border-white/10 dark:bg-white/[0.06]">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-xl bg-sky-500/20 text-[11px] font-bold text-sky-700 dark:text-sky-300">
                PR
              </div>
              <div>
                <div className="text-[15px] font-semibold tracking-tight">PRboard</div>
                <div className="text-[11px] text-slate-500 dark:text-slate-400">实时 · 示例数据</div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 text-slate-500 dark:text-slate-300">
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-white/50 dark:bg-white/10">
                <Moon className="size-3.5" />
              </span>
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-white/50 dark:bg-white/10">
                <Bell className="size-3.5" />
              </span>
              <span className="inline-flex size-8 items-center justify-center rounded-full bg-white/50 dark:bg-white/10">
                <Activity className="size-3.5" />
              </span>
            </div>
          </header>

          <div className="flex items-center justify-between px-4 pt-4">
            <div>
              <div className="text-[13px] text-slate-500 dark:text-slate-400">当前项目</div>
              <div className="text-[18px] font-semibold tracking-tight">{activeProject.label}</div>
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/50 bg-white/45 px-3 py-1.5 text-[12px] font-medium backdrop-blur-md dark:border-white/10 dark:bg-white/10"
            >
              <RefreshCw className="size-3.5" />
              刷新
            </button>
          </div>

          <div className="mt-3 flex flex-1 flex-col gap-3 overflow-y-auto px-4 pb-28">
            {visiblePrs.map((pr) => (
              <article
                key={pr.id}
                className="rounded-[22px] border border-white/55 bg-white/28 p-3.5 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur-[22px] dark:border-white/12 dark:bg-white/[0.07] dark:shadow-none"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[11px] text-slate-500 dark:text-slate-400">
                      {pr.repo} #{pr.number}
                    </div>
                    <h2 className="mt-1 truncate text-[15px] font-semibold tracking-tight">{pr.title}</h2>
                  </div>
                  <StatusPill status={pr.status} />
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-900/8 dark:bg-white/10">
                    <div
                      className={`h-full rounded-full ${
                        pr.status === "pass"
                          ? "w-full bg-emerald-500"
                          : pr.status === "fail"
                            ? "w-3/5 bg-rose-500"
                            : "w-2/5 bg-amber-400"
                      }`}
                    />
                  </div>
                  <span className="ml-3 text-[11px] tabular-nums text-slate-500 dark:text-slate-400">
                    {pr.checks}
                  </span>
                </div>
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    disabled={pr.status !== "pass"}
                    className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-35 dark:bg-white dark:text-slate-900"
                  >
                    <GitMerge className="size-3.5" />
                    合并
                  </button>
                </div>
              </article>
            ))}
          </div>

          {/* Bottom project switcher */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 p-3 pb-4">
            {navMode === "dock" && (
              <nav className="pointer-events-auto mx-auto flex max-w-md items-stretch justify-between gap-1 rounded-[24px] border border-white/65 bg-white/40 px-2 py-2 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] dark:border-white/15 dark:bg-[#0f172a]/55">
                {PROJECTS.map((project) => {
                  const active = project.id === projectId;
                  const Icon = project.id === "all" ? LayoutGrid : FolderGit2;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => setProjectId(project.id)}
                      className={`flex min-w-0 flex-1 flex-col items-center gap-1 rounded-2xl px-1 py-1.5 transition ${
                        active ? "bg-sky-500/18 text-sky-700 dark:text-sky-300" : "text-slate-500 dark:text-slate-400"
                      }`}
                    >
                      <Icon className="size-4" />
                      <span className="max-w-full truncate text-[10px] font-medium">{project.label}</span>
                      <span
                        className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                          active
                            ? "bg-sky-500 text-white"
                            : "bg-slate-900/8 text-slate-600 dark:bg-white/10 dark:text-slate-300"
                        }`}
                      >
                        {project.count}
                      </span>
                    </button>
                  );
                })}
              </nav>
            )}

            {navMode === "segment" && (
              <nav className="pointer-events-auto mx-auto flex max-w-md gap-1 overflow-x-auto rounded-full border border-white/65 bg-white/40 p-1 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] [scrollbar-width:none] dark:border-white/15 dark:bg-[#0f172a]/55 [&::-webkit-scrollbar]:hidden">
                {PROJECTS.map((project) => {
                  const active = project.id === projectId;
                  return (
                    <button
                      key={project.id}
                      type="button"
                      onClick={() => setProjectId(project.id)}
                      className={`flex flex-none items-center gap-1.5 rounded-full px-3 py-2 text-[12px] font-medium transition ${
                        active
                          ? "bg-slate-900 text-white dark:bg-white dark:text-slate-900"
                          : "text-slate-600 hover:bg-white/50 dark:text-slate-300 dark:hover:bg-white/10"
                      }`}
                    >
                      {project.label}
                      <span
                        className={`rounded-full px-1.5 text-[10px] tabular-nums ${
                          active
                            ? "bg-white/20 dark:bg-slate-900/10"
                            : "bg-slate-900/8 dark:bg-white/10"
                        }`}
                      >
                        {project.count}
                      </span>
                    </button>
                  );
                })}
              </nav>
            )}

            {navMode === "sheet" && (
              <div className="pointer-events-auto mx-auto max-w-md">
                {sheetOpen && (
                  <div className="mb-2 overflow-hidden rounded-[22px] border border-white/65 bg-white/45 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] dark:border-white/15 dark:bg-[#0f172a]/65">
                    {PROJECTS.map((project) => {
                      const active = project.id === projectId;
                      return (
                        <button
                          key={project.id}
                          type="button"
                          onClick={() => {
                            setProjectId(project.id);
                            setSheetOpen(false);
                          }}
                          className={`flex w-full items-center justify-between border-b border-slate-900/5 px-4 py-3 text-left last:border-b-0 dark:border-white/5 ${
                            active ? "bg-sky-500/12" : ""
                          }`}
                        >
                          <span className="text-[14px] font-medium">{project.label}</span>
                          <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[11px] tabular-nums dark:bg-white/10">
                            {project.count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setSheetOpen((open) => !open)}
                  className="flex w-full items-center justify-between rounded-[22px] border border-white/65 bg-white/40 px-4 py-3 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] dark:border-white/15 dark:bg-[#0f172a]/55"
                >
                  <span className="flex items-center gap-2 text-[14px] font-semibold">
                    <FolderGit2 className="size-4 text-sky-600 dark:text-sky-300" />
                    {activeProject.label}
                  </span>
                  <span className="inline-flex items-center gap-1 text-[12px] text-slate-500 dark:text-slate-400">
                    <Settings2 className="size-3.5" />
                    {sheetOpen ? "收起" : "切换项目"}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        <p className="mt-4 mb-2 text-center text-[12px] leading-relaxed text-slate-600 dark:text-slate-400">
          这是视觉草案页。确认喜欢哪种底部切换后，我再把它接到真正的看板里。
        </p>
      </div>
    </div>
  );
}
