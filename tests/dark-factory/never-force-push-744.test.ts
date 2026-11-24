import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * #744 task 4.
 *
 * The issue rules the obvious repair OUT: "Force-pushing is the wrong repair - it would discard the
 * earlier commit, and the earlier commit may be the only record of an approved plan's
 * implementation." So the fix must arrive by descendant commits, never by overwriting the branch,
 * and that constraint is worth pinning because a force-push would silently delete the very work a
 * re-run exists to continue.
 *
 * This is a REGRESSION guard, not a RED: it passes today because no force-push exists yet. It fails
 * the moment one is added - which is exactly when someone would be tempted, to make a rejected push
 * go away.
 */
const PUSH = readFileSync("agent/lib/dark-factory/git-push.ts", "utf8");

describe("the push never overwrites the branch (#744 task 4)", () => {
  it("does not force-push the run branch", () => {
    expect(PUSH).not.toContain("--force");
    expect(PUSH).not.toContain("force-with-lease");
  });

  // The control: it must still be a file that pushes at all, or the guard above passes vacuously.
  it("still pushes, so the guard reads the right file", () => {
    expect(PUSH).toContain("push");
  });
});
