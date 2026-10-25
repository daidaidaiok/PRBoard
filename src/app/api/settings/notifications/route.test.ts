import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getNotificationSettings, requireSession, upsertNotificationSettings } = vi.hoisted(() => ({
  getNotificationSettings: vi.fn(),
  requireSession: vi.fn(),
  upsertNotificationSettings: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/notification-settings", () => ({ getNotificationSettings, upsertNotificationSettings }));

// @/lib/bark is deliberately NOT mocked — validation (parseBarkUrl) and the
// masking shown to the settings page (maskBarkUrl) are exactly what this
// route promises, so the real implementations run here.
import { GET, PUT } from "./route";

const storedOff = {
  barkUrl: null,
  notifyCiGreen: true,
  notifyRetryExhausted: true,
  notifyPrConflict: true,
  notifyDeployFailed: false,
};

function putRequest(body: unknown) {
  return new NextRequest("http://localhost/api/settings/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/settings/notifications", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 42 } });
    getNotificationSettings.mockResolvedValue({ ...storedOff, barkUrl: "https://api.day.app/abc123" });
  });

  it("returns the masked url, never the raw credential", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({
      barkUrlMasked: "https://api.day.app/…c123",
      hasBarkUrl: true,
      notifyCiGreen: true,
      notifyRetryExhausted: true,
      notifyPrConflict: true,
      notifyDeployFailed: false,
    });
    expect(JSON.stringify(json)).not.toContain("abc123");
    expect(getNotificationSettings).toHaveBeenCalledWith(42);
  });

  it("rejects an unauthenticated request", async () => {
    requireSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(getNotificationSettings).not.toHaveBeenCalled();
  });
});

describe("PUT /api/settings/notifications", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 42 } });
    upsertNotificationSettings.mockResolvedValue({ ...storedOff });
  });

  it("rejects an unauthenticated request before parsing its body", async () => {
    requireSession.mockResolvedValue(null);

    const response = await PUT(putRequest({ notifyCiGreen: false }));

    expect(response.status).toBe(401);
    expect(upsertNotificationSettings).not.toHaveBeenCalled();
  });

  it.each(["not a url", "ftp://x/y/k"])("rejects a non-http(s) or malformed barkUrl with 400 (%s)", async (badUrl) => {
    const response = await PUT(putRequest({ barkUrl: badUrl }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid barkUrl" });
    expect(upsertNotificationSettings).not.toHaveBeenCalled();
  });

  it("normalizes a valid barkUrl (trailing slash stripped) before saving", async () => {
    upsertNotificationSettings.mockResolvedValue({ ...storedOff, barkUrl: "https://api.day.app/abc123" });

    const response = await PUT(putRequest({ barkUrl: "https://api.day.app/abc123/" }));

    expect(response.status).toBe(200);
    expect(upsertNotificationSettings).toHaveBeenCalledWith(42, { barkUrl: "https://api.day.app/abc123" });
    const json = await response.json();
    expect(json.barkUrlMasked).toBe("https://api.day.app/…c123");
    expect(json.hasBarkUrl).toBe(true);
    expect(JSON.stringify(json)).not.toContain("abc123");
  });

  it.each(["", "   "])("clears the bark url on an empty string (%j)", async (emptyUrl) => {
    const response = await PUT(putRequest({ barkUrl: emptyUrl }));

    expect(response.status).toBe(200);
    expect(upsertNotificationSettings).toHaveBeenCalledWith(42, { barkUrl: null });
  });

  it("toggles a switch without touching the stored bark url", async () => {
    const response = await PUT(putRequest({ notifyPrConflict: false }));

    expect(response.status).toBe(200);
    const patch = upsertNotificationSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).toEqual({ notifyPrConflict: false });
    expect(patch).not.toHaveProperty("barkUrl");
  });
});
