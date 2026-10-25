import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { hasSameOrigin, repoFullNamePattern } from "./request-security";

describe("request security helpers", () => {
  it("rejects cross-origin and cross-site mutation requests", () => {
    expect(hasSameOrigin(new NextRequest("https://app.example/api", { headers: { origin: "https://evil.example" } }))).toBe(false);
    expect(hasSameOrigin(new NextRequest("https://app.example/api", { headers: { "sec-fetch-site": "cross-site" } }))).toBe(false);
  });

  it("accepts same-origin or non-browser requests", () => {
    expect(hasSameOrigin(new NextRequest("https://app.example/api", { headers: { origin: "https://app.example" } }))).toBe(true);
    expect(hasSameOrigin(new NextRequest("https://app.example/api"))).toBe(true);
  });

  it("accepts browser origin when forwarded host/proto identify the public site", () => {
    // Behind a reverse proxy, `next start` builds the request URL from
    // localhost, so req.nextUrl.origin is NOT the public origin. The proxy
    // headers carry the truth.
    const req = new NextRequest("https://localhost:3000/api/prs/merge", {
      headers: {
        origin: "https://pr.example.com",
        "x-forwarded-host": "pr.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("handles chained-proxy comma-separated forwarded headers", () => {
    const req = new NextRequest("http://localhost:3000/api/prs/merge", {
      headers: {
        origin: "https://pr.example.com",
        "x-forwarded-host": "pr.example.com, proxy.internal",
        "x-forwarded-proto": "https,http",
      },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("still rejects cross-origin even when forwarded headers are present", () => {
    const req = new NextRequest("https://localhost:3000/api/prs/merge", {
      headers: {
        origin: "https://evil.example",
        "x-forwarded-host": "pr.example.com",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasSameOrigin(req)).toBe(false);
  });

  it("normalizes explicit default port and letter case in forwarded host", () => {
    const req = new NextRequest("http://localhost:3000/api/prs/merge", {
      headers: {
        origin: "https://pr.example.com",
        "x-forwarded-host": "pr.example.com:443",
        "x-forwarded-proto": "https",
      },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("assumes https when a proxy rewrites the host but omits x-forwarded-proto", () => {
    const req = new NextRequest("http://localhost:3000/api/prs/merge", {
      headers: { origin: "https://pr.example.com", "x-forwarded-host": "pr.example.com" },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("falls back to the Host header when no x-forwarded headers exist", () => {
    const req = new NextRequest("http://localhost:3000/api/prs/merge", {
      headers: { origin: "https://pr.example.com", host: "pr.example.com" },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("keeps the request scheme when the client host matches (direct access)", () => {
    expect(hasSameOrigin(new NextRequest("http://localhost:3000/api", { headers: { origin: "http://localhost:3000" } }))).toBe(true);
  });

  it("accepts an uppercase x-forwarded-proto", () => {
    const req = new NextRequest("http://localhost:3000/api/prs/merge", {
      headers: {
        origin: "https://pr.example.com",
        "x-forwarded-host": "pr.example.com",
        "x-forwarded-proto": "HTTPS",
      },
    });
    expect(hasSameOrigin(req)).toBe(true);
  });

  it("treats Origin: null as cross-origin", () => {
    expect(hasSameOrigin(new NextRequest("https://app.example/api", { headers: { origin: "null" } }))).toBe(false);
  });

  it("treats a malformed Origin as cross-origin", () => {
    expect(hasSameOrigin(new NextRequest("https://app.example/api", { headers: { origin: "not-a-url" } }))).toBe(false);
  });

  it("limits repository identifiers to owner/name", () => {
    expect(repoFullNamePattern.test("owner/repo")) .toBe(true);
    expect(repoFullNamePattern.test("owner/repo/extra")).toBe(false);
    expect(repoFullNamePattern.test("owner repo/name")).toBe(false);
    expect(repoFullNamePattern.test(`${"o".repeat(101)}/repo`)).toBe(false);
    expect(repoFullNamePattern.test("owner/repo\n")).toBe(false);
  });
});
