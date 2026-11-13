import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

// prs.ts 经 @/db/installations 顶层拉起 db 连接，纯函数测试 mock 掉（与
// dashboard-snapshot.test.ts 同款先例）。
vi.mock("@/db/installations", () => ({ listWatchedRepos: vi.fn() }));
vi.mock("@/db/check-durations", () => ({ getEstimatedDurations: vi.fn() }));

import { buildReviewFindings, type ReviewThreadsResponseNode } from "./prs";

describe("buildReviewFindings", () => {
  const thread = (
    id: string,
    isResolved: boolean,
    author: string | null,
    body: string,
  ): ReviewThreadsResponseNode["reviewThreads"]["nodes"][number] => ({
    id,
    isResolved,
    comments: { nodes: author === null ? [] : [{ author: { login: author }, body }] },
  });

  it("keeps unresolved threads' first comment and drops resolved ones", () => {
    const node = {
      reviewThreads: { nodes: [thread("T1", false, "cursor[bot]", "Merge badge ignores failing CI"), thread("T2", true, "alice", "already fixed")] },
      reviews: { nodes: [] },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "T1", author: "cursor[bot]", body: "Merge badge ignores failing CI" },
    ]);
  });

  it("appends the reviewer's latest opinionated review while it requests changes", () => {
    const node = {
      reviewThreads: { nodes: [thread("T1", false, "cursor[bot]", "bug")] },
      // reviews 连接按时间正序，last:20 取每个 reviewer 的近期历史
      reviews: { nodes: [{ id: "R1", author: { login: "bob" }, body: "please split the PR", state: "CHANGES_REQUESTED" }] },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "T1", author: "cursor[bot]", body: "bug" },
      { id: "R1", author: "bob", body: "please split the PR" },
    ]);
  });

  it("keeps the request alive when a later COMMENTED review follows it", () => {
    // CR 之后 reviewer 又补了一条纯评论（未 approve/dismiss）：意见仍在，body 不能丢
    const node = {
      reviewThreads: { nodes: [] },
      reviews: {
        nodes: [
          { id: "R1", author: { login: "bob" }, body: "please split the PR", state: "CHANGES_REQUESTED" },
          { id: "R2", author: { login: "bob" }, body: "btw here is more detail", state: "COMMENTED" },
        ],
      },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "R1", author: "bob", body: "please split the PR" },
    ]);
  });

  it("keeps every reviewer whose latest opinionated review requests changes", () => {
    // 每个 reviewer 独立判定，两人都要求修改时都要列出
    const node = {
      reviewThreads: { nodes: [] },
      reviews: {
        nodes: [
          { id: "R1", author: { login: "bob" }, body: "split it", state: "CHANGES_REQUESTED" },
          { id: "R2", author: { login: "carol" }, body: "add tests", state: "CHANGES_REQUESTED" },
        ],
      },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "R1", author: "bob", body: "split it" },
      { id: "R2", author: "carol", body: "add tests" },
    ]);
  });

  it("drops the old changes-requested review once the reviewer later approves or dismisses", () => {
    const node = {
      reviewThreads: { nodes: [] },
      reviews: {
        nodes: [
          { id: "R1", author: { login: "bob" }, body: "please fix", state: "CHANGES_REQUESTED" },
          { id: "R2", author: { login: "bob" }, body: "lgtm", state: "APPROVED" },
          { id: "R3", author: { login: "carol" }, body: "withdrawn", state: "DISMISSED" },
        ],
      },
    };
    expect(buildReviewFindings(node)).toEqual([]);
  });

  it("tolerates empty threads and ghost authors", () => {
    const node = {
      // author=null 模拟 ghost/删号：helper 生成空 thread，应整条跳过
      reviewThreads: { nodes: [thread("T1", false, null, "orphan"), thread("T2", false, "alice", "")] },
      reviews: { nodes: [{ id: "R2", author: null, body: "ghost review", state: "CHANGES_REQUESTED" }] },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "T2", author: "alice", body: "" },
      { id: "R2", author: "unknown", body: "ghost review" },
    ]);
  });

  it("returns empty for nodes without the new fields (webhook-shaped payloads)", () => {
    const node = {} as ReviewThreadsResponseNode;
    expect(buildReviewFindings(node)).toEqual([]);
  });

  it("skips a dismissed approval without resurrecting anything beyond the CR", () => {
    // CR → APPROVED 被 dismiss（GitHub 原地改 state 为 DISMISSED）：approval 失效，
    // CR 仍是唯一有效意见（与 reviewDecision 一致）
    const node = {
      reviewThreads: { nodes: [] },
      reviews: {
        nodes: [
          { id: "R1", author: { login: "bob" }, body: "please fix", state: "CHANGES_REQUESTED" },
          { id: "R2", author: { login: "bob" }, body: "lgtm", state: "DISMISSED" },
        ],
      },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "R1", author: "bob", body: "please fix" },
    ]);
  });
});

// GraphQL 查询必须用 states 过滤掉 COMMENTED/PENDING 噪音并给足窗口——否则
// PR 全局一页里仍阻塞的 CR 会被纯评论挤出窗口（Bugbot Medium）。last: 100 是
// GraphQL 单页上限，等于实际全量（Codex P2：多 reviewer 大窗口也要全覆盖）。
describe("QUERY reviews window", () => {
  it("filters to opinionated+dismissed states with the max page size", () => {
    const source = readFileSync("src/lib/github/prs.ts", "utf8");
    expect(source).toContain("reviews(last: 100, states: [CHANGES_REQUESTED, APPROVED, DISMISSED])");
  });
});
