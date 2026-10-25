import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getNotificationSettings, requireSession, sendBarkNotification } = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  requireSession: vi.fn(),
  sendBarkNotification: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/notification-settings", () => ({ getNotificationSettings }));
// Only the network side effect is mocked — parseBarkUrl validation stays real,
// since "先测试再保存" depends on it.
vi.mock("@/lib/bark", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/bark")>()),
  sendBarkNotification,
}));

import { POST } from "./route";

function postRequest(body?: unknown) {
  return new NextRequest("http://localhost/api/settings/notifications/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("POST /api/settings/notifications/test", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 42 } });
    getNotificationSettings.mockResolvedValue({
      barkUrl: null,
      notifyCiGreen: true,
      notifyRetryExhausted: true,
      notifyPrConflict: true,
      notifyDeployFailed: true,
    });
    sendBarkNotification.mockResolvedValue({ ok: true, status: 200 });
  });

  it("rejects an unauthenticated request", async () => {
    requireSession.mockResolvedValue(null);

    const response = await POST(postRequest({}));

    expect(response.status).toBe(401);
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("rejects a test with no bark url in the body and none saved", async () => {
    const response = await POST(postRequest({}));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "no barkUrl configured" });
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it.each(["not a url", "ftp://x/y/k"])("rejects a malformed body barkUrl before any push (%s)", async (badUrl) => {
    const response = await POST(postRequest({ barkUrl: badUrl }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid barkUrl" });
    expect(sendBarkNotification).not.toHaveBeenCalled();
  });

  it("pushes to the saved url (also when the body is not json) under the prboard-test group", async () => {
    getNotificationSettings.mockResolvedValue({
      barkUrl: "https://api.day.app/storedkey",
      notifyCiGreen: true,
      notifyRetryExhausted: true,
      notifyPrConflict: true,
      notifyDeployFailed: true,
    });

    const response = await POST(postRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, status: 200 });
    expect(getNotificationSettings).toHaveBeenCalledWith(42);
    expect(sendBarkNotification).toHaveBeenCalledWith(
      "https://api.day.app/storedkey",
      { title: "PRboard 测试推送", body: "设置页测试推送 · 收到即链路畅通", level: "active" },
      { group: "prboard-test" },
    );
  });

  it("prefers an unsaved body url over the stored one (test-before-save)", async () => {
    getNotificationSettings.mockResolvedValue({
      barkUrl: "https://api.day.app/storedkey",
      notifyCiGreen: true,
      notifyRetryExhausted: true,
      notifyPrConflict: true,
      notifyDeployFailed: true,
    });

    const response = await POST(postRequest({ barkUrl: "https://selfhosted.lan:8080/newkey/" }));

    expect(response.status).toBe(200);
    expect(getNotificationSettings).not.toHaveBeenCalled();
    expect(sendBarkNotification.mock.calls[0][0]).toBe("https://selfhosted.lan:8080/newkey");
    expect(sendBarkNotification.mock.calls[0][2]).toEqual({ group: "prboard-test" });
  });
});
