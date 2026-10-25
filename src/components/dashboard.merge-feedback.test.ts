import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(resolve(process.cwd(), "src/components/dashboard.tsx"), "utf8");
const confirmMergeSection = dashboardSource.slice(
  dashboardSource.indexOf("async function confirmMerge"),
  // requestRerun is a useCallback since the PrCard refactor — slice ends
  // there so the section only covers confirmMerge's own body.
  dashboardSource.indexOf("const requestRerun"),
);
const dialogFooterSection = dashboardSource.slice(
  dashboardSource.indexOf("<DialogFooter"),
  dashboardSource.indexOf("</DialogFooter>"),
);
const prsMemoSection = dashboardSource.slice(
  dashboardSource.indexOf("const { projectCounts"),
  dashboardSource.indexOf("if (!hasInstallation)"),
);

describe("dashboard merge feedback", () => {
  it("tracks locally merged PRs as a terminal set", () => {
    expect(dashboardSource).toContain("const [mergedPrIds, setMergedPrIds] = useState<Set<string>>(new Set());");
    expect(prsMemoSection).toContain("mergedPrIds");
  });

  it("hides a merged PR immediately on success, without waiting for the refetch", () => {
    // 标记终态必须发生在请求成功之后、且先于后台 refetch 触发
    const successMark = confirmMergeSection.indexOf("setMergedPrIds");
    expect(successMark).toBeGreaterThan(confirmMergeSection.indexOf("if (!res.ok) throw"));
    expect(successMark).toBeLessThan(confirmMergeSection.indexOf("fetchPrs"));
    // refetch 后台触发，不阻塞弹窗关闭（不等 search 索引）
    expect(confirmMergeSection).not.toMatch(/await\s+fetchPrs/);
    // 计数与列表统一消费过滤后的派生值：顶部标题、全部 tab 徽标不再直接读 prs
    expect(dashboardSource).toContain("displayPrs?.length ?? 0");
    expect(dashboardSource).not.toContain("prs?.length ?? 0");
    expect(prsMemoSection).toContain("!mergedPrIds.has(pr.id)");
  });

  it("shows a loading state while the merge request is in flight and locks the dialog", () => {
    expect(dialogFooterSection).toContain("animate-spin");
    expect(dialogFooterSection).toContain("合并中…");
    // pending 期间不可取消、不可点外/Esc 关闭
    expect(dialogFooterSection).toMatch(/取消[\s\S]*disabled=/);
    expect(dashboardSource).toMatch(/onOpenChange=\{\(open\) => !open && !pendingKey\?\.startsWith\("merge-"\) && setMergeTarget\(null\)\}/);
  });

  it("clears pendingKey with a guard so concurrent operations don't clobber each other", () => {
    expect(confirmMergeSection).toContain('cur === `merge-${pr.id}`');
  });

  it("applies the same guarded clear to rerun handlers so they can't unlock an in-flight merge", () => {
    expect(dashboardSource).toContain('cur === `rerun-${check.workflowRunId}`');
    expect(dashboardSource).toContain('cur === `rerun-all-${pr.id}`');
  });

  it("shows the empty state based on the filtered list, not the laggy raw list", () => {
    expect(dashboardSource).toContain("displayPrs !== null && displayPrs.length === 0");
    expect(dashboardSource).not.toContain("prs.length === 0");
  });
});
