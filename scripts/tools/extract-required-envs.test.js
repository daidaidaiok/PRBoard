import { describe, expect, it } from "vitest";
import { parseRequiredEnvKeys } from "./extract-required-envs.mjs";

const FIXTURE = `# 见 docs/SETUP.md。复制成 .env.local 并填上真实值:
#   cp .env.example .env.local

GITHUB_APP_ID=
AUTH_SECRET=

DATABASE_URL=
DATABASE_URL=
`;

describe("parseRequiredEnvKeys", () => {
  it("extracts keys from KEY= lines, skipping comments and blanks, deduped and sorted", () => {
    expect(parseRequiredEnvKeys(FIXTURE)).toEqual(["AUTH_SECRET", "DATABASE_URL", "GITHUB_APP_ID"]);
  });

  it("returns an empty list for a file with no variable lines", () => {
    expect(parseRequiredEnvKeys("# only comments\n\n")).toEqual([]);
  });
});
