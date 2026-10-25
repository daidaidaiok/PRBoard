import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadProviderBudget, claimBudgetAlert, releaseBudgetAlert, getNotificationSettings, sendBarkNotification } = vi.hoisted(() => ({
  loadProviderBudget: vi.fn(),
  claimBudgetAlert: vi.fn(),
  releaseBudgetAlert: vi.fn(),
  getNotificationSettings: vi.fn(),
  sendBarkNotification: vi.fn(),
}));

vi.mock("./ai-review", () => ({ loadProviderBudget, claimBudgetAlert, releaseBudgetAlert }));
vi.mock("./notification-settings", () => ({ getNotificationSettings }));
vi.mock("@/lib/bark", () => ({ sendBarkNotification }));

import { checkBudgetAlert } from "./ai-review-budget-alert";

const now = new Date("2026-10-16T12:00:00.000Z");
const bark = "https://bark.example.com/KEY";

function budget(used: number, limit: number | null = 100) {
  return { name: "GLM", kind: "anthropic-compatible", budgetLimit: limit, budgetUnit: "token", used, quota: null };
}

function subscription(utilization: number, over: Record<string, unknown> = {}) {
  return {
    name: "Claude",
    kind: "claude-oauth",
    budgetLimit: null,
    budgetUnit: null,
    used: 0,
    quota: {
      stopRatio: 0.95,
      windows: [{ type: "five_hour", utilization, resetsAt: new Date("2026-10-16T15:00:00.000Z"), status: "allowed", ...over }],
    },
  };
}

beforeEach(() => {
  loadProviderBudget.mockResolvedValue(budget(0));
  claimBudgetAlert.mockResolvedValue(true);
  getNotificationSettings.mockResolvedValue({ barkUrl: bark });
  sendBarkNotification.mockResolvedValue({ ok: true, status: 200 });
});

describe("checkBudgetAlert for a Claude subscription", () => {
  it("stays silent below the 80% warning line", async () => {
    loadProviderBudget.mockResolvedValue(subscription(0.79));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(claimBudgetAlert).not.toHaveBeenCalled();
  });

  it("warns at 80%, claiming a slot keyed to this window instance (type + reset time) so the next 5h window alerts afresh", async () => {
    loadProviderBudget.mockResolvedValue(subscription(0.82));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("warn-sent");
    expect(claimBudgetAlert).toHaveBeenCalledWith("p1", "five_hour@2026-10-16T15:00:00.000Z", "warn");
    const [, notification] = sendBarkNotification.mock.calls[0];
    expect(notification.title).toContain("Claude");
    expect(notification.body).toContain("5 小时窗口");
    expect(notification.body).toContain("82%");
  });

  it("announces the automatic pause at the stop ratio", async () => {
    loadProviderBudget.mockResolvedValue(subscription(0.96));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("exhausted-sent");
    expect(claimBudgetAlert).toHaveBeenCalledWith("p1", "five_hour@2026-10-16T15:00:00.000Z", "exhausted");
    expect(sendBarkNotification.mock.calls[0][1].body).toContain("暂停");
  });

  it("does not alert on a window that has already reset", async () => {
    loadProviderBudget.mockResolvedValue(subscription(0.99, { resetsAt: new Date("2026-10-16T11:00:00.000Z") }));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
  });

  it("releases the claim when the push fails, same as for budgets", async () => {
    loadProviderBudget.mockResolvedValue(subscription(0.96));
    sendBarkNotification.mockResolvedValue({ ok: false, status: 500 });
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(releaseBudgetAlert).toHaveBeenCalledWith("p1", "five_hour@2026-10-16T15:00:00.000Z", "exhausted");
  });
});

describe("checkBudgetAlert", () => {
  it("stays silent below 90% and does not even try to claim", async () => {
    loadProviderBudget.mockResolvedValue(budget(89));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(claimBudgetAlert).not.toHaveBeenCalled();
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("sends one warning at 90%, claiming the (provider, month, warn) slot first", async () => {
    loadProviderBudget.mockResolvedValue(budget(90));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("warn-sent");
    expect(claimBudgetAlert).toHaveBeenCalledWith("p1", "2026-10", "warn");
    expect(sendBarkNotification).toHaveBeenCalledTimes(1);
    expect(sendBarkNotification).toHaveBeenCalledWith(bark, expect.objectContaining({ title: expect.stringContaining("GLM") }), expect.anything());
  });

  it("releases the claim when the push fails, so the next usage report retries instead of staying silent all month", async () => {
    loadProviderBudget.mockResolvedValue(budget(100));
    sendBarkNotification.mockResolvedValue({ ok: false, status: 500 });
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(releaseBudgetAlert).toHaveBeenCalledWith("p1", "2026-10", "exhausted");
  });

  it("does not push again when the slot was already claimed", async () => {
    loadProviderBudget.mockResolvedValue(budget(95));
    claimBudgetAlert.mockResolvedValue(false);
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("sends the exhausted alert at exactly 100%", async () => {
    loadProviderBudget.mockResolvedValue(budget(100));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("exhausted-sent");
    expect(claimBudgetAlert).toHaveBeenCalledWith("p1", "2026-10", "exhausted");
  });

  it("does not claim when Bark is not configured, so adding Bark later still alerts", async () => {
    loadProviderBudget.mockResolvedValue(budget(100));
    getNotificationSettings.mockResolvedValue({ barkUrl: null });
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    expect(claimBudgetAlert).not.toHaveBeenCalled();
  });

  it("ignores providers without a budget limit or that no longer exist", async () => {
    loadProviderBudget.mockResolvedValue(budget(1e9, null));
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
    loadProviderBudget.mockResolvedValue(null);
    expect(await checkBudgetAlert(7, "p1", now)).toBe("none");
  });
});
