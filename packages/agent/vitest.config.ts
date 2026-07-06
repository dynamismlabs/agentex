import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    include: ["tests/**/*.test.ts"],
    // The packaging tests (tests/packaging/*) assert against the built `dist/`;
    // globalSetup builds it once (mtime-guarded) before any test file runs.
    globalSetup: ["tests/packaging/global-setup.ts"],
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
