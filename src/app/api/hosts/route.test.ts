import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMonitorHost, deleteMonitorHost, listMonitorCapacityDomains, requireSession } = vi.hoisted(() => ({
  createMonitorHost: vi.fn(),
  deleteMonitorHost: vi.fn(),
  listMonitorCapacityDomains: vi.fn(),
  requireSession: vi.fn(),
}));

vi.mock("@/lib/auth-guard", () => ({ requireSession }));
vi.mock("@/db/host-monitor", () => ({ createMonitorHost, deleteMonitorHost, listMonitorCapacityDomains }));

import { DELETE, GET, POST } from "./route";

const validHost = {
  displayName: "Windows 主机",
  platform: "windows",
  capacityDomain: "windows-wsl",
  capacityRole: "primary",
  runnerName: "windows-runner",
  runnerCpuReserveMilliCores: 2000,
  runnerMemoryReserveMib: 4096,
};

describe("/api/hosts", () => {
  beforeEach(() => {
    requireSession.mockResolvedValue({ user: { userId: 42 } });
    listMonitorCapacityDomains.mockResolvedValue([{ capacityDomain: "windows-wsl" }]);
    createMonitorHost.mockResolvedValue({ host: { id: "host-1", displayName: "Windows 主机" }, token: "secret" });
    deleteMonitorHost.mockResolvedValue(true);
  });

  it("keeps capacity domains scoped to the authenticated user", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ domains: [{ capacityDomain: "windows-wsl" }] });
    expect(listMonitorCapacityDomains).toHaveBeenCalledWith(42);
  });

  it("rejects an unauthenticated capacity request", async () => {
    requireSession.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(listMonitorCapacityDomains).not.toHaveBeenCalled();
  });

  it("creates a host only for a same-origin authenticated request and returns its one-time token", async () => {
    const response = await POST(new NextRequest("http://localhost/api/hosts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(validHost),
    }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ host: { id: "host-1", displayName: "Windows 主机" }, token: "secret" });
    expect(createMonitorHost).toHaveBeenCalledWith(42, validHost);
  });

  it("rejects cross-origin or malformed host creation", async () => {
    const crossOrigin = await POST(new NextRequest("http://localhost/api/hosts", {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: JSON.stringify(validHost),
    }));
    const malformed = await POST(new NextRequest("http://localhost/api/hosts", {
      method: "POST",
      headers: { Origin: "http://localhost" },
      body: "{}",
    }));

    expect(crossOrigin.status).toBe(403);
    expect(malformed.status).toBe(400);
    expect(createMonitorHost).not.toHaveBeenCalled();
  });

  it("removes only a same-origin host owned by the current user", async () => {
    const response = await DELETE(new NextRequest("http://localhost/api/hosts?hostId=11111111-1111-4111-8111-111111111111", {
      method: "DELETE",
      headers: { Origin: "http://localhost" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(deleteMonitorHost).toHaveBeenCalledWith(42, "11111111-1111-4111-8111-111111111111");
  });
});
