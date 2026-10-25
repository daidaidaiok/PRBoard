import { describe, expect, it, afterEach } from "vitest";
import { GET } from "./route";

const ORIGINAL_ENV = { ...process.env };

describe("GET /api/health", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns 200 with status ok and runtime metadata", async () => {
    const response = await GET();
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(typeof data.timestamp).toBe("string");
  });

  it("reports the deployed sha from SOURCE_COMMIT (Coolify injects this)", async () => {
    process.env.SOURCE_COMMIT = "abc1234def";
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GIT_COMMIT_SHA;

    const data = await (await GET()).json();
    expect(data.sha).toBe("abc1234def");
  });

  it("prefers VERCEL_GIT_COMMIT_SHA over the other injection variables", async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = "vercelsha";
    process.env.GIT_COMMIT_SHA = "gitsha";
    process.env.SOURCE_COMMIT = "sourcesha";

    const data = await (await GET()).json();
    expect(data.sha).toBe("vercelsha");
  });

  it("falls back to sha=unknown when no deploy platform variable is set", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.GIT_COMMIT_SHA;
    delete process.env.SOURCE_COMMIT;

    const data = await (await GET()).json();
    expect(data.sha).toBe("unknown");
  });
});
