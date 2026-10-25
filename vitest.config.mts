import { fileURLToPath } from "node:url";
import { defineConfig, defaultExclude } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    clearMocks: true,
    // Parallel sessions keep git worktrees under .claude/worktrees — their
    // tests must never be swept into this checkout's run.
    exclude: [...defaultExclude, ".claude/**"],
  },
});
