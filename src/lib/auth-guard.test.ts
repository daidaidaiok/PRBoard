import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, getUserByGithubId } = vi.hoisted(() => ({ auth: vi.fn(), getUserByGithubId: vi.fn() }));
vi.mock("@/auth", () => ({ auth }));
vi.mock("@/db/users", () => ({ getUserByGithubId }));

import { requireSession } from "./auth-guard";

describe("requireSession", () => {
  beforeEach(() => {
    auth.mockResolvedValue({ user: { login: "user", githubId: 1 } });
    getUserByGithubId.mockResolvedValue({ id: 7 });
  });

  it("returns an existing session with its database user id", async () => {
    await expect(requireSession()).resolves.toMatchObject({ user: { login: "user", userId: 7 } });
  });

  it("rejects a session when the database user no longer exists", async () => {
    getUserByGithubId.mockResolvedValue(null);
    await expect(requireSession()).resolves.toBeNull();
  });
});
