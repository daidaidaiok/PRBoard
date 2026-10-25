import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { maskBarkUrl, parseBarkUrl, sendBarkNotification } from "./bark";

const BARK_URL = "https://bark-worker.example.workers.dev/device-key";

describe("parseBarkUrl", () => {
  it("accepts an https URL and strips a trailing slash", () => {
    expect(parseBarkUrl("https://api.day.app/abc123/")).toBe("https://api.day.app/abc123");
  });

  it("accepts http for self-hosted bark servers", () => {
    expect(parseBarkUrl("http://192.168.1.5:8080/key")).toBe("http://192.168.1.5:8080/key");
  });

  it("rejects non-http(s) protocols and malformed URLs", () => {
    expect(parseBarkUrl("ftp://api.day.app/abc")).toBeNull();
    expect(parseBarkUrl("not a url")).toBeNull();
    expect(parseBarkUrl("")).toBeNull();
  });
});

describe("maskBarkUrl", () => {
  it("keeps the origin and only the last 4 chars of the key", () => {
    expect(maskBarkUrl("https://api.day.app/abcdef123456")).toBe("https://api.day.app/…3456");
  });

  it("returns null for malformed stored values", () => {
    expect(maskBarkUrl("not a url")).toBeNull();
  });
});

describe("sendBarkNotification", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => "" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the body as a path segment with slashes preserved, plus query params", async () => {
    await sendBarkNotification(BARK_URL, { title: "CI 全绿", body: "owner/repo #12 fix" });

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    // Decoding proves '/' stayed a literal path separator (not %2F) while the
    // rest of the body round-trips — see sendBarkNotification's comment.
    expect(decodeURIComponent(calledUrl.pathname)).toBe("/device-key/owner/repo #12 fix");
    expect(calledUrl.searchParams.get("title")).toBe("CI 全绿");
    expect(calledUrl.searchParams.get("group")).toBe("prboard-ci");
    expect(calledUrl.searchParams.get("level")).toBe("active");
  });

  it("honors the level and url fields and a custom group", async () => {
    await sendBarkNotification(
      BARK_URL,
      { title: "t", body: "b", level: "timeSensitive", url: "https://github.com/x" },
      { group: "prboard-test" },
    );

    const calledUrl = new URL(fetchMock.mock.calls[0][0]);
    expect(calledUrl.searchParams.get("level")).toBe("timeSensitive");
    expect(calledUrl.searchParams.get("url")).toBe("https://github.com/x");
    expect(calledUrl.searchParams.get("group")).toBe("prboard-test");
  });

  it("returns ok:true on a 2xx from the bark server", async () => {
    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("returns ok:false with the status on a non-2xx and logs without the URL", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });

    expect(result).toEqual({ ok: false, status: 404 });
    expect(errorSpy.mock.calls.flat().join("\n")).not.toContain("device-key");
    errorSpy.mockRestore();
  });

  it("returns ok:false when fetch throws", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sendBarkNotification(BARK_URL, { title: "t", body: "b" });

    expect(result.ok).toBe(false);
    errorSpy.mockRestore();
  });
});
