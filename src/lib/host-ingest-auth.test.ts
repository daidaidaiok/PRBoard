import { describe, expect, it } from "vitest";
import { hashIngestToken, matchesIngestToken, newIngestToken } from "./host-ingest-auth";

describe("host ingest tokens", () => {
  it("creates a high-entropy token and persists only a deterministic digest", () => {
    const token = newIngestToken();

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashIngestToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashIngestToken(token)).toBe(hashIngestToken(token));
  });

  it("uses a constant-shape comparison and rejects malformed or different tokens", () => {
    const digest = hashIngestToken("a".repeat(43));

    expect(matchesIngestToken("a".repeat(43), digest)).toBe(true);
    expect(matchesIngestToken("b".repeat(43), digest)).toBe(false);
    expect(matchesIngestToken("a".repeat(43), "bad-digest")).toBe(false);
  });
});
