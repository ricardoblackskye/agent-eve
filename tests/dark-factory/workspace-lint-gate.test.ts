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
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_WORKSPACE_COMMAND_PREFIXES,
  checkOutcomeLines,
  checkSetSummary,
  isAllowedWorkspaceCommand,
  LINT_COMMAND_PREFIXES,
  resolveE2eCommand,
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

/**
 * #674 - the loop's log must name every declared check and its outcome.
 *
 * The loop iterates the target's declared checks and prints one line per command, but its
 * `if (!lint.ran) continue` printed NOTHING and discarded the output that held the reason. #230's
 * loop log consequently showed one lint line for two declared checks, and the parenthesised name
 * was the LAST command - so the log could not tell anyone that `npm run lint` was attempted and
 * never started. An unmeasured check is not a verdict in either direction, and it is not silence
 * either: it is a result the log must report.
 */
describe("#674 the loop's log names every declared check", () => {
  const check = (
    over: Partial<{ passed: boolean; output: string; ran: boolean }> = {},
  ): { passed: boolean; output: string; ran: boolean } => ({
    passed: true,
    output: "",
    ran: true,
    ...over,
  });

  it("names the command for a check that ran and passed", () => {
    const lines = checkOutcomeLines("npm run typecheck", check());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("npm run typecheck");
    expect(lines[0]).toContain("PASS");
  });

  it("names the command and carries a tail for a check that ran and failed", () => {
    const lines = checkOutcomeLines(
      "npm run lint",
      check({ passed: false, output: "src/a.ts:1 error no-unused-vars" }),
    );
    const joined = lines.join("\n");
    expect(lines[0]).toContain("npm run lint");
    expect(lines[0]).toContain("FAIL");
    expect(joined).toContain("no-unused-vars");
  });

  it("REPORTS a check that did not run, with the reason it could not start", () => {
    // THE DEFECT: this case printed nothing at all, which is why one line appeared for two checks.
    const lines = checkOutcomeLines(
      "npm run lint",
      check({ ran: false, passed: false, output: "npm error Failed to load config" }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("npm run lint");
    expect(joined).toMatch(/did not run/i);
    expect(joined).toContain("Failed to load config");
    // an unmeasured check is not a pass, so it must not be reported as one
    expect(joined).not.toContain("PASS");
  });

  it("still reports a check that did not run when it left no output", () => {
    const lines = checkOutcomeLines(
      "npm run lint",
      check({ ran: false, passed: false, output: "" }),
    );
    const joined = lines.join("\n");
    expect(joined).toContain("npm run lint");
    expect(joined).toMatch(/did not run/i);
  });

  it("summarises the set, so a check missing from the log is visible as a count", () => {
    const summary = checkSetSummary([check(), check(), check({ ran: false, passed: false })]);
    expect(summary).toContain("2");
    expect(summary).toContain("3");
    expect(summary).toMatch(/did not run/i);
  });

  it("the loop cannot silently skip a check that did not run (GUARD)", () => {
    // The formatter can be perfect and still be bypassed by the one-liner that caused #674, so the
    // call site is asserted too - the same reasoning as #672's wiring guard.
    const src = readFileSync(
      new URL("../../scripts/dark-factory-runner.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toMatch(/if \(!lint\.ran\)\s*continue;/);
    expect(src).toMatch(/checkOutcomeLines\(/);
  });
});

/**
 * #701 - the target's own e2e script, resolved the way its lint commands already are.
 *
 * The coding loop verifies with the target's UNIT tests and then reports PASS, which is read as "this
 * work is verified" while the e2e suite is never run. Resolving the command is the first step: nothing
 * downstream can say whether an e2e was expected without knowing what it would have been.
 *
 * Same stance as `resolveLintCommands`: an absent or unreadable package.json resolves to NOTHING, and
 * "this target declares no e2e" must never be reported as "the e2e passed".
 */
describe("#701 resolveE2eCommand", () => {
  it("resolves the target's e2e script", () => {
    expect(resolveE2eCommand({ scripts: { e2e: "playwright test" } })).toEqual([
      "npm run e2e",
    ]);
  });

  it("resolves test:e2e, which is what WebFeedPOC actually declares", () => {
    // Measured in the sandbox image: WebFeedPOC's package.json has "test:e2e" and no "e2e" at all,
    // so a resolver that only looked for "e2e" would conclude this target has no e2e suite.
    expect(
      resolveE2eCommand({ scripts: { "test:e2e": "playwright test --config playwright.config.cjs" } }),
    ).toEqual(["npm run test:e2e"]);
  });

  it("prefers e2e when a target declares both, rather than running two suites", () => {
    expect(
      resolveE2eCommand({ scripts: { e2e: "playwright test", "test:e2e": "playwright test" } }),
    ).toEqual(["npm run e2e"]);
  });

  it("resolves to nothing when the target declares no e2e, whatever its shape", () => {
    expect(resolveE2eCommand({ scripts: { dev: "vite", build: "vite build" } })).toEqual([]);
    expect(resolveE2eCommand({})).toEqual([]);
    expect(resolveE2eCommand(null)).toEqual([]);
    expect(resolveE2eCommand("not a package.json")).toEqual([]);
    expect(resolveE2eCommand(undefined)).toEqual([]);
  });

  it("ignores a non-string script instead of running it", () => {
    expect(resolveE2eCommand({ scripts: { e2e: 123 } })).toEqual([]);
    expect(resolveE2eCommand({ scripts: { "test:e2e": { command: "playwright" } } })).toEqual([]);
  });

  it("produces a command the workspace allow-list accepts", () => {
    // The gate is useless if the command it resolves is refused when the loop tries to run it.
    const [command] = resolveE2eCommand({ scripts: { "test:e2e": "playwright test" } });
    expect(command).toBeDefined();
    expect(isAllowedWorkspaceCommand(command, [command])).toBe(true);
  });
});
