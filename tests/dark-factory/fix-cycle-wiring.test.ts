/**
 * #718 - the runner must SUPPLY the fix cycle, at every DoD composition.
 *
 * The runner is an out-of-band script that makes real GitHub and sandbox calls, so this guards the
 * WIRING at the source level; the disposition rules themselves are covered by fix-cycle.test.ts.
 *
 * It is deliberately not loose. #718 exists because `attemptFixes` was declared, documented, covered
 * by nine test cases - and never passed in by the composition root, so the DoD skipped its whole
 * fix/disposition path on every production run. Nothing warned. A guard that only asserted
 * "attemptFixes appears somewhere in the runner" would have passed for the whole of that time.
 *
 * So it asserts the property that was actually missing: EVERY call to the DoD phase carries it.
 * There are two compositions - STEP 7 and the verify-only re-entry #703 added - and the re-entry is
 * the one most likely to be forgotten, because it is newer and does no coding of its own.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const source = readFileSync(
  resolve(process.cwd(), "scripts/dark-factory-runner.ts"),
  "utf8",
);

/**
 * The argument list of every call to `callee`, by balanced parentheses.
 *
 * Scanning to a closing paren rather than to a fixed character count keeps the guard honest if the
 * deps literal grows. If it ever mis-scans, it reports the wrong NUMBER of call sites and fails
 * loudly - the safe direction for a guard to break.
 */
function callArgs(text: string, callee: string): string[] {
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(`${callee}(`, from);
    if (at === -1) return found;
    let depth = 0;
    let i = at + callee.length;
    const start = i;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // The DEFINITION is not a composition. `runDefinitionOfDonePhase(` matches inside
    // `export async function runDefinitionOfDonePhase(`, which made this helper report three sites
    // for two calls - and failing loudly on a wrong count, rather than quietly on the right one, is
    // exactly what this guard is for.
    const preceding = text.slice(Math.max(0, at - 32), at);
    if (/function\s+$/.test(preceding)) {
      from = i + 1;
      continue;
    }
    found.push(text.slice(start, i + 1));
    from = i + 1;
  }
}

/** The body of a top-level function declaration, by balanced braces. */
function functionBody(text: string, name: string): string {
  const at = text.indexOf(`function ${name}(`);
  if (at === -1) return "";
  const open = text.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
}

describe("#718 the runner supplies the DoD fix cycle", () => {
  it("imports createFixCycle from the fix-cycle module", () => {
    expect(source).toMatch(
      /import\s*\{[^}]*createFixCycle[^}]*\}\s*from\s*"[^"]*fix-cycle"/,
    );
  });

  it("still composes the DoD phase exactly twice, so a new site cannot be forgotten silently", () => {
    // STEP 7, and the verify-only re-entry added by #703. A third site must be a deliberate change
    // to this number - which is the point: adding one and forgetting attemptFixes is the #718 defect.
    expect(callArgs(source, "runDefinitionOfDonePhase")).toHaveLength(2);
  });

  it("supplies attemptFixes at EVERY DoD composition, the re-entry included", () => {
    // It was STEP 7 only, and that was the wrong trade: the case that matters most - a red check
    // discovered AFTER a wait - arrives on the verify-only re-entry, which was the one path with no
    // fix cycle. The run then recorded why the pull request failed and did nothing about it.
    //
    // The re-entry could not reach the adapter's dependencies before. The workspace, remote, author
    // and sandbox config are now resolved above it, so ONE adapter serves both compositions.
    const sites = callArgs(source, "runDefinitionOfDonePhase");
    expect(sites).toHaveLength(2);
    for (const [index, args] of sites.entries()) {
      expect(
        args.includes("attemptFixes"),
        `runDefinitionOfDonePhase call #${index + 1} does not supply attemptFixes`,
      ).toBe(true);
    }
  });

  it("builds the adapter from createFixCycle, wiring all four ports", () => {
    // The ports are the contract the module relies on. A composition that passed an object shaped
    // like the adapter without these ports would compile and then quietly dispose nothing - which is
    // the failure this whole issue is about, one level down.
    const adapter = functionBody(source, "buildFixCycleAdapter");
    expect(adapter, "the runner must define buildFixCycleAdapter").not.toBe("");
    expect(adapter).toContain("createFixCycle");
    for (const port of ["openWorkspace", "author", "push", "closeWorkspace"]) {
      expect(adapter, `the adapter does not wire ${port}`).toContain(port);
    }
  });
});
