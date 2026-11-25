/**
 * #759 task 7 - THE WIRING. This is the gap the live e2e found.
 *
 * Tasks 1-6 built pieces that all pass their own tests - a selector, a comment renderer, a vocabulary,
 * a guard - and a live run proved what no unit test could: NOTHING CALLED THEM. WebFeedPOC#262 delivered a
 * pull request and the issue showed no `awaiting-signoff`, because the only reference to that label
 * outside its own module was the refusal CHECK, never an application.
 *
 * That is the failure mode the skill names as "two tested ends do not test the WIRE between them". These
 * cases assert the JOIN, and both are RED against the current code.
 *
 * The fixture copies `dod-outcome-comment.test.ts`. The first version of this file invented a thin one and
 * its CONTROL failed by throwing on missing fields - a broken harness, which would have made a green first
 * assertion prove nothing.
 */
import { describe, expect, it, vi } from "vitest";

import { applyTerminalLifecycle } from "../../agent/lib/dark-factory/run-finalizer";
import { dodOutcomeComment } from "../../scripts/dark-factory-runner";
import { TRIGGER_LABELS } from "../../agent/lib/dark-factory/trigger";
import type { LabelWriter } from "../../agent/lib/dark-factory/definition-of-done";
import type { DefinitionOfDoneResult } from "../../agent/lib/dark-factory/definition-of-done";

const REPO = "ricardoblackskye/WebFeedPOC";

/** Copied from the existing dod-outcome-comment test, so every required field is present. */
function result(over: Partial<DefinitionOfDoneResult> = {}): DefinitionOfDoneResult {
  return {
    ok: true,
    status: "done",
    pr: {
      number: 261,
      url: "https://github.com/ricardoblackskye/WebFeedPOC/pull/261",
      head: "feat/dark-factory-262",
      base: "main",
      title: "feat: #262 Test issue for the Dark Factory issue #759",
      body: "Closes #262",
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

function labels() {
  const added: string[] = [];
  const writer: LabelWriter = {
    add: vi.fn(async (_repo, _issue, label: string) => {
      added.push(label);
      return { ok: true };
    }),
    remove: vi.fn(async () => ({ ok: true })),
  };
  return { writer, added };
}

function runHistory() {
  return {
    listRunEvents: vi.fn(async () => ({ ok: true, value: { items: [] } })),
    recordRunSummary: vi.fn(async () => ({ ok: true })),
    appendEvent: vi.fn(async () => ({ ok: true })),
    retireRunClaim: vi.fn(async () => ({ ok: true })),
  } as never;
}

async function finalise(dodResult: DefinitionOfDoneResult) {
  const l = labels();
  await applyTerminalLifecycle(
    { labelWriter: l.writer, runHistory: runHistory() },
    {
      repo: REPO,
      issue: 262,
      runId: "run-759-wire",
      terminalStatus: dodResult.ok ? "succeeded" : "failed",
      dodResult,
    } as never,
  );
  return l.added;
}

describe("the sign-off state is APPLIED, not merely defined (#759 task 7)", () => {
  it("adds awaiting-signoff beside df:done when delivered with a pull request", async () => {
    const added = await finalise(result());

    expect(added).toContain(TRIGGER_LABELS.done);
    expect(added).toContain(TRIGGER_LABELS.signoff);
  });

  // Controls: only a DELIVERED result with something to sign off earns the human label.
  it("does not add it when the DoD did not pass", async () => {
    const added = await finalise(result({ ok: false, status: "blocked" }));
    expect(added).not.toContain(TRIGGER_LABELS.signoff);
  });

  it("does not add it when there is no pull request to sign off", async () => {
    const added = await finalise(result({ pr: undefined }));
    expect(added).not.toContain(TRIGGER_LABELS.signoff);
  });
});

describe("the terminal comment asks for the decision (#759 task 7)", () => {
  it("names the pull request and the two words, on a delivered run", () => {
    const body = dodOutcomeComment(262, result());

    expect(body).toContain("#261");
    expect(body).toMatch(/Approved/);
    expect(body).toMatch(/Rejected/);
  });

  // The control: a run that did not deliver must not be asked to be signed off.
  it("does not ask for a decision when the run did not deliver", () => {
    const body = dodOutcomeComment(262, result({ ok: false, status: "blocked" }));
    expect(body).not.toMatch(/Reply \*\*Approved\*\*/);
  });
});
