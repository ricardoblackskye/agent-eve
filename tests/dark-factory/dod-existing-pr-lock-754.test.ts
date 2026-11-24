import { describe, expect, it } from "vitest";

import {
  runDefinitionOfDone,
  type DefinitionOfDoneDeps,
  type DefinitionOfDoneTask,
  type PrOpener,
} from "../../agent/lib/dark-factory/definition-of-done";

/**
 * #754 task 3 — a LOCK, not a RED.
 *
 * The fix landed in the writer, so nothing in the Definition of Done needed changing: its refusal
 * condition is `if (!prResult.ok || !prResult.pr)` (definition-of-done.ts:779), and a conflict now
 * returns `{ ok: true, pr }`. This pins the far end of that wire, because the operator saw the VERDICT
 * (`refused`), not the writer.
 *
 * The shape below is copied from the pipeline e2e s known-good DoD deps rather than invented, and it is
 * typed WITHOUT a cast on purpose. An earlier version of this file used a four-field stub behind
 * `as unknown as DefinitionOfDoneDeps` and asserted `not.toBe("refused")` - both cases then passed on
 * `blocked`, because the task carried no plan or test results and the DoD had no acceptance criteria to
 * verify. A cast hid the missing fields, and a negative assertion accepted the wrong outcome: the
 * control caught it, which is the only reason it was visible. Hence: exact status, no cast.
 */
// Mirrored from the pipeline e2e’s canonical ExecutionPlan fixture (dark-factory-pipeline-e2e.test.ts:132)
// rather than guessed field by field: storyId is a number, targetFiles carry an action and a rationale,
// and every criterion needs an id and a description for the DoD to verify it.
const PLAN = {
  storyId: 258,
  title: "Add the footer line to the home page",
  summary: "One italic line, on the home route only.",
  targetFiles: [
    {
      path: "src/pages/HomePage.jsx",
      action: "create" as const,
      rationale: "the footer line the story asks for",
    },
  ],
  acceptanceCriteriaMap: [
    {
      acId: "AC1",
      description: "the footer line renders in italics",
      testFile: "src/pages/HomePage.test.jsx",
      testCaseName: "renders the footer line in italics",
    },
  ],
};

const TASK: DefinitionOfDoneTask = {
  runId: "run-754",
  repo: "owner/repo",
  issue: 258,
  head: "feat/dark-factory-258",
  base: "main",
  title: "the existing pull request",
  body: "body",
  plan: PLAN,
  testResults: [
    {
      testFile: "src/pages/HomePage.test.jsx",
      testCaseName: "renders the footer line in italics",
      passed: true,
    },
  ],
};

const EXISTING_PR = {
  number: 259,
  url: "https://github.com/owner/repo/pull/259",
  head: "feat/dark-factory-258",
  base: "main",
  title: "the existing pull request",
  body: "body",
};

function depsWithCreator(
  createPullRequest: PrOpener["createPullRequest"],
): DefinitionOfDoneDeps {
  return {
    prWriter: { createPullRequest },
    commentWriter: { postComment: async () => ({ ok: true }) },
    runChecks: async () => [],
  };
}

describe("a re-run whose pull request already exists (#754 task 3)", () => {
  it("reaches done when the writer resolves to the existing pull request", async () => {
    const deps = depsWithCreator(async () => ({
      ok: true,
      status: 422,
      pr: EXISTING_PR,
    }));

    const result = await runDefinitionOfDone(deps, TASK);

    expect(result.status).toBe("done");
  });

  // The control: a genuine failure must still refuse, with the writer s reason carried through.
  it("still refuses when the writer genuinely fails", async () => {
    const deps = depsWithCreator(async () => ({
      ok: false,
      status: 500,
      error: "GitHub responded 500",
    }));

    const result = await runDefinitionOfDone(deps, TASK);

    expect(result.status).toBe("refused");
    expect(JSON.stringify(result)).toMatch(/GitHub responded 500/);
  });
});
