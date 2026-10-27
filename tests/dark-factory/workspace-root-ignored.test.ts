/**
 * #501 - the launcher's default workspace root must not dirty the repository it runs from.
 *
 * `scripts/dark-factory-local-run.ts` defaults the workspace root to `join(process.cwd(), "df-workspaces")`,
 * which is INSIDE the checkout, so the first successful clone leaves the cloned target as an untracked
 * directory in the agent-eve working tree.
 *
 * The assertion is `git check-ignore`, not a string match on the file: the rule existing and git HONOURING
 * it are different facts, and only the second one keeps a working tree clean.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const WORKSPACE_ROOT = "df-workspaces";

describe("#501 the launcher's default workspace root is ignored", () => {
  it("has a .gitignore rule for it", () => {
    const lines = readFileSync(join(process.cwd(), ".gitignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim());

    expect(lines).toContain(`${WORKSPACE_ROOT}/`);
  });

  it("is actually ignored by git", () => {
    // Exits 1 and throws when the path is NOT ignored, which is the failure this guards against.
    const output = execFileSync("git", ["check-ignore", "-v", WORKSPACE_ROOT], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(output).toContain(WORKSPACE_ROOT);
  });
});
