import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const driver = readFileSync(
  new URL("../../agent/lib/dark-factory/opensandbox-driver.ts", import.meta.url),
  "utf8",
);

describe("#742 a declared gate runs from the checkout root", () => {
  it("sets the working directory explicitly rather than inheriting the session's", () => {
    // The bug: the sandbox session's cwd decided where the gate ran, so ESLint resolved its
    // configuration from a subdirectory (/workspace/__mocks__) and found none.
    expect(driver).toMatch(/cwd:\s*[A-Za-z_$]/);
  });

  it("pins the checkout root as the working directory for every workspace command", () => {
    // A session `cd` must not be able to move a gate: the root is a constant, not a mutable default.
    expect(driver).toMatch(/WORKSPACE_ROOT|workspaceRoot|CHECKOUT_ROOT/);
  });
});
