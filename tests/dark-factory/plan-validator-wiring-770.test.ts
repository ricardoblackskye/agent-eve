/**
 * #770 - the existence rule must actually RECEIVE the repository's file list on the runner path.
 *
 * Rule 1b in `plan-validator.ts` is guarded by `if (Array.isArray(context?.files))`. Both runner call sites passed
 * no context at all, so `context.files` was `undefined` and the rule NEVER executed - neither the `create` half
 * nor the `modify`/`replace` half that already worked. Which is why `-> Domain Validation Passed!`, printed on
 * every run, asserted nothing about whether the plan's target files exist.
 *
 * BOUNDED on purpose: an unbounded `toContain` over a 2,800-line file has passed in this repository while the
 * wiring was absent, so each call site is sliced individually and the guard is paired with a case proving the
 * slices really are the calls.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(resolve(process.cwd(), "scripts/dark-factory-runner.ts"), "utf8");

/** Each `validateExecutionPlan(...)` call, sliced from its name to the statement's terminating semicolon. */
function validationCallSlices(source: string): string[] {
  const marker = "validateExecutionPlan(";
  const out: string[] = [];
  let from = source.indexOf(marker);
  while (from !== -1) {
    const end = source.indexOf(";", from);
    out.push(source.slice(from, end === -1 ? from + 400 : end));
    from = source.indexOf(marker, from + marker.length);
  }
  return out;
}

/**
 * The real call sites: the ones that pass the issue body. Mentions in comments or prose are not calls, and
 * filtering here rather than failing on them keeps the guard about the wiring instead of about documentation.
 */
const CALLS = validationCallSlices(SOURCE).filter((call) => call.includes("issueData.body"));

describe("#770 the runner hands the validator the repository's file list", () => {
  it("finds every real call site, so the guard cannot pass by finding none", () => {
    // Two are expected: the amended-plan path and the main STEP 4 validation. Wiring one and missing the other
    // is the recurring shape in this file, which is exactly what this case is here to catch.
    expect(CALLS.length).toBeGreaterThanOrEqual(2);
  });

  it("EVERY call site supplies the file list", () => {
    const withoutList = CALLS.filter((call) => !call.includes("files:"));

    // The offending call is included in the failure so it can be found without opening the file.
    expect(withoutList).toEqual([]);
  });
});
