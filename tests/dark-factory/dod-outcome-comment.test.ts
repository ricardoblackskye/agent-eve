/**
 * #659 - the ticket must never say done when the run refused.
 *
 * The runner posted its completion comment behind `if (dodResult.pr)`, so a BLOCKED Definition of Done -
 * which still leaves its pull request behind - announced
 *
 *     Story #212 Completed with Verified Traceability ✅
 *     - **Lifecycle**: `df:done`
 *
 * on a run whose own verdict was `DoD Status: blocked` / `Is DONE (ok): false`. The label was correctly
 * withheld, so the ticket carried no `df:done` label while the comment claimed one: the one place a human
 * actually reads contradicted the run.
 *
 * These cases pin the comment to the VERDICT. They RED against the current code, which has no such
 * function and gates on the PR alone.
 */
import { describe, expect, it } from "vitest";
import { dodOutcomeComment } from "../../scripts/dark-factory-runner";
import type { DefinitionOfDoneResult } from "../../agent/lib/dark-factory/definition-of-done";

function result(over: Partial<DefinitionOfDoneResult> = {}): DefinitionOfDoneResult {
  return {
    ok: true,
    status: "done",
    pr: {
      number: 213,
      url: "https://github.com/ricardoblackskye/WebFeedPOC/pull/213",
    },
    roundsExecuted: 1,
    totalFindings: 0,
    resolvedCount: 0,
    acceptedCount: 0,
    remainingFindings: [],
    reason: "all checks passed",
    ...over,
  };
}

describe("#659 the ticket comment follows the DoD verdict", () => {
  it("announces completion ONLY when the run is actually done", () => {
    const body = dodOutcomeComment(212, result({ ok: true, status: "done" }));

    expect(body).toMatch(/Completed with Verified Traceability/);
    expect(body).toMatch(/df:done/);
    expect(body).toContain("pull/213");
  });

  it("does NOT claim done when the DoD blocked, even though a PR exists", () => {
    const body = dodOutcomeComment(
      212,
      result({
        ok: false,
        status: "blocked",
        reason: "the review round budget was exhausted",
        remainingFindings: [
          {
            id: "PR-CHECK-FAILED:MegaLinter",
            source: "linter",
            severity: "error",
            message: "The repository's own check 'MegaLinter' failed (failure).",
          },
        ],
      }),
    );

    expect(body).not.toMatch(/Completed with Verified Traceability/);
    expect(body).not.toMatch(/✅/);
    // The claim itself must be absent, not merely softened: `df:done` is what the ledger and a human read.
    expect(body).not.toMatch(/`df:done`/);
    // It must SAY it is not done, name the status, and point at the open PR without inviting a merge.
    expect(body).toMatch(/not done/i);
    expect(body).toContain("blocked");
    expect(body).toContain("pull/213");
    expect(body).toMatch(/do not merge|not been verified|left open/i);
    // And carry the findings that stopped it, so the ticket is actionable.
    expect(body).toContain("MegaLinter");
  });

  it("still reports not-done when there is no PR at all", () => {
    const body = dodOutcomeComment(
      212,
      result({ ok: false, status: "failed", pr: undefined, reason: "the developer loop gave up" }),
    );

    expect(body).toMatch(/not done/i);
    expect(body).toContain("failed");
    expect(body).not.toContain("pull/");
  });
});
