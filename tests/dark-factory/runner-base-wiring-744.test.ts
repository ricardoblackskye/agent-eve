import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * #744 task 3, the wiring guard.
 *
 * Task 2 proved the prepare step honours a base it is GIVEN. It proves nothing about the runner
 * supplying the right one, and a fix inside a function the runner never calls is a defect this
 * repository has already paid for once, with every unit test passing against the wrong function.
 *
 * Paired with tsc and the suite on purpose: a source grep alone can pass while the code is broken.
 */
const RUNNER = readFileSync("scripts/dark-factory-runner.ts", "utf8");

describe("the runner chooses the checkout base (#744 task 3)", () => {
  it("asks selectCheckoutBase rather than deciding the base itself", () => {
    expect(RUNNER).toContain("selectCheckoutBase(");
  });

  it("no longer hardcodes the default as the checkout base", () => {
    expect(RUNNER).not.toContain("args.base ??");
  });

  // The control: were this file to stop preparing the checkout, the guards above would pass vacuously.
  it("still prepares the checkout, so the guard reads the right file", () => {
    expect(RUNNER).toContain("ensureSandboxRepo(");
  });
});
