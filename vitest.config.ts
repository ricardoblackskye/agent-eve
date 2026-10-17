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
    // #391: unit test coverage. `include` is what makes an UNTESTED file count as 0% instead of
    // being invisible - without it Vitest reports only the files the tests happened to import, which
    // flatters the number. The gate is a ratchet in `scripts/coverage-ratchet.ts`, not `thresholds`:
    // one mechanism, so a failure has exactly one explanation.
    coverage: {
      provider: "v8",
      // json-summary is the machine-readable input the ratchet reads; html and lcov are the human
      // and tool-consumer views.
      reporter: ["text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "coverage",
      // Product code the unit suite is expected to cover. `scripts/` is deliberately NOT measured:
      // it holds operator CLI entry points that unit tests do not drive, and a large pool of 0%
      // files would blunt the metric for changes that actually matter. Widen this list if that
      // changes - it is the one line that decides what the number means.
      include: ["agent/**/*.ts", "app/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "**/*.d.ts",
        "tests/**",
        "e2e/**",
        "**/*.config.*",
      ],
      // Write the report even when tests fail, so a failing run still shows where coverage moved.
      reportOnFailure: true,
    },
  },
});
