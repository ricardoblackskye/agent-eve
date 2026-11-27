import { describe, expect, it } from "vitest";
import { classifyFinding } from "../../agent/lib/dark-factory/finding-classification";

/**
 * #743 - the JOIN: the reason format the runner actually emits has to classify correctly.
 *
 * The wiring classifies `dodResult.reason`, and that string is built in `developer-agent.ts`. If those lines are ever
 * reworded, every finding degrades to `unknown` - honest under fail-closed, but a feature quietly switched off with a
 * green suite over it. So the format is pinned here rather than assumed.
 *
 * The strings below are the REAL formats, copied from the lines that emit them.
 */
const LINT_DID_NOT_RUN = [
  "     Lint result: DID NOT RUN (npm run lint)",
  "     Lint reason (tail):",
  "     Error: Cannot find package 'typescript-eslint' imported from /workspace/eslint.config.js",
  "     Checks: 1 of 2 checks ran, 1 did not run",
].join("\n");

const LINT_FAIL = ["     Lint result: FAIL (npm run lint)"].join("\n");
const LINT_PASS = ["     Lint result: PASS (npm run typecheck)"].join("\n");

describe("#743 - the runner's own reason format classifies", () => {
  it("a lint that could not run because its plugin is missing is the HARNESS", () => {
    // This is #755's evidence verbatim - the row that most misled a reader, because it looked exactly like broken code.
    const r = classifyFinding(LINT_DID_NOT_RUN);

    expect(r.cause).toBe("harness");
    expect(r.owner).toBe("factory");
    expect(r.evidence.length).toBeGreaterThan(0);
  });

  it("a lint that ran and failed is not reported as broken code on that line alone", () => {
    // `Lint result: FAIL` carries no reason, so the honest answer is `unknown`. Asserted as `not code` rather than as
    // `unknown`, because it records the thinness without freezing it as acceptable.
    expect(classifyFinding(LINT_FAIL).cause).not.toBe("code");
  });

  it("CONTROL: a passing lint is not a finding and gets no cause", () => {
    // A pass is not a failure. Putting a cause on work that did not fail is the opposite error to defaulting to code.
    expect(classifyFinding(LINT_PASS).cause).toBe("unknown");
  });

  it("the evidence it quotes is a substring of the reason the runner produced", () => {
    const r = classifyFinding(LINT_DID_NOT_RUN);

    expect(LINT_DID_NOT_RUN.includes(r.evidence)).toBe(true);
  });
});
