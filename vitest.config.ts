import { defineConfig } from "vitest/config";

/**
 * Workspace-root Vitest config (added in the MAC package refactor, Phase 0).
 *
 * Tests are the safety net the refactor leans on: EventEnvelope normalization,
 * router decisions, and byte-for-byte golden snapshots of agent instructions.
 * They live under each package/app's `test/` dir and move with the code they
 * cover as later phases relocate it.
 */
export default defineConfig({
  test: {
    include: ["apps/**/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
    // Each test imports app/package source that reads env lazily; keep them
    // isolated so module-level singletons (memory store, etc.) don't leak.
    environment: "node",
    globals: false,
  },
});
