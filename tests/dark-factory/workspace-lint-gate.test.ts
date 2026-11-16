/**
 * #659 - what the sandbox may run, and which lint commands a target contributes.
 *
 * Two problems sit here, and both are pinned rather than assumed:
 *
 *  1. The allow-list admits only TEST commands, so the lint command a target declares is refused - but
 *     the agent's list must NOT simply grow. #437's rule is that a consumer states its own command set
 *     rather than widening the Developer Agent's blast radius, and its guard fails the moment that
 *     constant is shared. So the lint step gets a set of its OWN, named per command, never by wildcard:
 *     `npm run <anything>` would make every package script runnable, including a postinstall.
 *  2. The matching rule in both consumers is `command.startsWith(prefix + " ")`, which under that rule
 *     also admits `npm run lint -- --fix`. A CHECK that writes is not a check: it would mutate the tree
 *     behind the coding loop's back, so a writing flag is refused explicitly.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_WORKSPACE_COMMAND_PREFIXES,
  isAllowedWorkspaceCommand,
  LINT_COMMAND_PREFIXES,
  resolveLintCommands,
  workspaceCommandsFor,
} from "../../agent/lib/dark-factory/developer-agent";

describe("#659 the workspace command allow-list", () => {
  it("still permits every command that was permitted before", () => {
    for (const command of ["npx vitest run", "npm test", "npx tsc --noEmit"]) {
      expect(isAllowedWorkspaceCommand(command)).toBe(true);
    }
  });

  it("permits the lint and typecheck commands a target declares, under the LINT set", () => {
    expect(isAllowedWorkspaceCommand("npm run lint", LINT_COMMAND_PREFIXES)).toBe(true);
    expect(isAllowedWorkspaceCommand("npm run typecheck", LINT_COMMAND_PREFIXES)).toBe(true);
  });

  it("does NOT widen the Developer Agent's own blast radius (#437)", () => {
    // The guard #437 left behind pins this exact list. A lint step that widened it instead of naming its
    // own commands would let the agent run `npm run <anything>`, i.e. a repository's package scripts.
    expect([...ALLOWED_WORKSPACE_COMMAND_PREFIXES]).toEqual(["npx vitest", "npm test", "npx tsc"]);
    expect(isAllowedWorkspaceCommand("npm run lint")).toBe(false);

    // What the lint step DOES get is the agent's set plus the target's own checks, per run.
    expect(workspaceCommandsFor(["npm run lint"])).toContain("npm run lint");
    expect(workspaceCommandsFor(["npm run lint"])).toContain("npx vitest");
  });

  it("refuses a package script that is not a check", () => {
    // The whole point of naming commands: this would otherwise be runnable by widening to `npm run`.
    expect(isAllowedWorkspaceCommand("npm run deploy")).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run postinstall")).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run lint:everything")).toBe(false);
  });

  it("refuses a check that would WRITE, because a check must not mutate the tree", () => {
    expect(isAllowedWorkspaceCommand("npm run lint -- --fix", LINT_COMMAND_PREFIXES)).toBe(false);
    expect(isAllowedWorkspaceCommand("npm run lint --fix", LINT_COMMAND_PREFIXES)).toBe(false);
    expect(isAllowedWorkspaceCommand("npx prettier --write .", LINT_COMMAND_PREFIXES)).toBe(false);
    // Refused under the agent's own set too, not just the lint one.
    expect(isAllowedWorkspaceCommand("npx vitest run --write")).toBe(false);
  });

  it("refuses anything that is not on the list at all", () => {
    expect(isAllowedWorkspaceCommand("rm -rf /")).toBe(false);
    expect(isAllowedWorkspaceCommand("curl http://example.com")).toBe(false);
  });

  it("keeps the lists free of wildcards", () => {
    expect(LINT_COMMAND_PREFIXES).toContain("npm run lint");
    for (const list of [ALLOWED_WORKSPACE_COMMAND_PREFIXES, LINT_COMMAND_PREFIXES]) {
      expect(list.some((p) => p.includes("*"))).toBe(false);
      // A bare `npm run` entry would admit every package script there is.
      expect(list).not.toContain("npm run");
    }
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
