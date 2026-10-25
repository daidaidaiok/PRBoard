import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function newIngestToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function matchesIngestToken(token: string, digest: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(digest)) return false;
  const received = Buffer.from(hashIngestToken(token), "hex");
  const expected = Buffer.from(digest, "hex");
  return received.length === expected.length && timingSafeEqual(received, expected);
}
