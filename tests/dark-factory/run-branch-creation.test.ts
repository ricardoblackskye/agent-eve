/**
 * #373 — a local run commits to a TASK BRANCH, not to whatever happens to be checked out.
 *
 * The first run that got all the way through coding found this. The suite PASSED on iteration 1, the plan
 * artifact was written, and then:
 *
 *   [STEP 6] Committing changes to 'feat/dark-factory-163' and pushing to GitHub...
 *   [ERROR] Failed to push branch 'feat/dark-factory-163'
 *   error: src refspec feat/dark-factory-163 does not match any
 *
 * STEP 6 staged and committed and never created the branch, so the commit landed on the checked-out branch
 * (the clone's `main`) and the ref the push names did not exist. The sandbox path is unaffected — it commits
 * inside the sandbox through `commitAndPushFromSandbox` — which is exactly why nothing caught this: the local
 * path had no branch creation and no test could see the difference.
 *
 * A source-order guard, in the style this repo already uses for the runner (an out-of-band script whose call
 * sites are pinned while the behaviour lives in library units): the branch must exist BEFORE the commit, and
 * the push must refuse when HEAD is not that branch, so a future edit cannot silently commit to `main`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNNER = join(process.cwd(), "scripts", "dark-factory-runner.ts");
const source = readFileSync(RUNNER, "utf8");

describe("#373 the local run commits to its own branch", () => {
  it("creates the task branch BEFORE staging and committing", () => {
    const checkoutAt = source.indexOf("git checkout -b ${branchName}");
    const addAt = source.indexOf("git add ${filesToCommit}");
    const commitAt = source.indexOf('git commit -m "feat: #');

    expect(checkoutAt, "no branch creation found").toBeGreaterThan(-1);
    expect(addAt, "no git add found").toBeGreaterThan(-1);
    expect(commitAt, "no git commit found").toBeGreaterThan(-1);

    // The order is the whole point: committing first is what put the work on `main`.
    expect(addAt).toBeGreaterThan(checkoutAt);
    expect(commitAt).toBeGreaterThan(addAt);
  });

  it("refuses to push unless HEAD is the task branch", () => {
    // Without this the failure surfaces as git's "src refspec ... does not match any", which says nothing
    // about the real cause and cost several runs to interpret.
    expect(source).toMatch(/refusing to push/);
    expect(source).toMatch(/rev-parse --abbrev-ref HEAD/);
  });
});
