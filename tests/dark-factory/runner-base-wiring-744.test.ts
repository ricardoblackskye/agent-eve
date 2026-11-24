import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * #744 task 3, the wiring guard.
 *
 * Task 2 proved the prepare step honours a base it is GIVEN. It proves nothing about anything
 * supplying one: the runner call passed no base at all, so the fallback kept the old behaviour and
 * the unit tests stayed green. A fix inside a function nothing calls is a defect this repository
 * has already paid for once, with every unit test passing against the wrong function.
 *
 * Two halves, because the responsibility is split: the RUNNER must name the issue branch, and the
 * PREPARE step must choose the base from it, after its own fetch, with the chooser from task 1.
 *
 * An earlier version of this guard asserted the runner no longer contains the PR base line. That
 * was wrong: that line is the pull request target and must stay. It was found by reading the block,
 * not by matching a pattern, which is why the guard now names both files explicitly.
 *
 * Paired with tsc and the suite on purpose: a source grep alone can pass while the code is broken.
 */
const RUNNER = readFileSync("scripts/dark-factory-runner.ts", "utf8");
const PREPARE = readFileSync("agent/lib/dark-factory/git-push.ts", "utf8");

describe("the checkout base is wired end to end (#744 task 3)", () => {
  it("the runner names the issue branch for the prepare step", () => {
    // Bound to the call site: the file already contains branchName elsewhere, so an unbounded
    // contains() passed vacuously and would have kept passing whatever the wiring did.
    const prepareAt = RUNNER.indexOf("ensureSandboxRepo({");
    expect(prepareAt).toBeGreaterThan(-1);
    expect(RUNNER.slice(prepareAt, prepareAt + 400)).toContain("branchName:");
  });

  it("the prepare step chooses the base with the chooser, after its own fetch", () => {
    expect(PREPARE).toContain("selectCheckoutBase(");
    const fetchAt = PREPARE.indexOf("fetch");
    const chooseAt = PREPARE.indexOf("selectCheckoutBase(");
    expect(fetchAt).toBeGreaterThan(-1);
    expect(chooseAt).toBeGreaterThan(fetchAt);
  });

  // The controls: were either file to stop being the one that does this work, the guards above
  // would pass vacuously. They must be able to fail.
  it("still prepares the checkout, so the guard reads the right runner", () => {
    expect(RUNNER).toContain("ensureSandboxRepo(");
  });

  it("still resets the checkout, so the guard reads the right prepare step", () => {
    expect(PREPARE).toContain("reset");
  });
});
