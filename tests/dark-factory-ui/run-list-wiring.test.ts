import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (rel: string) => readFileSync(path.resolve(root, rel), "utf8");

const HOOK_SRC = "app/dark-factory/ui/use-run-query.ts";
const LAYOUT = "app/dark-factory/layout.tsx";
const RUNS_PAGE = "app/dark-factory/runs/page.tsx";

/** Pages that must keep reading through the general hook: none of them is paged. */
const NON_PAGED = [
  "app/dark-factory/page.tsx",
  "app/dark-factory/repos/[owner]/[name]/page.tsx",
  "app/dark-factory/runs/[runId]/page.tsx",
  "app/dark-factory/ui/customer-view.tsx",
];

/** Hooks built on the general one. Migrating these is NOT part of this change. */
const SIBLING_HOOKS = [
  "app/dark-factory/ui/use-cost-budgets.ts",
  "app/dark-factory/ui/use-llm-policy.ts",
  "app/dark-factory/ui/use-tenant-budgets.ts",
  "app/dark-factory/ui/use-tenant-usage.ts",
  "app/dark-factory/ui/use-usage.ts",
];

describe("run list wiring (#748 tasks 2c and 2d)", () => {
  it("provides the query client at the dark factory's client boundary", () => {
    expect(read(LAYOUT)).toMatch(/QueryClientProvider|QueryProvider/);
  });

  it("exposes the paged hook beside the general one", () => {
    expect(read(HOOK_SRC)).toMatch(/export function useRunListQuery/);
  });

  it("uses the paged hook on the run list and nowhere else", () => {
    expect(read(RUNS_PAGE)).toMatch(/useRunListQuery/);
    for (const file of NON_PAGED) {
      expect(read(file)).not.toMatch(/useRunListQuery/);
    }
  });

  it("leaves the general hook in place everywhere that is not the run list", () => {
    for (const file of [...NON_PAGED, ...SIBLING_HOOKS]) {
      expect(read(file)).toMatch(/useRunQuery/);
    }
  });
  it("renders the pages under the provider in the tests as well as the app", () => {
    // The gap this test closes: a page can be correct while its test renders it bare,
    // which the layout assertion cannot see. It failed exactly that way.
    expect(read("tests/dark-factory-ui/runs-page.test.tsx")).toMatch(/renderWithQuery|QueryClientProvider/);
  });
});
