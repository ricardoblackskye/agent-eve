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
      head: "feat/dark-factory-212",
      base: "main",
      title: "feat: #212 Test for DF issue 659",
      body: "Closes #212",
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
      result({ ok: false, status: "refused", pr: undefined, reason: "the developer loop gave up" }),
    );

    expect(body).toMatch(/not done/i);
    expect(body).toContain("refused");
    expect(body).not.toContain("pull/");
  });
});

/**
 * #673 - the blocked comment must carry the run's acceptance traceability.
 *
 * The success comment embeds `traceabilityTable`; the not-done comment named the status, the reason,
 * the PR and the outstanding findings, and showed no traceability at all. That is the comment a
 * reader opens to understand why a run did not certify, so it said what failed while never saying
 * what the ticket asked for - the same class as #502's "an omission must not read as a clean result".
 */
describe("#673 the blocked comment carries the acceptance traceability", () => {
  const TABLE =
    "| AC | Test | Case |\n| --- | --- | --- |\n| AC1 | tests/x.test.ts | passes |";

  it("renders the traceability table on a blocked run", () => {
    const body = dodOutcomeComment(
      673,
      result({
        ok: false,
        status: "blocked",
        reason: "Review budget exhausted (3 rounds) with 1 unresolved finding(s).",
        remainingFindings: [
          { id: "WARN-1", source: "linter", message: "Warning one", severity: "warning" },
        ],
        acMatrix: [
          {
            acId: "AC1",
            description: "the credit line renders",
            testFile: "tests/x.test.ts",
            testCaseName: "passes",
            passed: true,
          },
        ],
        traceabilityTable: TABLE,
      }),
    );

    // CONTROL: it must still be the not-done comment, naming the reason and the finding. Without
    // this, the case would pass if the comment started claiming success - #659's defect.
    expect(body).toContain("is NOT done");
    expect(body).toContain("Review budget exhausted");
    expect(body).toContain("WARN-1");

    // THE FIX: the traceability the run computed is rendered.
    expect(body).toContain("Acceptance criteria");
    expect(body).toContain("AC1");
  });

  it("omits the section when the run had nothing to trace", () => {
    // An unmapped plan has no matrix at all (#502's missingMap). An empty heading would be the
    // same kind of lie as reporting an empty matrix for a plan that did map.
    const body = dodOutcomeComment(
      673,
      result({ ok: false, status: "blocked", acMatrix: undefined, traceabilityTable: undefined }),
    );

    expect(body).toContain("is NOT done");
    expect(body).not.toContain("Acceptance criteria");
  });

  it("says the checks have not finished, names them, and says how to continue (#691)", () => {
    const body = dodOutcomeComment(
      232,
      result({
        ok: false,
        status: "blocked",
        reason: "Review budget exhausted (3 rounds) with 1 unresolved finding(s).",
        blockedReason: "checks-not-finished",
        pendingChecks: ["e2e"],
        remainingFindings: [
          {
            id: "PR-CHECK-UNSETTLED:e2e",
            source: "linter",
            severity: "error",
            message: "The pull request check 'e2e' has not finished (in_progress).",
          },
        ],
      }),
    );

    // Assert ONLY what the new section provides: the finding's own message already contains
    // "not finished" and "e2e", so those would pass without the change at all.
    expect(body).toContain("**Checks not finished**");
    expect(body).toMatch(/had not finished when the wait reached its bound/);
    expect(body).toContain("e2e");
    // the documented re-trigger (decision 3), not an implied scheduler
    expect(body).toMatch(/re-apply the `dark-factory` label/);
  });

  it("CONTROL: does NOT claim checks are unfinished when a check FAILED (#691)", () => {
    const body = dodOutcomeComment(
      232,
      result({
        ok: false,
        status: "blocked",
        reason: "Review budget exhausted (3 rounds) with 1 unresolved finding(s).",
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

    expect(body).not.toContain("**Checks not finished**");
  });
});
