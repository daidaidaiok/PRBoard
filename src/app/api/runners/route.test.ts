import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/auth-guard", () => ({ requireSession: vi.fn(async () => ({ user: { userId: 42 } })) }));
vi.mock("@/lib/github/runners", () => ({ listSelfHostedRunners: vi.fn(async () => [{ id: 1, status: "online" }]) }));
import { GET } from "./route";

describe("GET /api/runners", () => {
  it("returns current runner statuses", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runners: [{ id: 1, status: "online" }] });
  });
});
