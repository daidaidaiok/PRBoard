import { describe, expect, it, vi } from "vitest";

// dashboard-snapshot.ts imports ./index (the drizzle client), which throws
// without a live DATABASE_URL — irrelevant to the pure function this file
// tests, so it's mocked away rather than actually connecting.
vi.mock("./index", () => ({ db: {} }));

import { parseSnapshotPayload } from "./dashboard-snapshot";

const validPr = {
  id: "PR_1",
  number: 7,
  title: "feat: something",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T01:00:00Z",
  author: { login: "daidaidaiok", avatarUrl: "https://avatars.githubusercontent.com/u/1" },
  repoFullName: "o/r",
  installationId: 1,
  headRefName: "feat/x",
  baseRefName: "staging",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  rollupState: "success",
  checks: [],
};

describe("parseSnapshotPayload", () => {
  it("accepts a well-formed v1 payload", () => {
    const payload = { version: 1, prs: [validPr] };
    expect(parseSnapshotPayload(payload)).toEqual([validPr]);
  });

  it("accepts an empty prs array", () => {
    expect(parseSnapshotPayload({ version: 1, prs: [] })).toEqual([]);
  });

  it("rejects a payload from a different version", () => {
    expect(parseSnapshotPayload({ version: 2, prs: [validPr] })).toBeNull();
    expect(parseSnapshotPayload({ prs: [validPr] })).toBeNull();
  });

  it("rejects non-object and missing-array payloads", () => {
    expect(parseSnapshotPayload(null)).toBeNull();
    expect(parseSnapshotPayload("nope")).toBeNull();
    expect(parseSnapshotPayload({ version: 1 })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, prs: "all" })).toBeNull();
  });

  it("rejects when any pr lacks the minimal shape", () => {
    expect(parseSnapshotPayload({ version: 1, prs: [{ ...validPr, id: 1 }] })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, prs: [{ ...validPr, number: "7" }] })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, prs: [{ ...validPr, checks: null }] })).toBeNull();
    expect(parseSnapshotPayload({ version: 1, prs: [validPr, null] })).toBeNull();
  });
});
