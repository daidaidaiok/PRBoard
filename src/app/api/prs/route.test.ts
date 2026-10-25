import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const { requireSession, countInstallationsForUser, syncInstallationsForUser, listOpenPullRequests, getDashboardSnapshot, saveDashboardSnapshot } =
  vi.hoisted(() => ({
    requireSession: vi.fn(),
    countInstallationsForUser: vi.fn(),
    syncInstallationsForUser: vi.fn(),
    listOpenPullRequests: vi.fn(),
    getDashboardSnapshot: vi.fn(),
    saveDashboardSnapshot: vi.fn(),
  }));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/installations", () => ({ countInstallationsForUser }));
vi.mock("@/lib/github/sync", () => ({ syncInstallationsForUser }));
vi.mock("@/lib/github/prs", () => ({ listOpenPullRequests }));
vi.mock("@/db/dashboard-snapshot", () => ({ getDashboardSnapshot, saveDashboardSnapshot }));

import { DEFAULT_FETCH_TIMEOUT_MS } from "@/lib/fetch-with-timeout";
import { GET } from "./route";

const PRS = [{ id: "PR_1", number: 1, checks: [] }];
const SNAPSHOT = { prs: PRS, capturedAt: "2026-10-01T00:00:00.000Z" };

describe("GET /api/prs", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 1 } });
    countInstallationsForUser.mockResolvedValue(1);
    saveDashboardSnapshot.mockResolvedValue(undefined);
  });

  it("returns fresh PRs and refreshes the snapshot on success", async () => {
    listOpenPullRequests.mockResolvedValue(PRS);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ prs: PRS, stale: false });
    expect(saveDashboardSnapshot).toHaveBeenCalledWith(1, PRS);
  });

  it("serves the snapshot with stale=true when GitHub fails", async () => {
    listOpenPullRequests.mockRejectedValue(new Error("github down"));
    getDashboardSnapshot.mockResolvedValue(SNAPSHOT);

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ prs: PRS, stale: true, capturedAt: SNAPSHOT.capturedAt });
    expect(saveDashboardSnapshot).not.toHaveBeenCalled();
  });

  it("returns 502 when GitHub fails and no snapshot exists", async () => {
    listOpenPullRequests.mockRejectedValue(new Error("github down"));
    getDashboardSnapshot.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(502);
  });

  it("returns 502 when both GitHub and the snapshot read fail", async () => {
    listOpenPullRequests.mockRejectedValue(new Error("github down"));
    getDashboardSnapshot.mockRejectedValue(new Error("db down"));

    const response = await GET();

    expect(response.status).toBe(502);
  });

  it("still returns fresh PRs when the snapshot save fails", async () => {
    listOpenPullRequests.mockResolvedValue(PRS);
    saveDashboardSnapshot.mockRejectedValue(new Error("db write failed"));

    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ prs: PRS, stale: false });
  });

  it("returns 401 without touching GitHub or the snapshot", async () => {
    requireSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(listOpenPullRequests).not.toHaveBeenCalled();
    expect(getDashboardSnapshot).not.toHaveBeenCalled();
  });

  it("backfills installations once when the user has none, tolerating backfill failure", async () => {
    countInstallationsForUser.mockResolvedValue(0);
    syncInstallationsForUser.mockRejectedValue(new Error("github down"));
    listOpenPullRequests.mockResolvedValue([]);

    const response = await GET();

    expect(syncInstallationsForUser).toHaveBeenCalledWith(1);
    expect(response.status).toBe(200);
  });

  it("tolerates a failed installation count and still serves data", async () => {
    countInstallationsForUser.mockRejectedValue(new Error("db down"));
    listOpenPullRequests.mockResolvedValue([]);

    const response = await GET();

    // Unknown count is treated as 0, so the backfill is attempted and its
    // failure (if any) absorbed — the request must still serve data.
    expect(syncInstallationsForUser).toHaveBeenCalledWith(1);
    expect(response.status).toBe(200);
  });
});

describe("GET /api/prs transient-failure retry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once and serves fresh PRs when the first GitHub attempt fails fast", async () => {
    vi.useFakeTimers();
    listOpenPullRequests.mockRejectedValueOnce(new Error("connection reset")).mockResolvedValueOnce(PRS);

    const pending = GET();
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await pending;
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data).toEqual({ prs: PRS, stale: false });
    expect(listOpenPullRequests).toHaveBeenCalledTimes(2);
    expect(getDashboardSnapshot).not.toHaveBeenCalled();
    expect(saveDashboardSnapshot).toHaveBeenCalledWith(1, PRS);
  });

  it("does not retry a slow failure — the retry would outlive the client's fetch budget", async () => {
    vi.useFakeTimers();
    listOpenPullRequests.mockImplementationOnce(async () => {
      // Simulate a hung request burning the whole client budget before dying.
      vi.setSystemTime(Date.now() + DEFAULT_FETCH_TIMEOUT_MS);
      throw new Error("timeout");
    });
    getDashboardSnapshot.mockResolvedValue(SNAPSHOT);

    const response = await GET();

    // Straight to the snapshot fallback: a second 15s attempt would push the
    // response past DEFAULT_FETCH_TIMEOUT_MS and the browser would abort
    // before either the retry or the fallback could ship.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ prs: PRS, stale: true, capturedAt: SNAPSHOT.capturedAt });
    expect(listOpenPullRequests).toHaveBeenCalledTimes(1);
  });
});
