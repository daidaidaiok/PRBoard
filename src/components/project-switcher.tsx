"use client";

import { useEffect, useId, useRef } from "react";
import { ChevronUp, FolderGit2, LayoutGrid } from "lucide-react";

export type ProjectSwitcherOption = {
  id: string;
  label: string;
  count: number;
  title?: string;
};

type ProjectSwitcherProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  options: ProjectSwitcherOption[];
  allId: string;
};

export function ProjectSwitcher({
  open,
  onOpenChange,
  value,
  onValueChange,
  options,
  allId,
}: ProjectSwitcherProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const active = options.find((option) => option.id === value) ?? options[0];

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!rootRef.current?.contains(target)) {
        onOpenChange(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onOpenChange]);

  if (options.length <= 1) return null;

  return (
    <div ref={rootRef} className="pointer-events-none fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="pointer-events-auto mx-auto w-full max-w-2xl">
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="选择项目"
            className="mb-2 max-h-[min(50vh,22rem)] overflow-y-auto rounded-[22px] border border-white/55 bg-white/45 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] dark:border-white/15 dark:bg-[#0f172a]/65 dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
          >
            {options.map((option) => {
              const selected = option.id === value;
              const Icon = option.id === allId ? LayoutGrid : FolderGit2;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={option.title ?? option.label}
                  onClick={() => {
                    onValueChange(option.id);
                    onOpenChange(false);
                  }}
                  className={`flex w-full items-center justify-between gap-3 border-b border-slate-900/5 px-4 py-3 text-left last:border-b-0 transition-colors dark:border-white/5 ${
                    selected
                      ? "bg-sky-500/15 text-sky-800 dark:bg-sky-400/15 dark:text-sky-200"
                      : "text-foreground hover:bg-white/40 dark:hover:bg-white/5"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-4 flex-none opacity-70" />
                    <span className="truncate text-[14px] font-medium">{option.label}</span>
                  </span>
                  <span className="rounded-full bg-slate-900/8 px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground dark:bg-white/10">
                    {option.count}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          onClick={() => onOpenChange(!open)}
          className="flex w-full items-center justify-between rounded-[22px] border border-white/60 bg-white/45 px-4 py-3 shadow-[0_12px_40px_rgba(15,23,42,0.16)] backdrop-blur-[30px] dark:border-white/15 dark:bg-[#0f172a]/65 dark:shadow-[0_12px_40px_rgba(0,0,0,0.45)]"
        >
          <span className="flex min-w-0 items-center gap-2">
            {active?.id === allId ? (
              <LayoutGrid className="size-4 flex-none text-sky-600 dark:text-sky-300" />
            ) : (
              <FolderGit2 className="size-4 flex-none text-sky-600 dark:text-sky-300" />
            )}
            <span className="truncate text-[14px] font-semibold tracking-tight">
              {active?.label ?? "项目"}
            </span>
            {active && (
              <span className="rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[11px] tabular-nums text-sky-700 dark:text-sky-300">
                {active.count}
              </span>
            )}
          </span>
          <span className="inline-flex items-center gap-1 text-[12px] text-muted-foreground">
            {open ? "收起" : "切换项目"}
            <ChevronUp className={`size-3.5 transition-transform ${open ? "" : "rotate-180"}`} />
          </span>
        </button>
      </div>
    </div>
  );
}
