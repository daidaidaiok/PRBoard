import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getWebhooks, verifyAndReceive } = vi.hoisted(() => ({ getWebhooks: vi.fn(), verifyAndReceive: vi.fn() }));

vi.mock("@/lib/github/webhooks", () => ({ getWebhooks }));

import { POST } from "./route";

describe("POST /api/webhooks/github", () => {
  beforeEach(() => {
    verifyAndReceive.mockResolvedValue(undefined);
    getWebhooks.mockReturnValue({ verifyAndReceive });
  });

  it("rejects requests missing GitHub delivery headers", async () => {
    const response = await POST(new NextRequest("http://localhost/api/webhooks/github", { method: "POST", body: "{}" }));

    expect(response.status).toBe(400);
    expect(verifyAndReceive).not.toHaveBeenCalled();
  });

  it("returns a generic error when signature verification fails", async () => {
    verifyAndReceive.mockRejectedValue(new Error("signature mismatch"));

    const response = await POST(new NextRequest("http://localhost/api/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-delivery": "delivery-id",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: '{"action":"opened"}',
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "invalid signature or handler error" });
  });
});
