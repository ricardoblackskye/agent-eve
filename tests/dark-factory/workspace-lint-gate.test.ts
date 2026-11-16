/**
 * #659 - what the sandbox may run, and which lint commands a target contributes.
 *
 * Two problems sit here, and both are pinned rather than assumed:
 *
 *  1. The allow-list admits only TEST commands, so the lint command a target declares is refused. It has
 *     to grow - but it is a SECURITY control ("the ONLY test commands either execution backend will
 *     run"), so it grows by NAME, never by wildcard: `npm run <anything>` would make every package
 *     script runnable, including a postinstall that does whatever it likes.
 *  2. The matching rule in both consumers is `command.startsWith(prefix + " ")`, which under that rule
 *     also admits `npm run lint -- --fix`. A CHECK that writes is not a check: it would mutate the tree
 *     behind the coding loop's back, so a writing flag is refused explicitly.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_WORKSPACE_COMMAND_PREFIXES,
  isAllowedWorkspaceCommand,
  resolveLintCommands,
} from "../../agent/lib/dark-factory/developer-agent";

describe("#659 the workspace command allow-list", () => {
  it("still permits every command that was permitted before", () => {
    for (const command of ["npx vitest run", "npm test", "npx tsc --noEmit"]) {
      expect(isAllowedWorkspaceCommand(command)).toBe(true);
    }
  });

  it("permits the lint and typecheck commands a target declares", () => {
    expect(isAllowedWorkspaceCommand("npm run lint")).toBe(true);
    expect(isAllowedWorkspaceCommand("npm run typecheck")).toBe(true);
  });

  it("refuses a package script that is not a check", () => {
    // The whole point of naming commands: this would otherwise be runnable by widening to `npm run`.
    expect(isAllowedWorkspaceCommand("npm run deploy")).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run postinstall")).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run lint:everything")).toBe(false);
  });

  it("refuses a check that would WRITE, because a check must not mutate the tree", () => {
    expect(isAllowedWorkspaceCommand("npm run lint -- --fix")).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run lint --fix")).toBe(false);
    expect(isAllowedWorkspaceCommand("npx prettier --write .")).toBe(false);
  });

  it("refuses anything that is not on the list at all", () => {
    expect(isAllowedWorkspaceCommand("rm -rf /")).toBe(false);
    expect(isAllowedWorkspaceCommand("curl http://example.com")).toBe(false);
  });

  it("keeps the list itself free of wildcards", () => {
    expect(ALLOWED_WORKSPACE_COMMAND_PREFIXES).toContain("npm run lint");
    expect(ALLOWED_WORKSPACE_COMMAND_PREFIXES.some((p) => p.includes("*"))).toBe(false);
    // A bare `npm run` entry would admit every package script there is.
    expect(ALLOWED_WORKSPACE_COMMAND_PREFIXES).not.toContain("npm run");
  });
});

describe("#659 resolving a target's lint commands", () => {
  it("resolves the checks the target declares, and nothing else", () => {
    expect(
      resolveLintCommands({
        scripts: { dev: "vite", lint: "eslint .", typecheck: "tsc --noEmit", test: "vitest" },
      }),
    ).toEqual(["npm run lint", "npm run typecheck"]);
  });

  it("resolves nothing when the target declares no check (UNMEASURED, never a pass)", () => {
    // A target with no lint configured must not be reported as lint-clean: "could not run" is its own
    // outcome, the same distinction the coding loop already draws for a test command that would not start.
    expect(resolveLintCommands({ scripts: { dev: "vite", build: "vite build" } })).toEqual([]);
    expect(resolveLintCommands({})).toEqual([]);
    expect(resolveLintCommands(null)).toEqual([]);
    expect(resolveLintCommands("not a package.json")).toEqual([]);
  });

  it("ignores a script whose name merely contains a check word", () => {
    expect(resolveLintCommands({ scripts: { "lint-staged": "lint-staged", linter: "x" } })).toEqual([]);
  });
});
