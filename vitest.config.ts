import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "tests/**/*.spec.ts",
      "tests/**/*.spec.tsx",
    ],
    exclude: ["e2e/**", "node_modules/**"],
    // #332: reset the shared Postgres tables ONCE before any test file starts. Per-file resets race,
    // because test files run in parallel and share these tables.
    globalSetup: ["tests/dark-factory/pg-global-setup.ts"],
  },
});
