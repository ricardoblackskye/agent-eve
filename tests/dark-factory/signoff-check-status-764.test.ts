import { describe, expect, it } from "vitest";
import { renderSignOffComment } from "../../agent/lib/dark-factory/dod-presentation";

/**
 * #764's second finding - the sign-off comment must state the check status it ACTUALLY observed, or say nothing
 * about it.
 *
 * Measured on a real run: the comment said "The pull request checks have not reported yet." while the verdict in the
 * same run was `done` and all six checks had already completed green. The operator surface misstated the very state
 * it exists to report, and a reader deciding whether to sign off was told the checks were still silent when they were
 * finished and passing.
 *
 * The presentation layer is not at fault for reading the checks wrongly - it renders exactly what it is given
 * (passing/pending/failing, naming a failing check). The wording fires only in the FALLBACK, when the caller supplied
 * no status at all (`scripts/dark-factory-runner.ts:1941`). So the fallback is the defect: it asserts a specific
 * state - "have not reported" - from the absence of an input, which is the same false-certification shape as the
 * issue itself, a layer down.
 */
const PR = { prNumber: 42, prUrl: "https://github.com/owner/repo/pull/42" };

describe("#764 - the sign-off comment does not assert a check status it was not given", () => {
  it("does not claim the checks have not reported when it has no status to report", () => {
    const body = renderSignOffComment({ ...PR });

    // Absence of an input is not evidence that the checks are silent. Saying nothing is permitted; saying this is not.
    expect(body).not.toContain("have not reported yet");
  });

  it("CONTROL: a supplied status is still stated, so the fix is not a silent removal", () => {
    const body = renderSignOffComment({ ...PR, checks: { passing: 6, failing: 0, pending: 0 } });

    // This is the behaviour the fallback must not swallow: when the status IS known, the reader gets it.
    expect(body).toContain("6 passing");
  });

  it("CONTROL: a failing check is still named", () => {
    const body = renderSignOffComment({
      ...PR,
      checks: { passing: 5, failing: 1, pending: 0, failingNames: ["MegaLinter"] },
    });

    expect(body).toContain("1 failing");
    expect(body).toContain("MegaLinter");
  });
});
