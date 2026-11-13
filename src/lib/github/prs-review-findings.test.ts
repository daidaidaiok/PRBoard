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

  it("appends latestReviews bodies only while they still request changes", () => {
    const node = {
      reviewThreads: { nodes: [thread("T1", false, "cursor[bot]", "bug")] },
      // 键名必须与 GraphQL 响应一致：latestReviews（上一轮 mock 成 reviews 曾假绿）
      latestReviews: { nodes: [{ id: "R1", author: { login: "bob" }, body: "please split the PR", state: "CHANGES_REQUESTED" }] },
    };
    expect(buildReviewFindings(node)).toEqual([
      { id: "T1", author: "cursor[bot]", body: "bug" },
      { id: "R1", author: "bob", body: "please split the PR" },
    ]);
  });

  it("keeps every reviewer whose latest review still requests changes", () => {
    // last: 10 取每个 reviewer 的最新决策，两人都要求修改时都要列出
    const node = {
      reviewThreads: { nodes: [] },
      latestReviews: {
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

  it("drops the old changes-requested review once the reviewer later approves", () => {
    // reviewer 后来 approve 了，早先的「please fix」不能继续挂成待修复
    const node = {
      reviewThreads: { nodes: [] },
      latestReviews: { nodes: [{ id: "R1", author: { login: "bob" }, body: "please fix", state: "APPROVED" }] },
    };
    expect(buildReviewFindings(node)).toEqual([]);
  });

  it("tolerates empty threads and ghost authors", () => {
    const node = {
      // author=null 模拟 ghost/删号：helper 生成空 thread，应整条跳过
      reviewThreads: { nodes: [thread("T1", false, null, "orphan"), thread("T2", false, "alice", "")] },
      latestReviews: { nodes: [{ id: "R2", author: null, body: "ghost review", state: "CHANGES_REQUESTED" }] },
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
});
