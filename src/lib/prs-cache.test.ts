import { describe, expect, it } from "vitest";
import { loadCachedDashboard, saveCachedDashboard } from "./prs-cache";
import type { PullRequestSummary } from "@/lib/github/prs";

const PR: PullRequestSummary = {
  id: "PR_1",
  number: 7,
  title: "feat: x",
  url: "https://github.com/o/r/pull/7",
  isDraft: false,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T01:00:00Z",
  author: null,
  repoFullName: "o/r",
  installationId: 1,
  headRefName: "a",
  baseRefName: "b",
  mergeable: "MERGEABLE",
  reviewDecision: null,
  rollupState: null,
  checks: [],
};

const LOGIN = "daidaidaiok";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private map = new Map<string, string>();
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

class ThrowingStorage implements Pick<Storage, "getItem" | "setItem"> {
  getItem(): string | null {
    throw new Error("quota");
  }
  setItem(): void {
    throw new Error("quota");
  }
}

describe("prs-cache", () => {
  it("round-trips a saved list for the same login", () => {
    const storage = new MemoryStorage();
    saveCachedDashboard([PR], LOGIN, storage);
    expect(loadCachedDashboard(LOGIN, storage)).toEqual({ prs: [PR] });
  });

  it("never serves a cache written by a different login", () => {
    const storage = new MemoryStorage();
    saveCachedDashboard([PR], "someone-else", storage);
    expect(loadCachedDashboard(LOGIN, storage)).toBeNull();
  });

  it("returns null on an empty cache", () => {
    expect(loadCachedDashboard(LOGIN, new MemoryStorage())).toBeNull();
  });

  it("degrades to null on malformed JSON or a wrong version", () => {
    const broken = new MemoryStorage();
    broken.setItem("prboard:prs-cache", "{not json");
    expect(loadCachedDashboard(LOGIN, broken)).toBeNull();

    const oldVersion = new MemoryStorage();
    oldVersion.setItem(
      "prboard:prs-cache",
      JSON.stringify({ version: 999, login: LOGIN, savedAt: "x", prs: [PR] }),
    );
    expect(loadCachedDashboard(LOGIN, oldVersion)).toBeNull();
  });

  it("degrades to null when a cached pr or check is malformed", () => {
    const storage = new MemoryStorage();
    storage.setItem("prboard:prs-cache", JSON.stringify({ version: 1, login: LOGIN, savedAt: "x", prs: [{ id: "x" }] }));
    expect(loadCachedDashboard(LOGIN, storage)).toBeNull();

    const badCheck = new MemoryStorage();
    badCheck.setItem(
      "prboard:prs-cache",
      JSON.stringify({ version: 1, login: LOGIN, savedAt: "x", prs: [{ ...PR, checks: [null] }] }),
    );
    expect(loadCachedDashboard(LOGIN, badCheck)).toBeNull();
  });

  it("swallows storage errors on both read and write", () => {
    const storage = new ThrowingStorage();
    expect(loadCachedDashboard(LOGIN, storage)).toBeNull();
    expect(() => saveCachedDashboard([PR], LOGIN, storage)).not.toThrow();
  });

  it("returns null off-client when no storage is passed", () => {
    // Node test env: window is undefined — the storage acquisition must
    // degrade to null instead of throwing a ReferenceError.
    expect(loadCachedDashboard(LOGIN)).toBeNull();
    expect(() => saveCachedDashboard([PR], LOGIN)).not.toThrow();
  });
});
